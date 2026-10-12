import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Database } from "../../src/shared/infra/database.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReach = async (url?: string): Promise<boolean> => {
  if (!url) return false;
  const database = new Database(url);
  try {
    await database.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await database.close().catch(() => undefined);
  }
};

const describeIfDatabase = await canReach(integrationDatabaseUrl) ? describe : describe.skip;

// A failover, a server restart, `idle_session_timeout`, or an operator's
// `pg_terminate_backend` all end a pooled connection while it sits idle. The server
// sends the client a FATAL 57P01 and the pool has to absorb it.
describeIfDatabase("database pool losing an idle connection", () => {
  let admin: Database;

  beforeAll(() => {
    admin = new Database(integrationDatabaseUrl!);
  });

  afterAll(async () => {
    await admin?.close();
  });

  it("reports the lost connection and keeps serving queries on a fresh one", async () => {
    const warn = vi.fn();
    const database = new Database(integrationDatabaseUrl!, {
      applicationName: "radioso-idle-loss-test",
      logger: { warn },
    });

    try {
      const before = await database.queryOne<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await admin.execute("SELECT pg_terminate_backend($1)", [before.pid]);

      await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ applicationName: "radioso-idle-loss-test", code: "57P01" }),
        "database_idle_connection_lost",
      );

      const after = await database.queryOne<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      expect(after.pid).not.toBe(before.pid);
    } finally {
      await database.close();
    }
  });

  // A client held across a withTransaction callback, a Kysely transaction, or the
  // migration-lock client is "checked out" of the pool, not idle in it: pg-pool detaches
  // its own idle-error listener the moment a client is acquired. Terminating that backend
  // while it is checked out and no query is in flight is the scenario the idle-only guard
  // above does not cover.
  it("reports a connection lost while checked out and keeps the pool serving new queries", async () => {
    const warn = vi.fn();
    const database = new Database(integrationDatabaseUrl!, {
      applicationName: "radioso-checked-out-loss-test",
      logger: { warn },
    });

    const uncaughtExceptions: unknown[] = [];
    const onUncaughtException = (error: unknown): void => {
      uncaughtExceptions.push(error);
    };
    // Server-side termination of a checked-out client can surface as more than one
    // 'error' emission (the parsed Postgres FATAL, then a generic "connection terminated"
    // once the socket closes) — `on`, not `once`, so a second escape is still caught here
    // instead of leaking into Vitest's own unhandled-error reporting.
    process.on("uncaughtException", onUncaughtException);

    try {
      const client = await database.pool.connect();
      try {
        const before = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const pid = before.rows[0]?.pid;

        await admin.execute("SELECT pg_terminate_backend($1)", [pid]);

        // Deliberately no listener on `client` itself here: one would mask the exact crash
        // this guards against (an 'error' event with zero listeners throws). Poll for
        // either outcome — the warning (fixed) or a caught `uncaughtException` (unfixed) —
        // then assert it was the former.
        await vi.waitFor(() => {
          expect(warn.mock.calls.length + uncaughtExceptions.length).toBeGreaterThan(0);
        });
        expect(uncaughtExceptions).toEqual([]);
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ applicationName: "radioso-checked-out-loss-test", code: "57P01" }),
          "database_checked_out_connection_lost",
        );

        await expect(client.query("SELECT 1")).rejects.toThrow();
      } finally {
        // The owner releases with an error once it observes the client is unqueryable,
        // same as withTransaction's finally block would on its next operation.
        client.release(new Error("connection lost"));
      }

      const after = await database.queryOne<{ ok: number }>("SELECT 1 AS ok");
      expect(after.ok).toBe(1);
      expect(uncaughtExceptions).toEqual([]);
    } finally {
      process.removeListener("uncaughtException", onUncaughtException);
      await database.close();
    }
  });
});
