/**
 * app.ts
 * Application entry point. Builds the Fastify server and starts listening.
 */
import "dotenv/config";
import { buildServer } from "./server.js";
import { config } from "./config.js";

const server = await buildServer();

try {
  await server.listen({ port: config.port, host: config.host });
  server.log.info(`novatip-backend listening on ${config.host}:${config.port}`);
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
