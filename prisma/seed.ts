/**
 * prisma/seed.ts
 *
 * Seeds one creator so a fresh clone has something to look at: the tip page at
 * /demo, the QR endpoints, and the resolver all need a creator row to exist.
 *
 * The slug and jarId match the `@demo` jar registered on the testnet contract
 * in the README's deployment table, so the splits below mirror what is actually
 * on-chain. Re-running is safe — it upserts.
 *
 *   npm run db:seed
 */

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

/** Owner of the on-chain @demo jar. */
const DEMO_WALLET = "GBASZB2BGT6WYIQ57PSXBNLK5PUH5W3ASRUS4DZHHHJW3YQ5ZWGASJJ5";

/** The @demo jar's recipients, 70/30 — same values the contract holds. */
const DEMO_SPLITS = [
  { to: "GD7UXR3IX276M2M4XUE3TPNKTA7PJTERTEDEGWELQQYQBBHDL2NTREFR", bps: 7000 },
  { to: "GDE6TLQE77OGAPXORP5G5YLRG4FQE2D7ZCD237LVLTAALXAOVV3YTPDS", bps: 3000 },
];

async function main(): Promise<void> {
  const creator = await db.creator.upsert({
    where: { walletAddress: DEMO_WALLET },
    update: {
      slug: "demo",
      jarId: "@demo",
      splits: DEMO_SPLITS,
    },
    create: {
      walletAddress: DEMO_WALLET,
      slug: "demo",
      jarId: "@demo",
      displayName: "Demo Creator",
      bio: "A two-person split jar on Stellar testnet. Tips divide 70/30, atomically.",
      splits: DEMO_SPLITS,
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
