/**
 * scripts/rotate-webhook-key.ts
 *
 * Rotates stored webhook secrets from an old encryption key to a new one.
 *
 * Usage:
 *   npx tsx scripts/rotate-webhook-key.ts <old-key-hex> [new-key-hex]
 *
 * Or using environment variables:
 *   OLD_WEBHOOK_ENCRYPTION_KEY=<hex> [WEBHOOK_ENCRYPTION_KEY=<hex>] npx tsx scripts/rotate-webhook-key.ts
 */

import { rotateWebhookSecrets } from "../src/modules/webhooks/webhooks.service.js";
import { disconnectDb } from "../src/db.js";

const oldKey = process.argv[2] ?? process.env["OLD_WEBHOOK_ENCRYPTION_KEY"];
const newKey =
  process.argv[3] ??
  process.env["NEW_WEBHOOK_ENCRYPTION_KEY"] ??
  process.env["WEBHOOK_ENCRYPTION_KEY"];

if (!oldKey) {
  console.error(
    "Usage: npx tsx scripts/rotate-webhook-key.ts <old-key-hex> [new-key-hex]",
  );
  process.exit(1);
}

try {
  const result = await rotateWebhookSecrets(oldKey, newKey);
  console.log(
    `Key rotation complete: ${result.rotated}/${result.total} secrets rotated (${result.failed} failed).`,
  );
  await disconnectDb();
  if (result.failed > 0) {
    process.exit(1);
  }
} catch (err) {
  console.error("Key rotation failed:", err);
  await disconnectDb();
  process.exit(1);
}
