/**
 * scripts/check-env-docs.ts
 *
 * Fails if any env var src/config.ts reads has no line in README.md's
 * Environment Variables section, if a required one isn't marked "(required)"
 * there, or if docker-compose.yml's JWT secret is shorter than config.ts allows.
 * Environment Variables section, or if a required one isn't marked
 * "(required)" there. Also fails if any such var has no line in
 * .env.example — the file the README tells people to copy — whether or not
 * that line is commented out (CORS_ALLOWED_ORIGINS has no single literal
 * default, so it is documented there as a commented example).
 *
 * config.ts reads more variables than the README used to list — the four
 * webhook retention settings, HORIZON_URL, NETWORK_PASSPHRASE,
 * USDC_CONTRACT_ID and INDEXER_START_LEDGER among them — so anyone deploying
 * had to read config.ts itself to find out what they could set. Likewise
 * .env.example had fallen behind config.ts by four variables (three indexer
 * settings and CORS_ALLOWED_ORIGINS) before this script checked it. Both
 * lists are hand-written, not generated, so this script is what keeps them
 * checked against config.ts instead of silently drifting from it again the
 * next time a variable is added.
 *
 * Deliberately does not check that the *default value* in the README prose
 * or .env.example matches config.ts's fallback byte-for-byte — that would
 * mean parsing arbitrary expressions (CORS_ALLOWED_ORIGINS's fallback is
 * `[appBaseUrl]`, not a literal). Presence (and, for README, the (required)
 * marker) are what this catches; a stale default is a slower-burning,
 * lower-stakes problem than an undocumented variable.
 *
 *   npx tsx scripts/check-env-docs.ts
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const configSource = readFileSync(join(root, "src/config.ts"), "utf8");
const readme = readFileSync(join(root, "README.md"), "utf8");
const compose = readFileSync(join(root, "docker-compose.yml"), "utf8");
const envExample = readFileSync(join(root, ".env.example"), "utf8");

// Longest alternative first. Regex alternation does backtrack to a later,
// longer option when an earlier one fails, so "optional" before
// "optionalInt" would still match "optionalInt(" correctly here — the
// ordering below is just the safer habit, not load-bearing for correctness.
const CALL_RE =
  /\b(optionalIntDeprecatedFallback|optionalList|optionalBoolean|optionalInt|optional|require)\(\s*"([A-Z][A-Z0-9_]*)"/g;

const vars = new Map<string, { required: boolean }>();
for (const [, fn, key] of configSource.matchAll(CALL_RE)) {
  vars.set(key!, { required: fn === "require" });
}

const missingFromReadme: string[] = [];
const unmarkedRequired: string[] = [];
const missingFromEnvExample: string[] = [];

for (const [key, { required }] of vars) {
  const line = readme.match(new RegExp(`^${key}\\b.*$`, "m"))?.[0];

  if (!line) {
    missingFromReadme.push(key);
  } else if (required && !line.includes("(required)")) {
    unmarkedRequired.push(key);
  }

  if (!new RegExp(`^#?\\s*${key}=`, "m").test(envExample)) {
    missingFromEnvExample.push(key);
  }
}

const minimumJwtSecretMatch = configSource.match(
  /const MIN_JWT_SECRET_LENGTH = (\d+);/,
);
const minimumJwtSecretLength = Number(minimumJwtSecretMatch?.[1]);
const composeJwtSecret = compose
  .match(/^[ \t]*JWT_SECRET:[ \t]*([^\r\n#]*)/m)?.[1]
  ?.trim()
  .replace(/^(['"])(.*)\1$/, "$2");

let invalidComposeJwtSecret = false;
if (!Number.isSafeInteger(minimumJwtSecretLength) || minimumJwtSecretLength < 1) {
  console.error("Could not read the minimum JWT secret length from config.ts.");
  invalidComposeJwtSecret = true;
} else if (!composeJwtSecret) {
  console.error("docker-compose.yml does not configure JWT_SECRET.");
  invalidComposeJwtSecret = true;
} else if (
  !composeJwtSecret.startsWith("${JWT_SECRET:?") &&
  composeJwtSecret.length < minimumJwtSecretLength
) {
  console.error(
    `docker-compose.yml JWT_SECRET must be at least ${minimumJwtSecretLength} characters ` +
      `(got ${composeJwtSecret.length}).`,
  );
  invalidComposeJwtSecret = true;
}

if (missingFromReadme.length > 0) {
  console.error("README.md is missing these env vars that config.ts reads:");
  for (const key of missingFromReadme) console.error(`  ${key}`);
}
if (unmarkedRequired.length > 0) {
  console.error(
    'These required env vars are not marked "(required)" in README.md:',
  );
  for (const key of unmarkedRequired) console.error(`  ${key}`);
}
if (missingFromEnvExample.length > 0) {
  console.error(
    ".env.example is missing these env vars that config.ts reads:",
  );
  for (const key of missingFromEnvExample) console.error(`  ${key}`);
}

if (
  missingFromReadme.length > 0 ||
  unmarkedRequired.length > 0 ||
  missingFromEnvExample.length > 0 ||
  invalidComposeJwtSecret
) {
  process.exitCode = 1;
} else {
  console.info(
    `All ${vars.size} env vars config.ts reads are documented in README.md and .env.example.`,
  );
}
