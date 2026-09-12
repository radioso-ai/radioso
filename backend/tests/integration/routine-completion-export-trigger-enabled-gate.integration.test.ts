import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { RoutineDefinitionRepository } from "../../src/db/repositories/routineDefinitionRepository.js";
import type { RoutineDefinitionDraftInput } from "../../src/modules/routines/public.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// Regression guard for migration 184. The bug it pins: migration 181 made routine_definition's
// vestigial `status` column unconditionally 'published' forever (every insert hardcodes it to
// satisfy the retired CHECK constraint), but
// `enforce_published_routine_completion_export_destination` — the trigger that validates a
// routine_completion_export row's destination_ref — still gated on `status = 'published'`, not
// `enabled`. Combined with migration 182 correctly letting a disabled routine's webhook
// destination be deleted, this was an unsaveable-routine trap: once a disabled routine's
// destination is gone, ANY later edit goes through replaceChildren, which unconditionally
// deletes and reinserts the routine's completion_export row, retriggering this still-always-on
// check against a destination that no longer exists — the operator could never save another edit
// to that routine. Migration 184 gates the trigger on `enabled` + canonical-row-ness instead.
const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const draftInput = (overrides: Partial<RoutineDefinitionDraftInput> = {}): RoutineDefinitionDraftInput => ({
  name: "notify-on-completion",
  enabled: true,
  activation: {
    triggerDescription: "When the flow completes",
    gateRef: null,
    priority: 1,
    reentryMode: "once_per_conversation",
  },
  slots: [],
  steps: [{ stableStepId: "step_only", kind: "chat", instruction: "Say hello", toolRef: null, actionType: null, ordinal: 0, metadata: {} }],
  transitions: [
    { fromStep: "step_only", toRef: "term_complete", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, ordinal: 0 },
  ],
  terminals: [{ stableStepId: "term_complete", kind: "complete", instruction: "Done", ordinal: 0 }],
  ...overrides,
});

describeIntegration("routine_completion_export destination trigger gates on enabled, not the vestigial status column", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new RoutineDefinitionRepository(database.kysely);

  const accountId = randomUUID();
  const workspaceId = randomUUID();
  let agentId: string;
  let destinationId: string;

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Trigger Test Co", `acct-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Trigger Workspace", `route-${workspaceId}`],
    );
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("lets an unrelated edit save after a disabled routine's webhook destination is deleted", async () => {
    agentId = randomUUID();
    await database.query(`INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, $3)`, [
      agentId,
      workspaceId,
      `Trigger Agent ${agentId}`,
    ]);
    destinationId = randomUUID();
    await database.query(
      `INSERT INTO workspace_webhook_destinations (id, workspace_id, name, url, secret_ciphertext, encryption_key_id)
       VALUES ($1, $2, 'Completion webhook', 'https://example.com/hook', 'ciphertext', 'key-1')`,
      [destinationId, workspaceId],
    );

    const created = await repository.createDraft(agentId, draftInput({
      completionExport: { enabled: true, triggerKinds: ["complete"], destinationRef: destinationId },
    }));
    expect(created.completionExport?.destinationRef.toLowerCase()).toBe(destinationId.toLowerCase());

    // Disable the routine: it no longer holds the destination in service, so deleting the
    // destination must succeed (migration 182's fix — a precondition for this test, not the
    // regression itself).
    const disabled = await repository.updateDraft(agentId, created.id, draftInput({
      enabled: false,
      completionExport: { enabled: true, triggerKinds: ["complete"], destinationRef: destinationId },
    }));
    expect(disabled.enabled).toBe(false);

    await expect(
      database.query(`DELETE FROM workspace_webhook_destinations WHERE id = $1`, [destinationId]),
    ).resolves.not.toThrow();

    // The regression: any further edit to the disabled routine goes through replaceChildren,
    // which deletes and reinserts routine_completion_export — retriggering the destination check
    // against a destination that is now gone. A vestigial `status = 'published'` gate (permanently
    // true for every row since migration 181) would raise here; the enabled-gated trigger must not.
    await expect(
      repository.updateDraft(agentId, created.id, draftInput({
        name: "renamed-after-destination-removed",
        enabled: false,
        completionExport: { enabled: true, triggerKinds: ["complete"], destinationRef: destinationId },
      })),
    ).resolves.toMatchObject({ name: "renamed-after-destination-removed", enabled: false });
  });
});
