process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

import Fastify from "fastify";
import { Prisma } from "@prisma/client";
import { openApiSpecification } from "../openapi.js";
import { openApiRoutes } from "../modules/openapi/openapi.routes.js";
import { VerifyBody } from "../modules/auth/auth.routes.js";

describe("OpenAPI route", () => {
  it("serves the documented API specification as JSON", async () => {
    const app = Fastify();
    await app.register(openApiRoutes, { prefix: "/api/v1" });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/openapi.json",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual(openApiSpecification);
    expect(Object.keys(openApiSpecification.paths)).toEqual(
      expect.arrayContaining([
        "/health",
        "/health/live",
        "/health/ready",
        "/health/indexer",
        "/health/version",
        "/auth/challenge",
        "/auth/verify",
        "/auth/me",
        "/creators/{slug}",
        "/creators/check/{slug}",
        "/creators/claim",
        "/creators/me",
        "/creators/me/splits",
        "/creators/me/slug",
        "/creators/tips/{tipId}/message",
        "/resolve/{slug}",
        "/qr/{slug}",
        "/qr/{slug}/png",
        "/analytics/totals",
        "/analytics/timeseries",
        "/analytics/top-supporters",
        "/analytics/recent",
        "/analytics/collaborators",
        "/analytics/export",
        "/public/{slug}/recent",
        "/notifications",
        "/notifications/preferences",
        "/webhooks",
        "/webhooks/{id}",
        "/webhooks/{id}/deliveries",
        "/webhooks/{id}/ping",
        "/webhooks/{id}/secret",
        "/openapi.json",
      ]),
    );

    await app.close();
  });

  it("describes bearer authentication for protected routes", () => {
    expect(
      openApiSpecification.paths["/analytics/totals"]?.get?.security,
    ).toEqual([{ bearerAuth: [] }]);
    expect(
      openApiSpecification.paths["/creators/me"]?.delete?.security,
    ).toEqual([{ bearerAuth: [] }]);
    expect(
      Object.entries(
        openApiSpecification.paths["/creators/me"]?.delete?.responses ?? {},
      ).find(([status]) => status === "204")?.[1],
    ).toMatchObject({
      description: "Creator account deleted.",
    });
    expect(
      openApiSpecification.paths["/public/{slug}/recent"]?.get?.security,
    ).toBeUndefined();
  });

  it("documents the PNG QR width bounds and default", () => {
    const widthParameter = openApiSpecification.paths[
      "/qr/{slug}/png"
    ]?.get?.parameters?.find(
      (parameter) => "name" in parameter && parameter.name === "width",
    );

    expect(widthParameter).toMatchObject({
      name: "width",
      in: "query",
      schema: {
        type: "integer",
        minimum: 64,
        maximum: 2048,
        default: 512,
      },
    });
    expect(
      Object.keys(
        openApiSpecification.paths["/qr/{slug}/png"]?.get?.responses ?? {},
      ),
    ).toContain("400");
  });

  it("documents the shared slug format and malformed-slug response", () => {
    const slugPaths = [
      "/creators/{slug}",
      "/resolve/{slug}",
      "/qr/{slug}",
      "/qr/{slug}/png",
      "/public/{slug}/recent",
    ] as const;

    for (const path of slugPaths) {
      const operation = openApiSpecification.paths[path]?.get;
      const slugParameter = operation?.parameters?.find(
        (parameter) => "name" in parameter && parameter.name === "slug",
      );

      expect(slugParameter).toMatchObject({
        name: "slug",
        in: "path",
        schema: {
          type: "string",
          minLength: 3,
          maxLength: 32,
          pattern: "^[a-z0-9_-]{3,32}$",
        },
      });
      expect(operation?.responses).toHaveProperty("400");
    }
  });

  it("documents every column the full-row creator responses return", () => {
    // claimSlug, updateProfile, renameSlug and updateCreatorSplits all call
    // db.creator.update() without a select, so the response carries every
    // scalar column on the Creator model.
    const creator = openApiSpecification.components.schemas.Creator;
    const columns = Object.values(Prisma.CreatorScalarFieldEnum);

    expect(Object.keys(creator.properties)).toEqual(
      expect.arrayContaining(columns),
    );
    expect(creator.required).toEqual(expect.arrayContaining(columns));
    expect(creator.properties).toMatchObject({
      emailEnabled: { type: "boolean" },
      webhookEnabled: { type: "boolean" },
    });
  });

  it("documents hiding and unhiding a tip message", () => {
    const operation =
      openApiSpecification.paths["/creators/tips/{tipId}/message"]?.patch;

    expect(operation?.security).toEqual([{ bearerAuth: [] }]);
    expect(operation?.parameters).toEqual([
      expect.objectContaining({ name: "tipId", in: "path", required: true }),
    ]);
    expect(operation?.requestBody).toMatchObject({
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/MessageVisibilityRequest" },
        },
      },
    });
    expect(
      openApiSpecification.components.schemas.MessageVisibilityRequest,
    ).toEqual({
      type: "object",
      properties: {
        hidden: expect.objectContaining({ type: "boolean" }),
      },
      required: ["hidden"],
    });
    expect(Object.keys(operation?.responses ?? {})).toEqual(
      expect.arrayContaining(["200", "400", "401", "404"]),
    );
  });

  it("lets a custom 401 response override the generic secured 401 on /auth/me", () => {
    const responses = openApiSpecification.paths["/auth/me"]?.get?.responses;

    expect(responses?.["401"]).toMatchObject({
      description: "Creator account not found.",
    });
  });

  it("documents Cache-Control and Content-Disposition headers on QR and CSV export routes", () => {
    const svgHeaders =
      openApiSpecification.paths["/qr/{slug}"]?.get?.responses?.["200"]
        ?.headers;
    expect(svgHeaders).toHaveProperty("Cache-Control");

    const pngHeaders =
      openApiSpecification.paths["/qr/{slug}/png"]?.get?.responses?.["200"]
        ?.headers;
    expect(pngHeaders).toHaveProperty("Cache-Control");
    expect(pngHeaders).toHaveProperty("Content-Disposition");

    const csvHeaders =
      openApiSpecification.paths["/analytics/export"]?.get?.responses?.["200"]
        ?.headers;
    expect(csvHeaders).toHaveProperty("Content-Disposition");
    expect(csvHeaders).toHaveProperty("Cache-Control");
  });
});
