/**
 * scripts/check-migration-timestamps.ts
 *
 * Fails if any directory under prisma/migrations lacks a 14-digit
 * <YYYYMMDDHHMMSS>_<description> prefix or shares a timestamp prefix with
 * another migration directory.
 *
 *   npx tsx scripts/check-migration-timestamps.ts
 */

import { readdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "prisma/migrations");
const MIGRATION_DIR_RE = /^(\d{14})_(.+)$/;

const entries = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const malformed: string[] = [];
const byTimestamp = new Map<string, string[]>();

for (const name of entries) {
  const match = name.match(MIGRATION_DIR_RE);
  if (!match?.[1]) {
    malformed.push(name);
    continue;
  }

  const timestamp = match[1];
  const existing = byTimestamp.get(timestamp);
  if (existing) {
    existing.push(name);
  } else {
    byTimestamp.set(timestamp, [name]);
  }
}

const collisions = [...byTimestamp.entries()].filter(
  ([, dirs]) => dirs.length > 1,
);

if (malformed.length > 0) {
  console.error(
    "prisma/migrations contains directories without a 14-digit timestamp prefix:",
  );
  for (const name of malformed) console.error(`  ${name}`);
}

if (collisions.length > 0) {
  console.error(
    "prisma/migrations contains directories sharing the same timestamp prefix:",
  );
  for (const [timestamp, dirs] of collisions) {
    console.error(`  ${timestamp}: ${dirs.join(", ")}`);
  }
}

if (malformed.length > 0 || collisions.length > 0) {
  process.exitCode = 1;
} else {
  console.info(
    `All ${entries.length} Prisma migration directories have unique timestamp prefixes.`,
  );
}
