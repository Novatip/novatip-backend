/**
 * prisma/seed.ts
 *
 * Seeds one creator so a fresh clone has something to look at: the tip page at
 * /demo, the QR endpoints, and the resolver all need a creator row to exist.
 *
 * These are local fixture values, not a record of a jar on any shared
 * deployment — the README has you deploy your own testnet contract (see "Run
 * against a freshly deployed testnet contract"), so nothing is registered there
 * until you do it. For the indexer to attribute tips to this creator, register
 * a `@demo` jar on your contract with the owner and 70/30 splits below.
 * Re-running is safe — it upserts.
 *
 *   npm run db:seed
 */

import { PrismaClient } from "@prisma/client";
import { CreatorSplitsSchema } from "../src/modules/creator/creator-splits.schema.js";

const db = new PrismaClient();

/** Owner of the @demo jar. */
const DEMO_WALLET = "GBASZB2BGT6WYIQ57PSXBNLK5PUH5W3ASRUS4DZHHHJW3YQ5ZWGASJJ5";

/** The @demo jar's recipients, 70/30. */
const DEMO_SPLITS = [
  { to: "GD7UXR3IX276M2M4XUE3TPNKTA7PJTERTEDEGWELQQYQBBHDL2NTREFR", bps: 7000 },
  { to: "GDE6TLQE77OGAPXORP5G5YLRG4FQE2D7ZCD237LVLTAALXAOVV3YTPDS", bps: 3000 },
];

async function main(): Promise<void> {
  const validatedSplits = CreatorSplitsSchema.parse(DEMO_SPLITS);

  const creator = await db.creator.upsert({
    where: { walletAddress: DEMO_WALLET },
    update: {
      slug: "demo",
      jarId: "@demo",
      splits: validatedSplits,
    },
    create: {
      walletAddress: DEMO_WALLET,
      slug: "demo",
      jarId: "@demo",
      displayName: "Demo Creator",
      bio: "A two-person split jar on Stellar testnet. Tips divide 70/30, atomically.",
      splits: validatedSplits,
    },
  });

  console.info(`seeded creator ${creator.slug} (jar ${creator.jarId})`);
}

main()
  .catch((err) => {
    console.error("seed failed:", err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
