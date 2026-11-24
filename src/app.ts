/**
 * app.ts
 * Application entry point. Builds the Fastify server, starts the indexer,
 * and begins listening.
 */
import "dotenv/config";
import { buildServer } from "./server.js";
import { config } from "./config.js";
import { startIndexer, stopIndexer } from "./indexer/indexer.js";
import {
  startUnownedTipPruner,
  stopUnownedTipPruner,
} from "./indexer/persist.js";
import {
  startDeliveryPruner,
  stopDeliveryPruner,
} from "./modules/webhooks/retention.js";
import {
  startTipDigestScheduler,
  stopTipDigestScheduler,
} from "./modules/notifications/email.service.js";
import {
  startPlaceholderCreatorPruner,
  stopPlaceholderCreatorPruner,
} from "./modules/creator/placeholder-retention.js";
import { migrateWebhookSecrets } from "./modules/webhooks/webhooks.service.js";

await migrateWebhookSecrets();
const server = await buildServer();

// Start the Soroban event indexer in the background
startIndexer().catch((err) => {
  server.log.error(err, "[indexer] fatal startup error");
  process.exit(1);
});

// Age out old webhook delivery rows on a schedule
startDeliveryPruner();
startTipDigestScheduler();

// Age out abandoned sign-in placeholders on a schedule
startPlaceholderCreatorPruner();

// Age out unowned tips on a schedule
startUnownedTipPruner();

// Graceful shutdown
const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Set once the first signal arrives, so a second SIGTERM/SIGINT (a common
 * double-tap from process managers, or an impatient operator) joins the
 * shutdown already running instead of starting a second one that would race
 * it for the same database connection and the same indexer loop.
 */
let shuttingDown: Promise<void> | null = null;

const shutdown = (): Promise<void> => {
  if (shuttingDown) return shuttingDown;

  shuttingDown = (async () => {
    server.log.info("Shutting down...");
    stopDeliveryPruner();
    stopTipDigestScheduler();
    stopPlaceholderCreatorPruner();
    stopUnownedTipPruner();

    // Forces the process to exit even if the indexer's current iteration or
    // the server's close hooks hang — a stuck shutdown should not block the
    // exit forever. Cleared below on the normal path.
    const timer = setTimeout(() => {
      server.log.error("shutdown timed out — forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    try {
      // Waits for the indexer's in-flight iteration — persist, webhooks,
      // email — to finish before the server's onClose hook below disconnects
      // Prisma and Redis out from underneath it.
      await stopIndexer();
      await server.close();
      clearTimeout(timer);
      process.exit(0);
    } catch (err) {
      clearTimeout(timer);
      server.log.error({ err }, "error during shutdown");
      process.exit(1);
    }
  })();

  return shuttingDown;
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

try {
  await server.listen({ port: config.port, host: config.host });
  server.log.info(`novatip-backend listening on ${config.host}:${config.port}`);
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
