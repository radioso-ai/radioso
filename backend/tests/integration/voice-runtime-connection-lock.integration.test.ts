import { randomUUID } from "node:crypto";

import { afterAll, expect, it } from "vitest";

import { PostgresVoiceRuntimeConnectionLock } from "../../src/modules/voiceChannel/public.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

/** Work that runs until the test lets it finish. */
const heldWork = () => {
  let finish = () => {};
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  let started = () => {};
  const running = new Promise<void>((resolve) => { started = resolve; });
  return { finish, running, work: async () => { started(); await finished; return "done"; } };
};

describeIntegration("PostgresVoiceRuntimeConnectionLock", () => {
  // Two pools stand in for two backend instances.
  const firstDatabase = new Database(integrationDatabaseUrl);
  const secondDatabase = new Database(integrationDatabaseUrl);
  const first = new PostgresVoiceRuntimeConnectionLock(firstDatabase.kysely);
  const second = new PostgresVoiceRuntimeConnectionLock(secondDatabase.kysely);

  afterAll(async () => {
    await firstDatabase.close().catch(() => undefined);
    await secondDatabase.close().catch(() => undefined);
  });

  it("lets one instance change an agent's connection at a time, refusing the other at once", async () => {
    const agent = { workspaceId: randomUUID(), agentId: randomUUID() };
    const held = heldWork();
    const running = first.run(agent, held.work);
    await held.running;
    const refusedWork = { ran: false };

    await expect(second.run(agent, async () => { refusedWork.ran = true; })).resolves.toEqual({ ran: false });
    expect(refusedWork.ran).toBe(false);
    held.finish();
    await expect(running).resolves.toEqual({ ran: true, value: "done" });

    await expect(second.run(agent, async () => "after")).resolves.toEqual({ ran: true, value: "after" });
  });

  it("holds one agent's lock without blocking another agent's", async () => {
    const workspaceId = randomUUID();
    const held = heldWork();
    const running = first.run({ workspaceId, agentId: randomUUID() }, held.work);
    await held.running;

    await expect(second.run({ workspaceId, agentId: randomUUID() }, async () => "other")).resolves.toEqual({ ran: true, value: "other" });
    held.finish();
    await running;
  });

  it("lets go of the lock when the work fails", async () => {
    const agent = { workspaceId: randomUUID(), agentId: randomUUID() };

    await expect(first.run(agent, async () => { throw new Error("vendor down"); })).rejects.toThrow("vendor down");
    await expect(second.run(agent, async () => "next")).resolves.toEqual({ ran: true, value: "next" });
  });
});
