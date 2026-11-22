/**
 * __tests__/creator/claim-rename-atomicity.test.ts
 *
 * Tests that claimSlug and renameSlug commit all their writes atomically.
 * Specifically: if the follow-up work (tip back-attribution, slug release
 * recording) fails, the primary write (creator.update) must not be left in
 * an inconsistent state.
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import { db } from "../../db.js";
import { claimSlug, renameSlug } from "../../modules/creator/creator.service.js";

describe("claimSlug and renameSlug atomicity", () => {
  let creatorId: string;
  let placeholderSlug: string;

  beforeEach(async () => {
    const creator = await db.creator.create({
      data: {
        walletAddress: "GATOMICITY123",
        slug: "user_atomtest",
        jarId: "@user_atomtest",
      },
    });
    creatorId = creator.id;
    placeholderSlug = creator.slug;
  });

  it("should commit creator update and tip back-attribution atomically in claimSlug", async () => {
    const newSlug = "claimed-slug";
    const newJarId = `@${newSlug}`;

    // Create a tip that arrived before the slug was claimed
    await db.tip.create({
      data: {
        id: "tip_unattributed",
        tipperWallet: "GTIPPER111",
        amount: "10000000",
        jarId: newJarId,
        creatorId: null,
        signature: "sig_test",
      },
    });

    const creator = await claimSlug({
      creatorId,
      slug: newSlug,
      jarId: newJarId,
    });

    // After claim, the creator should have the new slug
    expect(creator.slug).toBe(newSlug);
    expect(creator.jarId).toBe(newJarId);

    // And the tip should be back-attributed to the creator
    const tip = await db.tip.findUnique({
      where: { id: "tip_unattributed" },
    });
    expect(tip?.creatorId).toBe(creatorId);
  });

  it("should commit creator update and old slug release atomically in claimSlug when switching slugs", async () => {
    // First claim
    await claimSlug({
      creatorId,
      slug: "firstslug",
    });

    // Now claim a different slug
    const creator = await claimSlug({
      creatorId,
      slug: "secondslug",
    });

    expect(creator.slug).toBe("secondslug");

    // The old slug should have a release record
    const release = await db.releasedSlug.findUnique({
      where: { slug: "firstslug" },
    });
    expect(release).not.toBeNull();
    expect(release?.previousOwnerId).toBe(creatorId);
  });

  it("should commit creator rename and slug release atomically in renameSlug", async () => {
    // First claim a slug
    await claimSlug({
      creatorId,
      slug: "original-slug",
    });

    // Now rename it
    const creator = await renameSlug({
      creatorId,
      slug: "renamed-slug",
    });

    expect(creator.slug).toBe("renamed-slug");

    // The old slug should have a release record
    const release = await db.releasedSlug.findUnique({
      where: { slug: "original-slug" },
    });
    expect(release).not.toBeNull();
    expect(release?.previousOwnerId).toBe(creatorId);
  });

  it("should not release a slug when renaming to the same slug", async () => {
    await claimSlug({
      creatorId,
      slug: "same-slug",
    });

    const creator = await renameSlug({
      creatorId,
      slug: "same-slug",
    });

    expect(creator.slug).toBe("same-slug");

    // No release record should be created
    const release = await db.releasedSlug.findUnique({
      where: { slug: "same-slug" },
    });
    expect(release).toBeNull();
  });
});
