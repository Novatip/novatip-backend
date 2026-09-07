/**
 * scripts/check-reserved-slugs.ts
 *
 * Reports any existing creators whose slug now falls in RESERVED_SLUGS
 * (src/modules/creator/creator.service.ts). Those slugs were claimable
 * before the reserved-slug list existed, so run this once against
 * production before/after deploying that change and note the results
 * in the PR — the list only blocks new claims, it doesn't touch rows
 * that already hold one of these slugs.
 *
 *   npx tsx scripts/check-reserved-slugs.ts
 */

import { PrismaClient } from "@prisma/client";
import { RESERVED_SLUGS } from "../src/modules/creator/creator.service.js";

const db = new PrismaClient();

async function main(): Promise<void> {
  const creators = await db.creator.findMany({
    where: { slug: { in: [...RESERVED_SLUGS] } },
    select: { id: true, slug: true, walletAddress: true, createdAt: true },
  });

  if (creators.length === 0) {
    console.info("No existing creators hold a reserved slug.");
    return;
  }

  console.warn(`${creators.length} existing creator(s) hold a now-reserved slug:`);
  for (const creator of creators) {
    console.warn(`  ${creator.slug} — ${creator.id} (${creator.walletAddress}, created ${creator.createdAt.toISOString()})`);
  }
}

main()
  .catch((err) => {
    console.error("check-reserved-slugs failed:", err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
