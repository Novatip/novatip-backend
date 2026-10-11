/**
 * docs.routes.ts
 *
 * Exposes machine-readable OpenAPI specification and interactive API documentation.
 *
 * GET /api/v1/docs/openapi.json  — raw OpenAPI 3.0.3 JSON
 * GET /api/v1/docs               — interactive Swagger UI HTML
 */

import type { FastifyPluginAsync } from "fastify";
import { openApiSpec } from "../../docs/openapi-spec.js";

export const docsRoutes: FastifyPluginAsync = async (app) => {
  // Machine-readable OpenAPI 3.0.3 JSON specification
  app.get("/openapi.json", async (_request, reply) => {
    reply.header("Content-Type", "application/json; charset=utf-8");
    return reply.send(openApiSpec);
  });

  // Interactive documentation explorer using Swagger UI CDN
  app.get("/", async (_request, reply) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Novatip API Reference</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
  <style>
    body { margin: 0; background: #0b0f19; }
    .swagger-ui .topbar { display: none; }
    .swagger-ui { filter: invert(88%) hue-rotate(180deg); }
    .swagger-ui .wrapper { max-width: 1200px; margin: auto; padding: 24px; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.onload = function() {
      SwaggerUIBundle({
        url: "/api/v1/docs/openapi.json",
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIBundle.SwaggerUIStandalonePreset
        ],
        layout: "BaseLayout"
      });
    };
  </script>
</body>
</html>`;

    reply.header("Content-Type", "text/html; charset=utf-8");
    return reply.send(html);
  });
};
