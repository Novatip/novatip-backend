/**
 * __tests__/creator/claim-body-trim.test.ts
 *
 * Tests that ClaimBody's displayName and bio fields use the same trimming
 * and empty-as-null behavior as UpdateProfileBody. This ensures consistency
 * across POST /creators/claim and PATCH /creators/me for the same fields.
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import Fastify, { type FastifyInstance } from "fastify";
import jwtPlugin from "@fastify/jwt";
import { db } from "../../db.js";
import { creatorRoutes } from "../../modules/creator/creator.routes.js";

describe("ClaimBody field trimming", () => {
  let app: FastifyInstance;
  let creatorId: string;
  let token: string;

  beforeEach(async () => {
    app = Fastify();
    await app.register(jwtPlugin, {
      secret: process.env["JWT_SECRET"] || "test-secret-at-least-32-chars-long-123456",
    });

    // Mock authenticate
    app.decorate("authenticate", async (request: any) => {
      await request.jwtVerify();
    });

    await app.register(creatorRoutes, { prefix: "/creators" });

    // Create a placeholder creator
    const creator = await db.creator.create({
      data: {
        walletAddress: "GTRIM123",
        slug: "user_trimtest",
        jarId: "@user_trimtest",
      },
    });
    creatorId = creator.id;

    token = app.jwt.sign({ sub: creatorId });
  });

  afterEach(async () => {
    await app.close();
  });

  it("should trim whitespace from displayName", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/creators/claim",
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        slug: "trimmed-display",
        displayName: "  Alice  ",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.creator.displayName).toBe("Alice");
  });

  it("should trim whitespace from bio", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/creators/claim",
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        slug: "trimmed-bio",
        bio: "  Hello there  ",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.creator.bio).toBe("Hello there");
  });

  it("should treat whitespace-only displayName as null", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/creators/claim",
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        slug: "empty-display",
        displayName: "   ",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.creator.displayName).toBeNull();
  });

  it("should treat whitespace-only bio as null", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/creators/claim",
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        slug: "empty-bio",
        bio: "   ",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.creator.bio).toBeNull();
  });

  it("should treat empty string displayName as null", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/creators/claim",
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        slug: "empty-string-display",
        displayName: "",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.creator.displayName).toBeNull();
  });

  it("should treat empty string bio as null", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/creators/claim",
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        slug: "empty-string-bio",
        bio: "",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.creator.bio).toBeNull();
  });

  it("should match PATCH /creators/me behavior for trimming", async () => {
    // First claim with padded values
    const claimResponse = await app.inject({
      method: "POST",
      url: "/creators/claim",
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        slug: "consistency-test",
        displayName: "  Bob  ",
        bio: "  Developer  ",
      },
    });

    expect(claimResponse.statusCode).toBe(201);
    const claimBody = JSON.parse(claimResponse.body);
    expect(claimBody.creator.displayName).toBe("Bob");
    expect(claimBody.creator.bio).toBe("Developer");

    // Now update with the same padded values
    const updateResponse = await app.inject({
      method: "PATCH",
      url: "/creators/me",
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        displayName: "  Bob  ",
        bio: "  Developer  ",
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    const updateBody = JSON.parse(updateResponse.body);
    expect(updateBody.creator.displayName).toBe("Bob");
    expect(updateBody.creator.bio).toBe("Developer");

    // The values should match
    expect(updateBody.creator.displayName).toBe(claimBody.creator.displayName);
    expect(updateBody.creator.bio).toBe(claimBody.creator.bio);
  });
});
