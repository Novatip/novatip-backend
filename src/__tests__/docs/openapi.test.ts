import { openApiSpec } from "../../docs/openapi-spec.js";

describe("OpenAPI Specification", () => {
  it("conforms to OpenAPI 3.0.3 specification structure", () => {
    expect(openApiSpec.openapi).toBe("3.0.3");
    expect(openApiSpec.info.title).toBe("Novatip Backend API");
    expect(openApiSpec.info.version).toBe("0.1.0");
    expect(Array.isArray(openApiSpec.servers)).toBe(true);
    expect(openApiSpec.servers[0].url).toBe("/api/v1");
  });

  it("declares BearerAuth security scheme in components", () => {
    expect(openApiSpec.components.securitySchemes.BearerAuth).toBeDefined();
    expect(openApiSpec.components.securitySchemes.BearerAuth.type).toBe("http");
    expect(openApiSpec.components.securitySchemes.BearerAuth.scheme).toBe("bearer");
    expect(openApiSpec.components.securitySchemes.BearerAuth.bearerFormat).toBe("JWT");
  });

  it("covers health, auth, creators, analytics, and webhook paths", () => {
    const paths = Object.keys(openApiSpec.paths);

    expect(paths).toContain("/health");
    expect(paths).toContain("/health/live");
    expect(paths).toContain("/health/ready");
    expect(paths).toContain("/auth/challenge");
    expect(paths).toContain("/auth/verify");
    expect(paths).toContain("/auth/me");
    expect(paths).toContain("/creators/{slug}");
    expect(paths).toContain("/creators/check/{slug}");
    expect(paths).toContain("/creators/claim");
    expect(paths).toContain("/creators/me");
    expect(paths).toContain("/creators/me/splits");
    expect(paths).toContain("/qr/{slug}");
    expect(paths).toContain("/qr/{slug}/png");
    expect(paths).toContain("/resolve/{slug}");
    expect(paths).toContain("/analytics/totals");
    expect(paths).toContain("/analytics/timeseries");
    expect(paths).toContain("/analytics/top-supporters");
    expect(paths).toContain("/analytics/recent");
    expect(paths).toContain("/analytics/collaborators");
    expect(paths).toContain("/public/{slug}/recent");
    expect(paths).toContain("/webhooks");
    expect(paths).toContain("/webhooks/{id}");
    expect(paths).toContain("/docs/openapi.json");
  });

  it("documents required schemas in components", () => {
    const schemas = openApiSpec.components.schemas;
    expect(schemas.ChallengeRequest).toBeDefined();
    expect(schemas.ChallengeResponse).toBeDefined();
    expect(schemas.VerifyRequest).toBeDefined();
    expect(schemas.VerifyResponse).toBeDefined();
    expect(schemas.CreatorProfile).toBeDefined();
    expect(schemas.RecentTipsResponse).toBeDefined();
    expect(schemas.CollaboratorsResponse).toBeDefined();
    expect(schemas.WebhookResponse).toBeDefined();
  });
});
