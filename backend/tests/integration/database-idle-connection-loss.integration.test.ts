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
});
