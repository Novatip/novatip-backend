/**
 * __tests__/creator/seed-splits.test.ts
 *
 * Verifies that prisma/seed.ts validates DEMO_SPLITS against
 * CreatorSplitsSchema before writing via Prisma (#363).
 */

import { jest } from "@jest/globals";
import { CreatorSplitsSchema } from "../../modules/creator/creator-splits.schema.js";

const upsertMock = jest.fn(async () => ({
  slug: "demo",
  jarId: "@demo",
}));
const disconnectMock = jest.fn(async () => undefined);

jest.unstable_mockModule("@prisma/client", () => ({
  PrismaClient: jest.fn(() => ({
    creator: { upsert: upsertMock },
    $disconnect: disconnectMock,
  })),
}));

describe("prisma/seed.ts DEMO_SPLITS validation (#363)", () => {
  it("validates DEMO_SPLITS and upserts the demo creator", async () => {
    await import("../../../prisma/seed.js");
    // Allow main() promise microtasks to settle
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(upsertMock).toHaveBeenCalledTimes(1);
    const call = upsertMock.mock.calls[0]?.[0] as {
      create: { splits: unknown };
      update: { splits: unknown };
    };
    expect(() => CreatorSplitsSchema.parse(call.create.splits)).not.toThrow();
    expect(() => CreatorSplitsSchema.parse(call.update.splits)).not.toThrow();
  });

  it("rejects duplicate recipients and basis points over 10000", () => {
    const recipient = "GD7UXR3IX276M2M4XUE3TPNKTA7PJTERTEDEGWELQQYQBBHDL2NTREFR";

    expect(() =>
      CreatorSplitsSchema.parse([
        { to: recipient, bps: 5000 },
        { to: recipient, bps: 5000 },
      ]),
    ).toThrow(/Each recipient may appear only once/);

    expect(() =>
      CreatorSplitsSchema.parse([
        { to: recipient, bps: 7000 },
        {
          to: "GDE6TLQE77OGAPXORP5G5YLRG4FQE2D7ZCD237LVLTAALXAOVV3YTPDS",
          bps: 4000,
        },
      ]),
    ).toThrow(/must not exceed 10000/);
  });
});
