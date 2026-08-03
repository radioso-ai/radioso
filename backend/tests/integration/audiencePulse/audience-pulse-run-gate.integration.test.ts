import { randomUUID } from "node:crypto";

import { afterAll, expect, it } from "vitest";

import { PostgresAudiencePulseRunGate } from "../../../src/modules/audiencePulse/infra/postgresAudiencePulseRunGate.js";
import { Database } from "../../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("PostgresAudiencePulseRunGate", () => {
  const firstDatabase = new Database(integrationDatabaseUrl as string);
  const secondDatabase = new Database(integrationDatabaseUrl as string);
  const firstGate = new PostgresAudiencePulseRunGate(firstDatabase.kysely);
  const secondGate = new PostgresAudiencePulseRunGate(secondDatabase.kysely);

  afterAll(async () => {
    await firstDatabase.close().catch(() => undefined);
    await secondDatabase.close().catch(() => undefined);
  });

  it("holds a replica-safe session lease until its idempotent release", async () => {
    const workspaceId = randomUUID();
    const first = await firstGate.tryAcquire(workspaceId);
    if (!first) throw new Error("expected first replica to acquire the workspace lease");

    await expect(secondGate.tryAcquire(workspaceId)).resolves.toBeNull();
    await first.release();
    await first.release();

    const second = await secondGate.tryAcquire(workspaceId);
    expect(second).not.toBeNull();
    await second?.release();
  });
});
