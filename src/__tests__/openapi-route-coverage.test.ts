/**
 * __tests__/openapi-route-coverage.test.ts
 *
 * Fails if any route the server actually registers has no OpenAPI spec
 * entry in openapi.ts. Nothing else catches a route added without a spec
 * entry, so this walks the real routes buildServer() registers (via the
 * onRoute hook, not a hand-maintained list that could itself drift) rather
 * than re-deriving them from each routes file.
 *
 * Ignored, per the hook's own events: Fastify's automatic HEAD route for
 * every GET, and any path listed in openapi.ts's documentedRouteAliases —
 * routes that intentionally share a handler with a documented path (the
 * CSV export's five aliases) and so have no spec entry of their own.
 */

import type { RouteOptions } from "fastify";

process.env["DATABASE_URL"] ??= "postgresql://user:pass@localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-at-least-32-chars-long-123456";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;

const { buildServer } = await import("../server.js");
const { openApiSpecification, documentedRouteAliases } = await import(
  "../openapi.js"
);

const API_PREFIX = "/api/v1";

/** Fastify's `:param` path syntax, translated to OpenAPI's `{param}`. */
function toSpecPath(url: string): string {
  const withoutPrefix = url.startsWith(API_PREFIX)
    ? url.slice(API_PREFIX.length)
    : url;
  const path = withoutPrefix === "" ? "/" : withoutPrefix;
  return path.replace(/:([^/]+)/g, "{$1}");
}

interface RegisteredRoute {
  method: string;
  path: string;
}

async function collectRoutes(): Promise<RegisteredRoute[]> {
  const routes: RegisteredRoute[] = [];

  const app = await buildServer({
    onRoute: (routeOptions: RouteOptions & { url: string }) => {
      const methods = Array.isArray(routeOptions.method)
        ? routeOptions.method
        : [routeOptions.method];
      for (const method of methods) {
        if (method === "HEAD") continue;
        routes.push({ method, path: toSpecPath(routeOptions.url) });
      }
    },
  });
  await app.ready();
  await app.close();

  return routes;
}

describe("OpenAPI route coverage", () => {
  it("gives every registered route a spec entry (or a documented alias)", async () => {
    const routes = await collectRoutes();

    // A canary against this test silently checking nothing — if onRoute
    // stops firing (a Fastify upgrade changes its contract, say), routes
    // would be empty and every assertion below would vacuously pass.
    expect(routes.length).toBeGreaterThan(20);

    const paths = openApiSpecification.paths as Record<
      string,
      Record<string, unknown>
    >;

    const undocumented = routes.filter(({ method, path }) => {
      const canonicalPath = documentedRouteAliases[path] ?? path;
      const operations = paths[canonicalPath];
      return !operations || !(method.toLowerCase() in operations);
    });

    expect(undocumented).toEqual([]);
  });

  it("documents every alias target", () => {
    const paths = openApiSpecification.paths as Record<string, unknown>;

    for (const [alias, target] of Object.entries(documentedRouteAliases)) {
      expect(paths).toHaveProperty(target);
      expect(alias).not.toBe(target);
    }
  });

  it("documents every zod-validated query key in exported route query schemas", async () => {
    const { DeliveryQuery, WebhookQuery } = await import(
      "../modules/webhooks/webhooks.routes.js"
    );
    const { RecentQuery: PublicRecentQuery } = await import(
      "../modules/public/public.routes.js"
    );
    const { RecentQuery: AnalyticsRecentQuery } = await import(
      "../modules/analytics/analytics.routes.js"
    );

    const querySchemas = [
      { path: "/webhooks/{id}/deliveries", schema: DeliveryQuery },
      { path: "/webhooks", schema: WebhookQuery },
      { path: "/public/{slug}/recent", schema: PublicRecentQuery },
      { path: "/analytics/recent", schema: AnalyticsRecentQuery },
    ] as const;

    const paths = openApiSpecification.paths as Record<
      string,
      { get?: { parameters?: Array<{ name?: string; in?: string }> } }
    >;

    for (const { path, schema } of querySchemas) {
      const documentedQueryParams = new Set(
        (paths[path]?.get?.parameters ?? [])
          .filter(
            (param) => param.in === "query" && typeof param.name === "string",
          )
          .map((param) => param.name!),
      );

      for (const key of Object.keys(schema.shape)) {
        expect(documentedQueryParams).toContain(key);
      }
    }
  });
});
