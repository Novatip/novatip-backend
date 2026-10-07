/**
 * __tests__/webhooks/fake-db.helper.ts
 *
 * A small in-memory stand-in for the Prisma client, covering the handful of
 * delegate calls the webhook service actually makes.
 *
 * CI runs no PostgreSQL, so the webhook suites mock ../../db.js rather than
 * talking to a database. The behaviour under test is the service's own
 * logic — which rows it scopes a write to, what it returns when it matches
 * nothing, which webhooks a dispatch reaches — and that is all expressible
 * against a Map.
 *
 * The fake deliberately enforces the `where` clauses rather than ignoring
 * them: the whole point of `updateMany({ where: { id, creatorId } })` is that
 * the creatorId is part of the predicate, and a double that dropped it would
 * let an ownership bug pass.
 *
 * Not a test file — see the `.helper.ts` entry in jest.config.mjs's
 * testPathIgnorePatterns.
 */

// ── Row shapes ────────────────────────────────────────────────────────────────

export interface FakeWebhook {
  id: string;
  creatorId: string;
  url: string;
  secret: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakeCreator {
  id: string;
  jarId: string;
}

export interface FakeDelivery {
  id: string;
  webhookId: string;
  statusCode: number | null;
  success: boolean;
  payload: object;
  response: string | null;
  attemptedAt: Date;
}

// ── Argument shapes ───────────────────────────────────────────────────────────

type Select = Record<string, boolean>;
type OrderBy = Record<string, "asc" | "desc">;

interface WebhookWhere {
  id?: string;
  creatorId?: string;
}

interface Projected {
  [key: string]: unknown;
}

/**
 * Apply a Prisma `select` to a row. An absent select returns the row whole,
 * which is what Prisma does.
 */
function project(row: object, select?: Select): Projected {
  const source = row as Projected;
  if (select === undefined) return { ...source };

  const out: Projected = {};
  for (const [key, wanted] of Object.entries(select)) {
    if (wanted) out[key] = source[key];
  }
  return out;
}

/** Sort by the single key a Prisma `orderBy` object carries. */
function sortBy<T extends object>(rows: T[], orderBy?: OrderBy): T[] {
  if (orderBy === undefined) return rows;

  const entry = Object.entries(orderBy)[0];
  if (entry === undefined) return rows;
  const [key, direction] = entry;

  return [...rows].sort((a, b) => {
    const left = (a as Projected)[key];
    const right = (b as Projected)[key];
    const lhs = left instanceof Date ? left.getTime() : Number(left);
    const rhs = right instanceof Date ? right.getTime() : Number(right);
    return direction === "desc" ? rhs - lhs : lhs - rhs;
  });
}

function matches(row: FakeWebhook, where: WebhookWhere): boolean {
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.creatorId !== undefined && row.creatorId !== where.creatorId) {
    return false;
  }
  return true;
}

// ── The fake ──────────────────────────────────────────────────────────────────

export interface FakeDb {
  /** Passed to jest.unstable_mockModule as the `db` export. */
  db: unknown;
  webhooks: Map<string, FakeWebhook>;
  deliveries: FakeDelivery[];
  creators: Map<string, FakeCreator>;
  seedCreator(creator: Partial<FakeCreator> & { id: string }): FakeCreator;
  seedWebhook(
    webhook: Partial<FakeWebhook> & { creatorId: string },
  ): FakeWebhook;
  seedDelivery(
    delivery: Partial<FakeDelivery> & { webhookId: string },
  ): FakeDelivery;
}

export function createFakeDb(): FakeDb {
  const webhooks = new Map<string, FakeWebhook>();
  const creators = new Map<string, FakeCreator>();
  const deliveries: FakeDelivery[] = [];

  let sequence = 0;
  const nextId = (prefix: string): string => `${prefix}_${++sequence}`;

  /**
   * Monotonic clock for createdAt/attemptedAt. Real timestamps collide at
   * millisecond resolution when a test seeds several rows in a loop, and a
   * "newest first" assertion against colliding timestamps proves nothing.
   */
  let clock = Date.UTC(2026, 0, 1);
  const tick = (): Date => new Date((clock += 1_000));

  const db = {
    webhook: {
      create: async ({
        data,
      }: {
        data: { creatorId: string; url: string; secret: string };
      }): Promise<FakeWebhook> => {
        const now = tick();
        const row: FakeWebhook = {
          id: nextId("wh"),
          creatorId: data.creatorId,
          url: data.url,
          secret: data.secret,
          enabled: true,
          createdAt: now,
          updatedAt: now,
        };
        webhooks.set(row.id, row);
        return row;
      },

      findMany: async ({
        where,
        orderBy,
        take,
        skip,
        select,
      }: {
        where: WebhookWhere;
        orderBy?: OrderBy;
        take?: number;
        skip?: number;
        select?: Select;
      }): Promise<Projected[]> => {
        const found = sortBy(
          [...webhooks.values()].filter((row) => matches(row, where)),
          orderBy,
        );
        const start = skip ?? 0;
        const page =
          take === undefined
            ? found.slice(start)
            : found.slice(start, start + take);
        return page.map((row) => project(row, select));
      },

      count: async ({ where }: { where: WebhookWhere }): Promise<number> =>
        [...webhooks.values()].filter((row) => matches(row, where)).length,

      findFirst: async ({
        where,
        select,
      }: {
        where: WebhookWhere;
        select?: Select;
      }): Promise<Projected | null> => {
        const row = [...webhooks.values()].find((candidate) =>
          matches(candidate, where),
        );
        return row === undefined ? null : project(row, select);
      },

      findUnique: async ({
        where,
        select,
      }: {
        where: { id: string };
        select?: Select;
      }): Promise<Projected | null> => {
        const row = webhooks.get(where.id);
        return row === undefined ? null : project(row, select);
      },

      updateMany: async ({
        where,
        data,
      }: {
        where: WebhookWhere;
        data: Partial<Pick<FakeWebhook, "enabled" | "secret" | "url">>;
      }): Promise<{ count: number }> => {
        let count = 0;
        for (const row of webhooks.values()) {
          if (!matches(row, where)) continue;
          Object.assign(row, data, { updatedAt: tick() });
          count += 1;
        }
        return { count };
      },

      deleteMany: async ({
        where,
      }: {
        where: WebhookWhere;
      }): Promise<{ count: number }> => {
        let count = 0;
        for (const row of [...webhooks.values()]) {
          if (!matches(row, where)) continue;
          webhooks.delete(row.id);
          count += 1;
        }
        return { count };
      },
    },

    creator: {
      findUnique: async ({
        where,
        include,
      }: {
        where: { jarId: string };
        include?: { webhooks?: { where?: { enabled?: boolean } } };
      }): Promise<(FakeCreator & { webhooks: FakeWebhook[] }) | null> => {
        const creator = creators.get(where.jarId);
        if (creator === undefined) return null;

        const wanted = include?.webhooks?.where?.enabled;
        const owned = [...webhooks.values()].filter(
          (row) =>
            row.creatorId === creator.id &&
            (wanted === undefined || row.enabled === wanted),
        );
        return { ...creator, webhooks: owned };
      },
    },

    webhookDelivery: {
      create: async ({
        data,
      }: {
        data: {
          webhookId: string;
          statusCode: number | null;
          success: boolean;
          payload: object;
          response: string | null;
        };
      }): Promise<FakeDelivery> => {
        const row: FakeDelivery = {
          id: nextId("wd"),
          webhookId: data.webhookId,
          statusCode: data.statusCode,
          success: data.success,
          payload: data.payload,
          response: data.response,
          attemptedAt: tick(),
        };
        deliveries.push(row);
        return row;
      },

      findMany: async ({
        where,
        orderBy,
        take,
        skip,
        select,
      }: {
        where: { webhookId: string };
        orderBy?: OrderBy;
        take?: number;
        skip?: number;
        select?: Select;
      }): Promise<Projected[]> => {
        const found = sortBy(
          deliveries.filter((row) => row.webhookId === where.webhookId),
          orderBy,
        );
        const start = skip ?? 0;
        const page =
          take === undefined
            ? found.slice(start)
            : found.slice(start, start + take);
        return page.map((row) => project(row, select));
      },
    },
  };

  /**
   * Interactive transaction, attached after the literal rather than inside it:
   * the callback is handed this same client, and a member referring to `db`
   * from within its own initializer would make the object's type circular.
   *
   * The callback runs for real, so a read-then-write sequence executes rather
   * than being skipped. There is no rollback — nothing here needs one, and a
   * double that pretended to roll back without doing it would be worse than
   * one that says it does not. A test that cares about atomicity asserts that
   * the work went through this method, not that a failure undid it.
   */
  const client = Object.assign(db, {
    $transaction: async <T>(fn: (tx: typeof db) => Promise<T>): Promise<T> =>
      fn(db),
  });

  return {
    db: client,
    webhooks,
    deliveries,
    creators,

    seedCreator(creator) {
      const row: FakeCreator = {
        id: creator.id,
        jarId: creator.jarId ?? `@${creator.id}`,
      };
      creators.set(row.jarId, row);
      return row;
    },

    seedDelivery(delivery) {
      const row: FakeDelivery = {
        id: delivery.id ?? nextId("wd"),
        webhookId: delivery.webhookId,
        statusCode: delivery.statusCode ?? 200,
        success: delivery.success ?? true,
        payload: delivery.payload ?? { event: "tip.received" },
        response: delivery.response ?? "ok",
        // Default to the monotonic clock, so a loop of seeds comes out in a
        // known order — real timestamps collide at millisecond resolution and
        // a "newest first" assertion against a tie proves nothing.
        attemptedAt: delivery.attemptedAt ?? tick(),
      };
      deliveries.push(row);
      return row;
    },

    seedWebhook(webhook) {
      const now = tick();
      const row: FakeWebhook = {
        id: webhook.id ?? nextId("wh"),
        creatorId: webhook.creatorId,
        url: webhook.url ?? "https://hooks.example.com/novatip",
        secret: webhook.secret ?? "s".repeat(32),
        enabled: webhook.enabled ?? true,
        createdAt: webhook.createdAt ?? now,
        updatedAt: webhook.updatedAt ?? now,
      };
      webhooks.set(row.id, row);
      return row;
    },
  };
}
