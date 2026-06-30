/**
 * db.ts
 *
 * Prisma client singleton.
 * Import `db` anywhere in the app — a single connection pool is shared
 * across the entire process lifetime.
 *
 * @example
 * import { db } from "./db.js";
 * const creator = await db.creator.findUnique({ where: { slug: "alice" } });
 */

import { PrismaClient } from "@prisma/client";
import { config } from "./config.js";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      config.nodeEnv === "development"
        ? ["query", "warn", "error"]
        : ["warn", "error"],
    datasources: {
      db: { url: config.databaseUrl },
    },
  });

// In development, reuse the client across hot reloads to avoid
// exhausting the PostgreSQL connection pool.
if (config.nodeEnv !== "production") {
  globalForPrisma.prisma = db;
}

/**
 * Gracefully disconnect Prisma on process shutdown.
 * Called by the Fastify onClose hook in server.ts.
 */
export async function disconnectDb(): Promise<void> {
  await db.$disconnect();
}
