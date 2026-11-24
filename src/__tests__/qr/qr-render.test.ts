/**
 * __tests__/qr/qr-render.test.ts
 *
 * Verifies with the real qrcode renderer (no qrcode mock) that:
 * - GET /qr/:slug/png at PNG_QR_WIDTH_MIN renders a valid PNG with >= 4 px/module
 *   for both a short slug and a max-length (32-char) slug.
 * - Every QR module and the 4-module quiet zone in the rendered PNG matches
 *   the expected QRCode matrix (confirming no module collapse/aliasing).
 */

import { inflateSync } from "node:zlib";
import Fastify from "fastify";
import QRCode from "qrcode";
import { jest } from "@jest/globals";

process.env["DATABASE_URL"] ??= "postgresql://localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-not-used-for-signing";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;
process.env["APP_BASE_URL"] ??= "https://novatip.app";

const getCreatorBySlugMock = jest.fn(async (slug: string) => ({ slug }));

jest.unstable_mockModule("../../modules/creator/creator.service.js", () => ({
  getCreatorBySlug: getCreatorBySlugMock,
}));

const { qrRoutes, PNG_QR_WIDTH_MIN, QR_QUIET_ZONE_MODULES } = await import(
  "../../modules/qr/qr.routes.js"
);

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

interface DecodedPng {
  width: number;
  height: number;
  brightnessAt: (x: number, y: number) => number;
}

function decodePng(buffer: Buffer): DecodedPng {
  expect(buffer.subarray(0, 8)).toEqual(PNG_SIGNATURE);

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let palette: Buffer = Buffer.alloc(0);
  const idatChunks: Buffer[] = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
    } else if (type === "PLTE") {
      palette = data;
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  expect(bitDepth).toBe(8);
  const bppMap: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const bpp = bppMap[colorType];
  expect(bpp).toBeDefined();

  const inflated = inflateSync(Buffer.concat(idatChunks));
  const stride = width * (bpp as number);
  const pixels = Buffer.alloc(height * stride);

  for (let y = 0; y < height; y++) {
    const filterType = inflated[y * (stride + 1)]!;
    const scanlineStart = y * (stride + 1) + 1;
    const rowOffset = y * stride;
    const prevRowOffset = (y - 1) * stride;

    for (let i = 0; i < stride; i++) {
      const raw = inflated[scanlineStart + i]!;
      const left = i >= (bpp as number) ? pixels[rowOffset + i - (bpp as number)]! : 0;
      const up = y > 0 ? pixels[prevRowOffset + i]! : 0;
      const upLeft =
        y > 0 && i >= (bpp as number)
          ? pixels[prevRowOffset + i - (bpp as number)]!
          : 0;

      let val: number;
      switch (filterType) {
        case 0:
          val = raw;
          break;
        case 1:
          val = (raw + left) & 0xff;
          break;
        case 2:
          val = (raw + up) & 0xff;
          break;
        case 3:
          val = (raw + ((left + up) >> 1)) & 0xff;
          break;
        case 4:
          val = (raw + paethPredictor(left, up, upLeft)) & 0xff;
          break;
        default:
          throw new Error(`Unsupported PNG filter type: ${filterType}`);
      }
      pixels[rowOffset + i] = val;
    }
  }

  return {
    width,
    height,
    brightnessAt: (x: number, y: number): number => {
      const idx = (y * width + x) * (bpp as number);
      if (colorType === 0 || colorType === 4) {
        return pixels[idx]!;
      }
      if (colorType === 3) {
        const pIdx = pixels[idx]! * 3;
        return (palette[pIdx]! + palette[pIdx + 1]! + palette[pIdx + 2]!) / 3;
      }
      return (pixels[idx]! + pixels[idx + 1]! + pixels[idx + 2]!) / 3;
    },
  };
}

describe("QR PNG rendering at minimum width (#362)", () => {
  const app = Fastify();

  beforeAll(async () => {
    await app.register(qrRoutes, { prefix: "/qr" });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    ["short slug", "ali"],
    ["max-length 32-char slug", "a".repeat(32)],
  ])(
    "renders a scannable PNG with >= 4 px/module and 4-module quiet zone for %s",
    async (_label, slug) => {
      const response = await app.inject({
        method: "GET",
        url: `/qr/${slug}/png?width=${PNG_QR_WIDTH_MIN}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("image/png");

      const png = decodePng(response.rawPayload);
      expect(png.width).toBe(PNG_QR_WIDTH_MIN);
      expect(png.height).toBe(PNG_QR_WIDTH_MIN);

      const tipUrl = `${process.env["APP_BASE_URL"]}/${slug}`;
      const qr = QRCode.create(tipUrl, {});
      const moduleCount = qr.modules.size;
      const totalModules = moduleCount + 2 * QR_QUIET_ZONE_MODULES;
      const pxPerModule = png.width / totalModules;

      expect(pxPerModule).toBeGreaterThanOrEqual(4);

      // Verify every cell in the full grid (quiet zone + QR modules) matches
      for (let r = 0; r < totalModules; r++) {
        for (let c = 0; c < totalModules; c++) {
          const px = Math.floor((c + 0.5) * pxPerModule);
          const py = Math.floor((r + 0.5) * pxPerModule);
          const brightness = png.brightnessAt(px, py);

          const qrRow = r - QR_QUIET_ZONE_MODULES;
          const qrCol = c - QR_QUIET_ZONE_MODULES;
          const inCode =
            qrRow >= 0 &&
            qrRow < moduleCount &&
            qrCol >= 0 &&
            qrCol < moduleCount;
          const isDark = inCode ? Boolean(qr.modules.get(qrRow, qrCol)) : false;

          if (isDark) {
            expect(brightness).toBeLessThan(128);
          } else {
            expect(brightness).toBeGreaterThanOrEqual(128);
          }
        }
      }
    },
  );
});
