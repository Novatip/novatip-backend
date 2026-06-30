/**
 * app.ts
 * Application entry point. Builds the Fastify server, starts the indexer,
 * and begins listening.
 */
import "dotenv/config";
import { buildServer } from "./server.js";
import { config } from "./config.js";
import { startIndexer, stopIndexer } from "./indexer/indexer.js";

const server = await buildServer();

// Start the Soroban event indexer in the background
startIndexer().catch((err) => {
  server.log.error(err, "[indexer] fatal startup error");
});

// Graceful shutdown
const shutdown = async (): Promise<void> => {
  server.log.info("Shutting down...");
  stopIndexer();
  await server.close();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT",  shutdown);

try {
  await server.listen({ port: config.port, host: config.host });
  server.log.info(`novatip-backend listening on ${config.host}:${config.port}`);
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
