const schema = (name: string) => ({
  $ref: `#/components/schemas/${name}`,
});

const json = (description: string, bodySchema: object) => ({
  description,
  content: { "application/json": { schema: bodySchema } },
});

const response = (description: string) => ({ description });

const pathParameter = (
  name: string,
  description: string,
  parameterSchema: object = { type: "string" },
) => ({
  name,
  in: "path",
  required: true,
  description,
  schema: parameterSchema,
});

const queryParameter = (
  name: string,
  description: string,
  parameterSchema: object,
) => ({
  name,
  in: "query",
  required: false,
  description,
  schema: parameterSchema,
});

interface OperationOptions {
  summary: string;
  success: object;
  successStatus?: number;
  parameters?: object[];
  requestBody?: object;
  secured?: boolean;
  extraResponses?: Record<string, object>;
  description?: string;
}

function operation({
  summary,
  success,
  successStatus = 200,
  parameters = [],
  requestBody,
  secured = false,
  extraResponses = {},
  description,
}: OperationOptions) {
  return {
    summary,
    ...(description && { description }),
    ...(secured && { security: [{ bearerAuth: [] }] }),
    ...(parameters.length > 0 && { parameters }),
    ...(requestBody && { requestBody }),
    responses: {
      [successStatus]: success,
      "429": rateLimited,
      ...(secured && {
        "401": json(
          "Missing or invalid bearer token.",
          schema("ErrorResponse"),
        ),
      }),
      ...extraResponses,
    },
  };
}

const validationError = json(
  "Path parameters, query parameters, or request body failed validation.",
  schema("ValidationErrorResponse"),
);
const notFound = json(
  "The requested resource was not found.",
  schema("ErrorResponse"),
);
const conflict = json(
  "The requested change conflicts with existing data.",
  schema("ErrorResponse"),
);
const rateLimited = json(
  "The request rate limit was exceeded.",
  schema("RateLimitResponse"),
);

const slugParameter = pathParameter("slug", "Creator's public slug.");
const validatedSlugParameter = pathParameter(
  "slug",
  "Creator's public slug: 3–32 lowercase letters, numbers, underscores, or hyphens.",
  {
    type: "string",
    minLength: 3,
    maxLength: 32,
    pattern: "^[a-z0-9_-]{3,32}$",
  },
);
const idParameter = pathParameter("id", "Resource identifier.");
const paginationParameters = [
  queryParameter("limit", "Maximum number of results.", {
    type: "integer",
    minimum: 1,
  }),
  queryParameter("offset", "Number of results to skip.", {
    type: "integer",
    minimum: 0,
    default: 0,
  }),
];
const cursorParameters = [
  queryParameter("limit", "Maximum number of tips in the page.", {
    type: "integer",
    minimum: 1,
  }),
  queryParameter("cursor", "Opaque cursor returned by the previous page.", {
    type: "string",
    minLength: 1,
  }),
];

const requestBody = (bodySchema: object, required = true) => ({
  required,
  content: { "application/json": { schema: bodySchema } },
});

/**
 * Routes that intentionally share a handler with a documented path and so
 * have no spec entry of their own — analytics.routes.ts registers five
 * extra aliases for the CSV export under the one handler GET /export
 * documents. Each key is the alias's path (relative to the API prefix,
 * matching the keys of openApiSpecification.paths below); the value is the
 * documented path that describes it. A route-coverage test treats a method
 * on one of these paths as satisfied without a spec entry of its own.
 */
export const documentedRouteAliases: Record<string, string> = {
  "/analytics/csv": "/analytics/export",
  "/analytics/recent.csv": "/analytics/export",
  "/analytics/export.csv": "/analytics/export",
  "/analytics/tips.csv": "/analytics/export",
  "/analytics/history.csv": "/analytics/export",
};

export const openApiSpecification = {
  openapi: "3.0.3",
  info: {
    title: "Novatip Backend API",
    version: "0.1.0",
    description:
      "Creator profiles, Stellar sign-in, tip analytics, QR codes, and webhook management.",
  },
  servers: [{ url: "/api/v1", description: "API v1" }],
  paths: {
    "/openapi.json": {
      get: operation({
        summary: "Get this OpenAPI specification",
        success: {
          description: "OpenAPI 3.0.3 document.",
          content: {
            "application/json": {
              schema: { type: "object" },
            },
          },
        },
      }),
    },
    "/health": {
      get: operation({
        summary: "Simple health ping",
        success: json("The process is running.", schema("LivenessResponse")),
      }),
    },
    "/health/live": {
      get: operation({
        summary: "Liveness probe",
        success: json("The process is running.", schema("LivenessResponse")),
      }),
    },
    "/health/ready": {
      get: operation({
        summary: "Readiness probe",
        success: json("Dependency status.", schema("ReadinessResponse")),
        extraResponses: {
          "503": json(
            "One or more dependencies are unavailable.",
            schema("ReadinessResponse"),
          ),
        },
      }),
    },
    "/health/indexer": {
      get: operation({
        summary: "Indexer progress",
        success: json(
          "Persisted cursor and latest known chain ledger.",
          schema("IndexerStatusResponse"),
        ),
      }),
    },
    "/health/version": {
      get: operation({
        summary: "Build and version metadata",
        success: json(
          "Package version, build commit, and configured Stellar network.",
          schema("HealthVersionResponse"),
        ),
      }),
    },
    "/auth/challenge": {
      post: operation({
        summary: "Issue a one-time sign-in challenge",
        success: json("The generated nonce.", schema("ChallengeResponse")),
        requestBody: requestBody(schema("ChallengeRequest")),
        extraResponses: {
          "400": validationError,
          "429": json(
            "Too many challenge requests from this IP.",
            schema("ErrorResponse"),
          ),
        },
      }),
    },
    "/auth/verify": {
      post: operation({
        summary: "Verify a signed challenge and issue a JWT",
        success: json("The signed-in session.", schema("VerifyResponse")),
        requestBody: requestBody(schema("VerifyRequest")),
        extraResponses: {
          "400": validationError,
          "429": json(
            "Too many verification requests from this IP.",
            schema("RateLimitResponse"),
          ),
        },
      }),
    },
    "/auth/me": {
      get: operation({
        summary: "Get the authenticated user",
        success: json("The current user.", schema("CurrentUserResponse")),
        secured: true,
        extraResponses: {
          "401": json("Creator account not found.", schema("ErrorResponse")),
        },
      }),
    },
    "/creators/{slug}": {
      get: operation({
        summary: "Get a public creator profile",
        success: json(
          "The public creator profile.",
          schema("PublicCreatorResponse"),
        ),
        parameters: [validatedSlugParameter],
        extraResponses: { "400": validationError, "404": notFound },
      }),
    },
    "/creators/check/{slug}": {
      get: operation({
        summary: "Check whether a creator slug is available",
        success: json(
          "Availability result.",
          schema("SlugAvailabilityResponse"),
        ),
        parameters: [slugParameter],
      }),
    },
    "/creators/claim": {
      post: operation({
        summary: "Claim a creator slug",
        successStatus: 201,
        success: json("The newly claimed creator.", schema("CreatorResponse")),
        requestBody: requestBody(schema("ClaimCreatorRequest")),
        secured: true,
        extraResponses: {
          "400": validationError,
          "409": conflict,
        },
      }),
    },
    "/creators/me": {
      patch: operation({
        summary: "Update the authenticated creator profile",
        description:
          "Changing the notification email clears its verification state and sends a signed confirmation link valid for 24 hours. Tip emails are sent only to a verified address.",
        success: json("The updated creator.", schema("CreatorResponse")),
        requestBody: requestBody(schema("UpdateProfileRequest")),
        secured: true,
        extraResponses: { "400": validationError, "404": notFound },
      }),
      delete: operation({
        summary: "Delete the authenticated creator account",
        description:
          "Permanently removes the profile, notifications, webhooks, and webhook delivery history. The deleted creator's slug remains unavailable for the configured hold period, and existing JWTs are rejected. Indexed tips are retained as on-chain financial history but detached from the deleted creator.",
        successStatus: 204,
        success: { description: "Creator account deleted." },
        secured: true,
        extraResponses: { "404": notFound },
      }),
    },
    "/creators/email/verify": {
      get: operation({
        summary: "Confirm a creator notification email",
        description:
          "Confirms an address using the signed, single-use link sent after it is added or changed. The link expires after 24 hours.",
        parameters: [
          {
            name: "token",
            in: "query",
            required: true,
            description:
              "Signed email verification token from the confirmation email.",
            schema: { type: "string" },
          },
        ],
        success: json(
          "The email address was verified.",
          schema("EmailVerificationResponse"),
        ),
        extraResponses: { "400": validationError },
      }),
    },
    "/creators/me/splits": {
      patch: operation({
        summary: "Update the authenticated creator's splits",
        success: json("The updated creator.", schema("CreatorResponse")),
        requestBody: requestBody(schema("UpdateSplitsRequest")),
        secured: true,
        extraResponses: { "400": validationError, "404": notFound },
      }),
    },
    "/creators/me/slug": {
      patch: operation({
        summary: "Rename the authenticated creator's slug",
        success: json("The updated creator.", schema("CreatorResponse")),
        requestBody: requestBody(schema("RenameSlugRequest")),
        secured: true,
        extraResponses: {
          "400": validationError,
          "404": notFound,
          "409": conflict,
        },
      }),
    },
    "/creators/tips/{tipId}/message": {
      patch: operation({
        summary: "Hide or unhide a tip message",
        description:
          "Hides a tip's message from the creator's public tip feed, or shows it again. The tip itself is unaffected. Only tips received by the authenticated creator can be changed.",
        success: json(
          "The tip's updated message visibility.",
          schema("TipMessageVisibilityResponse"),
        ),
        parameters: [pathParameter("tipId", "Tip identifier.")],
        requestBody: requestBody(schema("MessageVisibilityRequest")),
        secured: true,
        extraResponses: {
          "400": validationError,
          "404": json(
            "No tip with this ID belongs to the authenticated creator.",
            schema("ErrorResponse"),
          ),
        },
      }),
    },
    "/resolve/{slug}": {
      get: operation({
        summary: "Resolve the tip-page data for a creator slug",
        description:
          "Successful responses are publicly cacheable: they carry " +
          "`Cache-Control: public, max-age=60`, matching the server-side " +
          "profile cache.",
        success: json("Creator and tip-page links.", schema("ResolveResponse")),
        parameters: [validatedSlugParameter],
        extraResponses: { "400": validationError, "404": notFound },
      }),
    },
    "/qr/{slug}": {
      get: operation({
        summary: "Get a creator tip-page QR code as SVG",
        success: {
          description: "QR code image.",
          headers: {
            "Cache-Control": {
              description:
                "Caching directive for the generated QR code (`public, max-age=3600`).",
              schema: { type: "string" },
            },
          },
          content: { "image/svg+xml": { schema: { type: "string" } } },
        },
        parameters: [validatedSlugParameter],
        extraResponses: {
          "400": validationError,
          "404": notFound,
          "429": rateLimited,
        },
      }),
    },
    "/qr/{slug}/png": {
      get: operation({
        summary: "Download a creator tip-page QR code as PNG",
        success: {
          description: "PNG QR code image.",
          headers: {
            "Cache-Control": {
              description:
                "Caching directive for the generated QR code (`public, max-age=3600`).",
              schema: { type: "string" },
            },
            "Content-Disposition": {
              description:
                'Download filename (`attachment; filename="novatip-{slug}.png"`).',
              schema: { type: "string" },
            },
          },
          content: {
            "image/png": { schema: { type: "string", format: "binary" } },
          },
        },
        parameters: [
          validatedSlugParameter,
          queryParameter(
            "width",
            "PNG image width in pixels (64–2048, default 512).",
            {
              type: "integer",
              minimum: 64,
              maximum: 2048,
              default: 512,
            },
          ),
        ],
        extraResponses: {
          "400": validationError,
          "404": notFound,
          "429": rateLimited,
        },
      }),
    },
    "/analytics/totals": {
      get: operation({
        summary: "Get tip totals and unique supporter count",
        success: json("Tip totals.", schema("TipTotalsResponse")),
        secured: true,
      }),
    },
    "/analytics/timeseries": {
      get: operation({
        summary: "Get daily tip totals",
        success: json("Daily time series.", schema("TimeSeriesResponse")),
        parameters: [
          queryParameter("days", "Number of UTC days to include (1–365).", {
            type: "integer",
            minimum: 1,
            maximum: 365,
            default: 30,
          }),
        ],
        secured: true,
        extraResponses: { "400": validationError },
      }),
    },
    "/analytics/top-supporters": {
      get: operation({
        summary: "Get the top supporters",
        success: json("Ranked supporters.", schema("TopSupportersResponse")),
        parameters: [
          queryParameter("limit", "Number of supporters (1–100).", {
            type: "integer",
            minimum: 1,
            maximum: 100,
            default: 10,
          }),
        ],
        secured: true,
        extraResponses: { "400": validationError },
      }),
    },
    "/analytics/recent": {
      get: operation({
        summary: "Get a page of recent tips",
        success: json("Page of recent tips.", schema("RecentTipsResponse")),
        parameters: [
          queryParameter("limit", "Page size (1–100, default 20).", {
            type: "integer",
            minimum: 1,
            maximum: 100,
            default: 20,
          }),
          cursorParameters[1]!,
        ],
        secured: true,
        extraResponses: { "400": validationError },
      }),
    },
    "/analytics/collaborators": {
      get: operation({
        summary: "Get collaborator earnings",
        success: json(
          "Earnings per recipient and calculation basis.",
          schema("CollaboratorBreakdownResponse"),
        ),
        secured: true,
        extraResponses: {
          "404": notFound,
          "500": json("Stored splits are malformed.", schema("ErrorResponse")),
        },
      }),
    },
    "/analytics/export": {
      get: operation({
        summary: "Download the authenticated creator's tip history as CSV",
        description:
          "Streams every tip for the authenticated creator as a CSV attachment. Also reachable as /analytics/csv, /analytics/recent.csv, /analytics/export.csv, /analytics/tips.csv and /analytics/history.csv — documented aliases of this same endpoint (see documentedRouteAliases in openapi.ts).",
        success: {
          description: "CSV file of the creator's tip history.",
          headers: {
            "Content-Disposition": {
              description:
                'Download filename (`attachment; filename="{slug}-tip-history.csv"`).',
              schema: { type: "string" },
            },
            "Cache-Control": {
              description:
                "Caching directive opting out of caching (`no-store`).",
              schema: { type: "string" },
            },
          },
          content: { "text/csv": { schema: { type: "string" } } },
        },
        secured: true,
      }),
    },
    "/public/{slug}/recent": {
      get: operation({
        summary: "Get the public supporter feed",
        success: json("Page of public tips.", schema("PublicTipsResponse")),
        parameters: [
          validatedSlugParameter,
          queryParameter("limit", "Page size (1–50, default 20).", {
            type: "integer",
            minimum: 1,
            maximum: 50,
            default: 20,
          }),
          cursorParameters[1]!,
        ],
        extraResponses: {
          "400": validationError,
          "404": notFound,
        },
      }),
    },
    "/notifications": {
      get: operation({
        summary: "Get the authenticated creator's notification feed",
        success: json(
          "Page of notifications, newest first.",
          schema("NotificationListResponse"),
        ),
        parameters: [
          queryParameter("limit", "Page size (1–100, default 20).", {
            type: "integer",
            minimum: 1,
            maximum: 100,
            default: 20,
          }),
          paginationParameters[1]!,
        ],
        secured: true,
        extraResponses: { "400": validationError },
      }),
    },
    "/notifications/preferences": {
      get: operation({
        summary: "Get the authenticated creator's notification preferences",
        success: json(
          "The creator's channel preferences.",
          schema("NotificationPreferencesResponse"),
        ),
        secured: true,
      }),
      patch: operation({
        summary: "Update the authenticated creator's notification preferences",
        success: json(
          "The updated channel preferences.",
          schema("NotificationPreferencesResponse"),
        ),
        requestBody: requestBody(
          schema("UpdateNotificationPreferencesRequest"),
        ),
        secured: true,
        extraResponses: { "400": validationError },
      }),
    },
    "/webhooks": {
      get: operation({
        summary: "List the authenticated creator's webhooks",
        success: json("Page of webhooks.", schema("WebhookListResponse")),
        parameters: [
          queryParameter("limit", "Page size (1–100, default 50).", {
            type: "integer",
            minimum: 1,
            maximum: 100,
            default: 50,
          }),
          paginationParameters[1]!,
        ],
        secured: true,
        extraResponses: { "400": validationError },
      }),
      post: operation({
        summary: "Register a webhook",
        successStatus: 201,
        success: json(
          "Created webhook and its signing secret (shown once).",
          schema("CreatedWebhookResponse"),
        ),
        requestBody: requestBody(schema("CreateWebhookRequest")),
        secured: true,
        extraResponses: {
          "400": validationError,
          "409": conflict,
        },
      }),
    },
    "/webhooks/{id}": {
      patch: operation({
        summary: "Enable or disable a webhook",
        success: json("Updated webhook.", schema("WebhookResponse")),
        parameters: [idParameter],
        requestBody: requestBody(schema("SetWebhookEnabledRequest")),
        secured: true,
        extraResponses: {
          "400": validationError,
          "404": notFound,
        },
      }),
      delete: operation({
        summary: "Delete a webhook",
        successStatus: 204,
        success: response("Webhook deleted."),
        parameters: [idParameter],
        secured: true,
        extraResponses: { "404": notFound },
      }),
    },
    "/webhooks/{id}/deliveries": {
      get: operation({
        summary: "List webhook delivery attempts",
        success: json(
          "Page of delivery attempts.",
          schema("WebhookDeliveriesResponse"),
        ),
        parameters: [
          idParameter,
          queryParameter("limit", "Page size (1–100, default 20).", {
            type: "integer",
            minimum: 1,
            maximum: 100,
            default: 20,
          }),
          paginationParameters[1]!,
        ],
        secured: true,
        extraResponses: {
          "400": validationError,
          "404": notFound,
        },
      }),
    },
    "/webhooks/{id}/ping": {
      post: operation({
        summary: "Send a signed test ping to a webhook",
        success: json(
          "The result of the delivery attempt.",
          schema("WebhookPingResponse"),
        ),
        parameters: [idParameter],
        secured: true,
        extraResponses: {
          "404": notFound,
          "429": rateLimited,
        },
      }),
    },
    "/webhooks/{id}/secret": {
      post: operation({
        summary: "Rotate a webhook's signing secret",
        success: json(
          "Updated webhook and its new secret (shown once).",
          schema("RotatedWebhookResponse"),
        ),
        parameters: [idParameter],
        requestBody: requestBody(schema("RotateWebhookSecretRequest"), false),
        secured: true,
        extraResponses: {
          "400": validationError,
          "404": notFound,
        },
      }),
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
      },
    },
    schemas: {
      ErrorResponse: {
        type: "object",
        properties: {
          error: {
            oneOf: [
              {
                type: "object",
                properties: {
                  code: { type: "string" },
                  message: { type: "string" },
                },
                required: ["code", "message"],
              },
              { type: "string" },
            ],
          },
        },
        required: ["error"],
      },
      RateLimitResponse: {
        oneOf: [
          schema("ErrorResponse"),
          {
            type: "object",
            properties: {
              statusCode: { type: "integer", enum: [429] },
              error: { type: "string" },
              message: { type: "string" },
            },
            required: ["statusCode", "error", "message"],
          },
        ],
      },
      ValidationErrorResponse: {
        type: "object",
        properties: {
          error: {
            type: "object",
            properties: {
              formErrors: { type: "array", items: { type: "string" } },
              fieldErrors: {
                type: "object",
                additionalProperties: {
                  type: "array",
                  items: { type: "string" },
                },
              },
            },
            required: ["formErrors", "fieldErrors"],
          },
        },
        required: ["error"],
      },
      LivenessResponse: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["ok"] },
          ts: { type: "string", format: "date-time" },
        },
        required: ["status", "ts"],
      },
      DependencyStatus: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["up", "down"] },
          latencyMs: { type: "number" },
          error: { type: "string" },
        },
        required: ["status", "latencyMs"],
      },
      ReadinessResponse: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["ok", "degraded"] },
          checks: {
            type: "object",
            properties: {
              database: schema("DependencyStatus"),
              redis: schema("DependencyStatus"),
            },
            required: ["database", "redis"],
          },
          ts: { type: "string", format: "date-time" },
        },
        required: ["status", "checks", "ts"],
      },
      IndexerStatusResponse: {
        type: "object",
        properties: {
          cursorLedger: { type: "integer" },
          chainHead: {
            oneOf: [
              {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["known"] },
                  ledger: { type: "integer" },
                },
                required: ["status", "ledger"],
              },
              {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["unknown"] },
                },
                required: ["status"],
              },
            ],
          },
          gap: { type: "integer", nullable: true },
          lastSuccessfulPollAt: {
            type: "string",
            format: "date-time",
            nullable: true,
          },
          lastError: { type: "string", nullable: true },
          ts: { type: "string", format: "date-time" },
        },
        required: [
          "cursorLedger",
          "chainHead",
          "gap",
          "lastSuccessfulPollAt",
          "lastError",
          "ts",
        ],
      },
      ChallengeRequest: {
        type: "object",
        properties: {
          walletAddress: { type: "string", minLength: 56, maxLength: 56 },
        },
        required: ["walletAddress"],
      },
      ChallengeResponse: {
        type: "object",
        properties: { nonce: { type: "string" } },
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
      CurrentUserResponse: {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              sub: { type: "string" },
              wallet: { type: "string" },
              slug: { type: "string", nullable: true },
              emailVerifiedAt: {
                type: "string",
                format: "date-time",
                nullable: true,
              },
              iat: { type: "number" },
              exp: { type: "number" },
            },
            required: ["sub", "wallet", "slug", "emailVerifiedAt"],
          },
        },
        required: ["user"],
      },
      Split: {
        type: "object",
        description:
          "The recipient must be a valid Stellar account address. Basis points are from 1 to 10000.",
        properties: {
          to: { type: "string", pattern: "^G[A-Z2-7]{55}$" },
          bps: { type: "integer", minimum: 1, maximum: 10_000 },
        },
        required: ["to", "bps"],
      },
      PublicCreator: {
        type: "object",
        properties: {
          id: { type: "string" },
          slug: { type: "string" },
          displayName: { type: "string", nullable: true },
          bio: { type: "string", nullable: true },
          avatarUrl: { type: "string", nullable: true },
          jarId: { type: "string" },
          splits: {
            type: "array",
            description:
              "Recipients must be unique, and total basis points must not exceed 10000.",
            items: schema("Split"),
          },
          createdAt: { type: "string", format: "date-time" },
        },
        required: [
          "id",
          "slug",
          "displayName",
          "bio",
          "avatarUrl",
          "jarId",
          "splits",
          "createdAt",
        ],
      },
      Creator: {
        type: "object",
        properties: {
          id: { type: "string" },
          walletAddress: { type: "string" },
          slug: { type: "string" },
          displayName: { type: "string", nullable: true },
          bio: { type: "string", nullable: true },
          avatarUrl: { type: "string", nullable: true },
          email: { type: "string", nullable: true },
          emailVerifiedAt: {
            type: "string",
            format: "date-time",
            nullable: true,
          },
          emailEnabled: {
            type: "boolean",
            description: "Whether tip-notification emails are switched on.",
          },
          webhookEnabled: {
            type: "boolean",
            description: "Whether tip webhooks are dispatched.",
          },
          jarId: { type: "string" },
          splits: { type: "array", items: schema("Split") },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
        required: [
          "id",
          "walletAddress",
          "slug",
          "displayName",
          "bio",
          "avatarUrl",
          "email",
          "emailVerifiedAt",
          "emailEnabled",
          "webhookEnabled",
          "jarId",
          "splits",
          "createdAt",
          "updatedAt",
        ],
      },
      PublicCreatorResponse: {
        type: "object",
        properties: { creator: schema("PublicCreator") },
        required: ["creator"],
      },
      CreatorResponse: {
        type: "object",
        properties: { creator: schema("Creator") },
        required: ["creator"],
      },
      EmailVerificationResponse: {
        type: "object",
        properties: { verified: { type: "boolean" } },
        required: ["verified"],
      },
      SlugAvailabilityResponse: {
        type: "object",
        properties: {
          slug: { type: "string" },
          available: { type: "boolean" },
        },
        required: ["slug", "available"],
      },
      ClaimCreatorRequest: {
        type: "object",
        properties: {
          slug: { type: "string", minLength: 3, maxLength: 32 },
          jarId: { type: "string", minLength: 1 },
          displayName: { type: "string", maxLength: 80 },
          bio: { type: "string", maxLength: 300 },
          splits: { type: "array", items: schema("Split") },
        },
        required: ["slug"],
      },
      UpdateProfileRequest: {
        type: "object",
        description:
          "Every field is optional; an omitted key leaves the stored value unchanged. For displayName, bio and avatarUrl, null or an empty/whitespace-only string clears the stored value — values are trimmed before storing.",
        properties: {
          displayName: {
            type: "string",
            maxLength: 80,
            nullable: true,
          },
          bio: { type: "string", maxLength: 300, nullable: true },
          avatarUrl: {
            type: "string",
            format: "uri",
            pattern: "^https://",
            nullable: true,
          },
          email: { type: "string", format: "email", nullable: true },
        },
      },
      UpdateSplitsRequest: {
        type: "object",
        properties: {
          splits: {
            type: "array",
            minItems: 1,
            description:
              "Recipients must be unique, and total basis points must not exceed 10000.",
            items: schema("Split"),
          },
        },
        required: ["splits"],
      },
      RenameSlugRequest: {
        type: "object",
        properties: {
          slug: { type: "string", minLength: 3, maxLength: 32 },
        },
        required: ["slug"],
      },
      MessageVisibilityRequest: {
        type: "object",
        properties: {
          hidden: {
            type: "boolean",
            description: "true hides the message; false shows it again.",
          },
        },
        required: ["hidden"],
      },
      TipMessageVisibilityResponse: {
        type: "object",
        properties: {
          tip: {
            type: "object",
            properties: {
              id: { type: "string" },
              messageHidden: { type: "boolean" },
            },
            required: ["id", "messageHidden"],
          },
        },
        required: ["tip"],
      },
      ResolveResponse: {
        type: "object",
        properties: {
          creator: schema("PublicCreator"),
          tipUrl: { type: "string", format: "uri" },
          qrSvgUrl: { type: "string" },
          qrPngUrl: { type: "string" },
        },
        required: ["creator", "tipUrl", "qrSvgUrl", "qrPngUrl"],
      },
      TipTotalsResponse: {
        type: "object",
        properties: {
          totalTips: { type: "integer" },
          totalAmountRaw: { type: "string" },
          uniqueSupporters: { type: "integer" },
        },
        required: ["totalTips", "totalAmountRaw", "uniqueSupporters"],
      },
      TimeSeriesPoint: {
        type: "object",
        properties: {
          date: { type: "string", format: "date" },
          tipCount: { type: "integer" },
          amountRaw: { type: "string" },
        },
        required: ["date", "tipCount", "amountRaw"],
      },
      TimeSeriesResponse: {
        type: "object",
        properties: {
          series: { type: "array", items: schema("TimeSeriesPoint") },
        },
        required: ["series"],
      },
      TopSupporter: {
        type: "object",
        properties: {
          fromAddress: { type: "string" },
          tipCount: { type: "integer" },
          totalAmountRaw: { type: "string" },
        },
        required: ["fromAddress", "tipCount", "totalAmountRaw"],
      },
      TopSupportersResponse: {
        type: "object",
        properties: {
          supporters: { type: "array", items: schema("TopSupporter") },
        },
        required: ["supporters"],
      },
      RecentTip: {
        type: "object",
        properties: {
          id: { type: "string" },
          txHash: { type: "string" },
          fromAddress: { type: "string" },
          amount: { type: "string" },
          message: { type: "string" },
          ledgerAt: { type: "string", format: "date-time" },
        },
        required: [
          "id",
          "txHash",
          "fromAddress",
          "amount",
          "message",
          "ledgerAt",
        ],
      },
      PublicTip: {
        type: "object",
        properties: {
          txHash: { type: "string" },
          fromAddress: { type: "string" },
          amount: { type: "string" },
          message: { type: "string" },
          ledgerAt: { type: "string", format: "date-time" },
        },
        required: ["txHash", "fromAddress", "amount", "message", "ledgerAt"],
      },
      RecentTipsResponse: {
        type: "object",
        properties: {
          tips: { type: "array", items: schema("RecentTip") },
          nextCursor: { type: "string", nullable: true },
        },
        required: ["tips", "nextCursor"],
      },
      PublicTipsResponse: {
        type: "object",
        properties: {
          tips: { type: "array", items: schema("PublicTip") },
          nextCursor: { type: "string", nullable: true },
        },
        required: ["tips", "nextCursor"],
      },
      Collaborator: {
        type: "object",
        properties: {
          to: { type: "string" },
          bps: { type: "integer" },
          sharePercent: { type: "string" },
          totalEarnedRaw: { type: "string" },
        },
        required: ["to", "bps", "sharePercent", "totalEarnedRaw"],
      },
      CollaboratorBreakdownResponse: {
        type: "object",
        properties: {
          tipCount: { type: "integer" },
          totalAmountRaw: { type: "string" },
          unallocatedRaw: { type: "string" },
          collaborators: {
            type: "array",
            items: schema("Collaborator"),
          },
          basis: {
            type: "object",
            properties: {
              mode: { type: "string", enum: ["current-splits"] },
              splitsUpdatedAt: { type: "string", format: "date-time" },
              impliedOwnerSplit: { type: "boolean" },
              note: { type: "string" },
            },
            required: ["mode", "splitsUpdatedAt", "impliedOwnerSplit", "note"],
          },
        },
        required: [
          "tipCount",
          "totalAmountRaw",
          "unallocatedRaw",
          "collaborators",
          "basis",
        ],
      },
      CreateWebhookRequest: {
        type: "object",
        properties: {
          url: { type: "string", format: "uri", pattern: "^https://" },
          secret: { type: "string", minLength: 16 },
        },
        required: ["url"],
      },
      RotateWebhookSecretRequest: {
        type: "object",
        properties: { secret: { type: "string", minLength: 16 } },
      },
      SetWebhookEnabledRequest: {
        type: "object",
        properties: { enabled: { type: "boolean" } },
        required: ["enabled"],
      },
      Webhook: {
        type: "object",
        properties: {
          id: { type: "string" },
          url: { type: "string", format: "uri" },
          enabled: { type: "boolean" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
        required: ["id", "url", "enabled", "createdAt", "updatedAt"],
      },
      CreatedWebhook: {
        allOf: [
          {
            type: "object",
            properties: {
              id: { type: "string" },
              creatorId: { type: "string" },
              url: { type: "string", format: "uri" },
              enabled: { type: "boolean" },
              secret: { type: "string" },
              createdAt: { type: "string", format: "date-time" },
              updatedAt: { type: "string", format: "date-time" },
            },
            required: [
              "id",
              "creatorId",
              "url",
              "enabled",
              "secret",
              "createdAt",
              "updatedAt",
            ],
          },
        ],
      },
      RotatedWebhook: {
        allOf: [
          schema("Webhook"),
          {
            type: "object",
            properties: { secret: { type: "string" } },
            required: ["secret"],
          },
        ],
      },
      WebhookResponse: {
        type: "object",
        properties: { webhook: schema("Webhook") },
        required: ["webhook"],
      },
      CreatedWebhookResponse: {
        type: "object",
        properties: { webhook: schema("CreatedWebhook") },
        required: ["webhook"],
      },
      RotatedWebhookResponse: {
        type: "object",
        properties: { webhook: schema("RotatedWebhook") },
        required: ["webhook"],
      },
      WebhookListResponse: {
        type: "object",
        properties: {
          webhooks: { type: "array", items: schema("Webhook") },
        },
        required: ["webhooks"],
      },
      DeliveryOutcome: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          statusCode: { type: "integer", nullable: true },
          response: { type: "string", nullable: true },
          attemptedAt: { type: "string", format: "date-time" },
        },
        required: ["success", "statusCode", "response", "attemptedAt"],
      },
      WebhookDeliveriesResponse: {
        type: "object",
        properties: {
          deliveries: {
            type: "array",
            items: schema("WebhookDelivery"),
          },
        },
        required: ["deliveries"],
      },
      WebhookPingResponse: {
        type: "object",
        properties: { delivery: schema("DeliveryOutcome") },
        required: ["delivery"],
      },
      WebhookDelivery: {
        type: "object",
        properties: {
          id: { type: "string" },
          statusCode: { type: "integer", nullable: true },
          success: { type: "boolean" },
          response: { type: "string", nullable: true },
          attemptedAt: { type: "string", format: "date-time" },
        },
        required: ["id", "statusCode", "success", "response", "attemptedAt"],
      },
      HealthVersionResponse: {
        type: "object",
        properties: {
          version: { type: "string" },
          commit: { type: "string" },
          network: { type: "string" },
        },
        required: ["version", "commit", "network"],
      },
      Notification: {
        type: "object",
        properties: {
          id: { type: "string" },
          type: { type: "string", enum: ["TIP_RECEIVED", "WEBHOOK_FAILED"] },
          payload: {
            nullable: true,
            oneOf: [
              { type: "object", additionalProperties: true },
              { type: "array", items: {} },
            ],
          },
          sent: { type: "boolean" },
          sentAt: { type: "string", format: "date-time", nullable: true },
          createdAt: { type: "string", format: "date-time" },
        },
        required: [
          "id",
          "type",
          "payload",
          "sent",
          "sentAt",
          "createdAt",
        ],
      },
      NotificationListResponse: {
        type: "object",
        properties: {
          notifications: { type: "array", items: schema("Notification") },
        },
        required: ["notifications"],
      },
      NotificationPreferences: {
        type: "object",
        properties: {
          emailEnabled: { type: "boolean" },
          webhookEnabled: { type: "boolean" },
        },
        required: ["emailEnabled", "webhookEnabled"],
      },
      NotificationPreferencesResponse: {
        type: "object",
        properties: { preferences: schema("NotificationPreferences") },
        required: ["preferences"],
      },
      UpdateNotificationPreferencesRequest: {
        type: "object",
        properties: {
          preferences: {
            type: "object",
            properties: {
              emailEnabled: { type: "boolean" },
              webhookEnabled: { type: "boolean" },
            },
          },
        },
        required: ["preferences"],
      },
    },
  },
} as const;
