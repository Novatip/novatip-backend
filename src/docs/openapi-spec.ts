/**
 * openapi-spec.ts
 *
 * Formal OpenAPI 3.0.3 specification for Novatip backend services.
 */

export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Novatip Backend API",
    version: "0.1.0",
    description:
      "Production REST API for Novatip creator profiles, tip indexing, analytics, and webhook dispatching on Stellar.",
    contact: {
      name: "Novatip Support",
      url: "https://novatip.xyz",
    },
    license: {
      name: "MIT",
      url: "https://opensource.org/licenses/MIT",
    },
  },
  servers: [
    {
      url: "/api/v1",
      description: "Default API v1 prefix",
    },
  ],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description:
          "Provide JWT obtained from /auth/verify as `Authorization: Bearer <token>`.",
      },
    },
    schemas: {
      ErrorResponse: {
        type: "object",
        properties: {
          error: {
            type: "object",
            properties: {
              code: { type: "string" },
              message: { type: "string" },
            },
            required: ["code", "message"],
          },
        },
        required: ["error"],
      },
      ChallengeRequest: {
        type: "object",
        properties: {
          walletAddress: {
            type: "string",
            minLength: 56,
            maxLength: 56,
            example: "GD52XZ6M3S6R7ECLG32F6PGBK6K666LNYX3WFLX6X67L3L6P66776PPP",
          },
        },
        required: ["walletAddress"],
      },
      ChallengeResponse: {
        type: "object",
        properties: {
          nonce: { type: "string" },
        },
        required: ["nonce"],
      },
      VerifyRequest: {
        type: "object",
        properties: {
          walletAddress: { type: "string", minLength: 56, maxLength: 56 },
          signatureHex: { type: "string", minLength: 128, maxLength: 128 },
        },
        required: ["walletAddress", "signatureHex"],
      },
      VerifyResponse: {
        type: "object",
        properties: {
          jwt: { type: "string" },
          isNewUser: { type: "boolean" },
        },
        required: ["jwt", "isNewUser"],
      },
      UserResponse: {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              id: { type: "string" },
              walletAddress: { type: "string" },
            },
            required: ["id", "walletAddress"],
          },
        },
        required: ["user"],
      },
      CreatorProfile: {
        type: "object",
        properties: {
          id: { type: "string" },
          slug: { type: "string" },
          jarId: { type: "string" },
          name: { type: "string" },
          bio: { type: "string", nullable: true },
          walletAddress: { type: "string" },
          payoutAddress: { type: "string" },
          splits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                to: { type: "string" },
                bps: { type: "integer" },
              },
            },
          },
          createdAt: { type: "string", format: "date-time" },
        },
        required: ["id", "slug", "jarId", "walletAddress", "payoutAddress"],
      },
      ClaimCreatorRequest: {
        type: "object",
        properties: {
          slug: { type: "string" },
          jarId: { type: "string" },
        },
        required: ["slug"],
      },
      UpdateProfileRequest: {
        type: "object",
        properties: {
          name: { type: "string" },
          bio: { type: "string", nullable: true },
          email: { type: "string", nullable: true },
        },
      },
      UpdateSplitsRequest: {
        type: "object",
        properties: {
          splits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                to: { type: "string" },
                bps: { type: "integer" },
              },
              required: ["to", "bps"],
            },
          },
        },
        required: ["splits"],
      },
      AnalyticsTotalsResponse: {
        type: "object",
        properties: {
          totalTips: { type: "integer" },
          totalAmountRaw: { type: "string" },
          uniqueSupporters: { type: "integer" },
        },
        required: ["totalTips", "totalAmountRaw", "uniqueSupporters"],
      },
      TimeseriesPoint: {
        type: "object",
        properties: {
          date: { type: "string", format: "date" },
          tipCount: { type: "integer" },
          amountRaw: { type: "string" },
        },
        required: ["date", "tipCount", "amountRaw"],
      },
      RecentTipsResponse: {
        type: "object",
        properties: {
          tips: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                txHash: { type: "string" },
                fromAddress: { type: "string" },
                amount: { type: "string" },
                message: { type: "string", nullable: true },
                ledgerAt: { type: "string", format: "date-time" },
              },
            },
          },
          nextCursor: { type: "string", nullable: true },
        },
        required: ["tips", "nextCursor"],
      },
      CollaboratorsResponse: {
        type: "object",
        properties: {
          tipCount: { type: "integer" },
          totalAmountRaw: { type: "string" },
          unallocatedRaw: { type: "string" },
          collaborators: {
            type: "array",
            items: {
              type: "object",
              properties: {
                to: { type: "string" },
                bps: { type: "integer" },
                sharePercent: { type: "number" },
                totalEarnedRaw: { type: "string" },
              },
            },
          },
          basis: {
            type: "object",
            properties: {
              mode: { type: "string" },
              splitsUpdatedAt: { type: "string" },
              impliedOwnerSplit: { type: "boolean" },
              note: { type: "string" },
            },
          },
        },
        required: ["tipCount", "totalAmountRaw", "unallocatedRaw", "collaborators", "basis"],
      },
      WebhookResponse: {
        type: "object",
        properties: {
          id: { type: "string" },
          url: { type: "string" },
          events: { type: "array", items: { type: "string" } },
          enabled: { type: "boolean" },
          createdAt: { type: "string", format: "date-time" },
        },
        required: ["id", "url", "events", "enabled", "createdAt"],
      },
      CreateWebhookRequest: {
        type: "object",
        properties: {
          url: { type: "string", format: "uri" },
          events: { type: "array", items: { type: "string" } },
          enabled: { type: "boolean" },
        },
        required: ["url", "events"],
      },
    },
  },
  paths: {
    "/health": {
      get: {
        summary: "Simple liveness ping",
        responses: {
          "200": {
            description: "Service is online",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string" },
                    ts: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/health/live": {
      get: {
        summary: "Liveness probe",
        responses: {
          "200": {
            description: "Process is running",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string" },
                    uptime: { type: "number" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/health/ready": {
      get: {
        summary: "Readiness probe",
        description: "Checks connectivity to Postgres and Redis",
        responses: {
          "200": { description: "Database and Redis connected" },
          "503": { description: "Service dependencies unreachable" },
        },
      },
    },
    "/auth/challenge": {
      post: {
        summary: "Issue one-time sign-in nonce",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ChallengeRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Nonce generated",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ChallengeResponse" },
              },
            },
          },
          "400": { description: "Invalid wallet address" },
          "429": { description: "Rate limited" },
        },
      },
    },
    "/auth/verify": {
      post: {
        summary: "Verify signature and return JWT",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/VerifyRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Authentication successful",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/VerifyResponse" },
              },
            },
          },
          "400": { description: "Invalid signature or request format" },
        },
      },
    },
    "/auth/me": {
      get: {
        summary: "Return current authenticated user profile",
        security: [{ BearerAuth: [] }],
        responses: {
          "200": {
            description: "Authenticated user details",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/UserResponse" },
              },
            },
          },
          "401": { description: "Unauthorized" },
        },
      },
    },
    "/creators/{slug}": {
      get: {
        summary: "Get public creator profile by slug",
        parameters: [
          {
            name: "slug",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Public creator profile",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreatorProfile" },
              },
            },
          },
          "404": { description: "Creator not found" },
        },
      },
    },
    "/creators/check/{slug}": {
      get: {
        summary: "Check slug availability",
        parameters: [
          {
            name: "slug",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Availability result",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    available: { type: "boolean" },
                    reason: { type: "string", nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/creators/claim": {
      post: {
        summary: "Claim creator slug and initialize profile",
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ClaimCreatorRequest" },
            },
          },
        },
        responses: {
          "201": { description: "Slug claimed successfully" },
          "400": { description: "Invalid slug format" },
          "409": { description: "Slug or jarId already taken" },
        },
      },
    },
    "/creators/me": {
      patch: {
        summary: "Update current creator profile",
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UpdateProfileRequest" },
            },
          },
        },
        responses: {
          "200": { description: "Profile updated" },
          "401": { description: "Unauthorized" },
        },
      },
    },
    "/creators/me/splits": {
      patch: {
        summary: "Update payment splits configuration",
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UpdateSplitsRequest" },
            },
          },
        },
        responses: {
          "200": { description: "Splits updated" },
          "400": { description: "Splits exceed 10000 bps" },
        },
      },
    },
    "/qr/{slug}": {
      get: {
        summary: "Generate SVG QR code for creator tip page",
        parameters: [
          {
            name: "slug",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "SVG image",
            content: { "image/svg+xml": {} },
          },
        },
      },
    },
    "/qr/{slug}/png": {
      get: {
        summary: "Generate PNG QR code for creator tip page",
        parameters: [
          {
            name: "slug",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "PNG image",
            content: { "image/png": {} },
          },
        },
      },
    },
    "/resolve/{slug}": {
      get: {
        summary: "Resolve tip page metadata for client payment UI",
        parameters: [
          {
            name: "slug",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "Tip page resolution payload" },
          "404": { description: "Creator not found" },
        },
      },
    },
    "/analytics/totals": {
      get: {
        summary: "Aggregated tip counts, volume, and unique supporters",
        security: [{ BearerAuth: [] }],
        responses: {
          "200": {
            description: "Totals payload",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AnalyticsTotalsResponse" },
              },
            },
          },
        },
      },
    },
    "/analytics/timeseries": {
      get: {
        summary: "Daily breakdown of tips over specified window",
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: "days",
            in: "query",
            schema: { type: "integer", default: 30 },
          },
        ],
        responses: {
          "200": {
            description: "Timeseries array",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    series: {
                      type: "array",
                      items: { $ref: "#/components/schemas/TimeseriesPoint" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/analytics/top-supporters": {
      get: {
        summary: "Ranked supporter leaderboards",
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", default: 10 },
          },
        ],
        responses: {
          "200": { description: "Leaderboard array" },
        },
      },
    },
    "/analytics/recent": {
      get: {
        summary: "Cursor-paginated recent tips stream",
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", default: 20 },
          },
          {
            name: "cursor",
            in: "query",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Tips stream page",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/RecentTipsResponse" },
              },
            },
          },
        },
      },
    },
    "/analytics/collaborators": {
      get: {
        summary: "Split earnings breakdown per collaborator",
        security: [{ BearerAuth: [] }],
        responses: {
          "200": {
            description: "Collaborators breakdown",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CollaboratorsResponse" },
              },
            },
          },
        },
      },
    },
    "/public/{slug}/recent": {
      get: {
        summary: "Public unauthenticated tip feed for supporter display",
        parameters: [
          {
            name: "slug",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", default: 20 },
          },
          {
            name: "cursor",
            in: "query",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Public tips feed",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/RecentTipsResponse" },
              },
            },
          },
        },
      },
    },
    "/webhooks": {
      get: {
        summary: "List registered webhooks for current creator",
        security: [{ BearerAuth: [] }],
        responses: {
          "200": {
            description: "Webhook array",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/WebhookResponse" },
                },
              },
            },
          },
        },
      },
      post: {
        summary: "Register new webhook subscription",
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateWebhookRequest" },
            },
          },
        },
        responses: {
          "201": { description: "Webhook registered" },
          "400": { description: "Invalid webhook URL or events" },
        },
      },
    },
    "/webhooks/{id}": {
      patch: {
        summary: "Update webhook configuration",
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "Webhook updated" } },
      },
      delete: {
        summary: "Delete webhook",
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "204": { description: "Webhook deleted" } },
      },
    },
    "/webhooks/{id}/deliveries": {
      get: {
        summary: "List delivery attempts and logs for webhook",
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "Deliveries array" } },
      },
    },
    "/webhooks/{id}/test": {
      post: {
        summary: "Send test ping event to webhook endpoint",
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "Test delivery initiated" } },
      },
    },
    "/webhooks/{id}/secret": {
      post: {
        summary: "Rotate webhook signing secret",
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "Secret rotated" } },
      },
    },
    "/docs/openapi.json": {
      get: {
        summary: "Retrieve machine-readable OpenAPI 3.0.3 specification",
        responses: {
          "200": {
            description: "OpenAPI JSON document",
            content: { "application/json": {} },
          },
        },
      },
    },
  },
} as const;
