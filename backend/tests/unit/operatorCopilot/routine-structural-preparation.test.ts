import { describe, expect, it, vi } from "vitest";

import { createRoutineStructuralPreparationTool as createRoutineStructuralPreparationToolOwner } from "../../../src/modules/operatorCopilot/tools/routineStructuralPreparation.js";
import { operatorMcpToolSchemas } from "../../../src/modules/operatorCopilot/mcpToolSchema.js";

const context = {
  workspaceId: "workspace-1", accountId: "account-1", operatorUserId: "operator-1", surface: "mcp" as const,
  operatorMcpInvocationId: "prepare-1",
  currentAuthorization: { hasAllPermissions: vi.fn(async () => true) },
  pageContext: { view: null, agentId: null, conversationId: null, selection: null, entities: [] },
};

const routine = {
  id: "22222222-2222-4222-8222-222222222222", agentId: "11111111-1111-4111-8111-111111111111", lineageId: "33333333-3333-4333-8333-333333333333", version: 1, name: "Returns", enabled: true,
  activation: { triggerDescription: "Handle returns", gateRef: null, priority: 0, reentryMode: "once_per_conversation" as const },
  steps: [{ stableStepId: "step_collect", kind: "chat", instruction: "Collect details.", toolRef: null, ordinal: 0, metadata: {} }],
  terminals: [{ stableStepId: "terminal_done", kind: "complete", instruction: "Done.", ordinal: 1 }],
  slots: [], transitions: [{ fromStep: "step_collect", toRef: "terminal_done", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, fieldRef: null, fieldOp: null, fieldValue: null, fieldValues: null, fieldUnit: null, ordinal: 0 }], createdAt: new Date("2026-08-01T00:00:00Z"), updatedAt: new Date("2026-09-01T00:00:00Z"),
};

const createRoutineStructuralPreparationTool = (dependencies: unknown) =>
  createRoutineStructuralPreparationToolOwner(dependencies as never);

describe("routine structural preparation", () => {
  const anyDescriptor = () => createRoutineStructuralPreparationTool({
    routines: { get: vi.fn(), validateForDraftMutation: vi.fn() },
    proposalRepository: { createProposal: vi.fn() }, proposalRecovery: { recoverOperatorMcpProposal: vi.fn() },
    auditService: { record: vi.fn() }, scopedReferences: { assertNoScopedReferences: vi.fn() },
  });

  it("advertises one object schema whose kind says which of the three calls this is", () => {
    const { inputSchema } = operatorMcpToolSchemas(anyDescriptor());

    // An untagged union serializes to a root-level `anyOf` with no `properties`: a client builds an
    // argument-less signature from it and strict-mode function calling refuses it outright.
    expect(inputSchema.anyOf).toBeUndefined();
    expect(inputSchema.type).toBe("object");
    expect(Object.keys(inputSchema.properties as object).sort()).toEqual(["agentId", "draft", "kind", "operations", "routineId"]);
    expect(inputSchema.required).toEqual(expect.arrayContaining(["kind", "agentId"]));
    const properties = inputSchema.properties as Record<string, { enum?: string[]; description?: string }>;
    expect(properties.kind?.enum).toEqual(["edit", "create", "delete"]);
    // The per-kind requirement has to be readable from the schema itself, not only enforced by the
    // refinement: three bare optionals leave the caller guessing which of them its kind needs.
    expect(properties.routineId?.description).toMatch(/edit and kind delete/);
    expect(properties.operations?.description).toMatch(/kind edit/);
    expect(properties.draft?.description).toMatch(/kind create/);
  });

  it("parses its own parsed output, because the catalog re-parses what the application service already parsed", () => {
    const { inputSchema } = anyDescriptor();
    const agentId = "11111111-1111-4111-8111-111111111111";
    const draft = { name: "Created", enabled: true, activation: { triggerDescription: "Handle returns", gateRef: null, priority: 0, reentryMode: "once_per_conversation" }, slots: [], steps: [{ stableStepId: "start", kind: "chat", instruction: "Start", toolRef: null, ordinal: 0, metadata: {} }], transitions: [{ fromStep: "start", toRef: "done", guardKind: "default", ordinal: 0 }], terminals: [{ stableStepId: "done", kind: "complete", instruction: "Done", ordinal: 0 }] };
    const calls = [
      { kind: "edit", agentId, routineId: agentId, operations: [{ kind: "set_enabled", enabled: false }] },
      { kind: "delete", agentId, routineId: agentId },
      { kind: "create", agentId, draft },
    ];

    // `mcpApplicationService` hands `parsed.data` to `mcpCatalog`, which parses again, and the tool
    // parses a third time. A transform whose output is not valid input would turn a good call into
    // an unattributable 503.
    for (const call of calls) {
      const once = inputSchema.parse(call);
      expect(inputSchema.parse(once)).toEqual(once);
    }
  });

  it("names the field a call got wrong rather than refusing it wholesale", () => {
    const { inputSchema } = anyDescriptor();
    const agentId = "11111111-1111-4111-8111-111111111111";

    const missing = inputSchema.safeParse({ kind: "edit", agentId });
    expect(missing.success).toBe(false);
    expect(!missing.success && missing.error.issues.map((issue) => [issue.path.join("."), issue.code])).toEqual([["routineId", "invalid_type"], ["operations", "invalid_type"]]);

    const misplaced = inputSchema.safeParse({ kind: "delete", agentId, routineId: agentId, operations: [{ kind: "set_enabled", enabled: false }] });
    expect(!misplaced.success && misplaced.error.issues.map((issue) => [issue.path.join("."), issue.code])).toEqual([["", "unrecognized_keys"]]);
  });

  it("prepares create and delete as digest-bound routine operations without mutating the owner", async () => {
    const createProposal = vi.fn(async () => ({ id: "proposal-1" }));
    const get = vi.fn(async () => routine);
    const validate = vi.fn(async () => ({ ok: true, diagnostics: [] }));
    const scopedReferences = { assertNoScopedReferences: vi.fn() };
    const descriptor = createRoutineStructuralPreparationTool({
      routines: { get, validateForDraftMutation: validate, findCreateConflict: vi.fn(async () => null) } as never,
      proposalRepository: { createProposal }, proposalRecovery: { recoverOperatorMcpProposal: vi.fn() }, auditService: { record: vi.fn() }, scopedReferences,
    });
    const draft = { name: "Created", enabled: true, activation: { triggerDescription: "Handle returns", gateRef: null, priority: 0, reentryMode: "once_per_conversation" }, slots: [], steps: [{ stableStepId: "start", kind: "chat", instruction: "Start", toolRef: null, ordinal: 0, metadata: {} }], transitions: [{ fromStep: "start", toRef: "done", guardKind: "default", ordinal: 0 }], terminals: [{ stableStepId: "done", kind: "complete", instruction: "Done", ordinal: 0 }] };

    await descriptor.createTool(context).invoke({ kind: "create", agentId: "11111111-1111-4111-8111-111111111111", draft }, {} as never);
    await descriptor.createTool(context).invoke({ kind: "delete", agentId: "11111111-1111-4111-8111-111111111111", routineId: routine.id }, {} as never);

    expect(createProposal).toHaveBeenNthCalledWith(1, expect.objectContaining({ targetRef: { agentId: "11111111-1111-4111-8111-111111111111", routineId: null }, payload: expect.objectContaining({ kind: "create", draft: expect.objectContaining({ name: draft.name }) }), reviewDigest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) }));
    expect(createProposal).toHaveBeenNthCalledWith(2, expect.objectContaining({ targetRef: { agentId: "11111111-1111-4111-8111-111111111111", routineId: routine.id }, payload: { kind: "delete" }, versionToken: routine.updatedAt.toISOString() }));
    expect(scopedReferences.assertNoScopedReferences).toHaveBeenCalledWith(expect.objectContaining({ routineId: routine.id, removedNodeIds: ["step_collect", "terminal_done"] }));
  });

  it("recovers the original immutable review after a lost response without drafting again", async () => {
    const createProposal = vi.fn();
    const reviewSnapshot = { diagnostics: [], review: { before: {}, after: {}, truncated: false, detailAvailable: false, beforeConnections: [{ fromStep: "old", toRef: "done", guardKind: "default", ordinal: 0 }], afterConnections: [], connectionsTruncated: false, operations: [], operationsTruncated: false } };
    const descriptor = createRoutineStructuralPreparationTool({
      routines: { get: vi.fn(async () => ({ ...routine, name: "Changed after prepare" })), validateForDraftMutation: vi.fn() },
      proposalRepository: { createProposal },
      proposalRecovery: { recoverOperatorMcpProposal: vi.fn(async () => ({ status: "recovered", proposal: { id: "proposal-1", targetType: "routine", reviewDigest: "d".repeat(43), expiresAt: new Date("2026-09-13T00:15:00Z"), reviewSnapshot } })) },
      auditService: { record: vi.fn() }, scopedReferences: { assertNoScopedReferences: vi.fn() },
    });
    const recovered = await descriptor.reconcileMcpInvocation!({ invocation: { id: "invocation-1", grantId: "grant-1", operationId: "op-1", inputDigest: "digest" }, context, staleBefore: new Date(0), now: new Date() } as never);
    expect(recovered).toMatchObject({ status: "recovered", output: { proposalId: "proposal-1", reviewDigest: "d".repeat(43), expiresAt: "2026-09-13T00:15:00.000Z", ...reviewSnapshot } });
    expect(createProposal).not.toHaveBeenCalled();
  });
  it("applies explicit graph commands through the scoped-reference guard and persists a digest-bound review", async () => {
    const get = vi.fn(async () => routine);
    const validate = vi.fn(async () => ({ ok: true, diagnostics: [] }));
    const assertNoScopedReferences = vi.fn();
    const createProposal = vi.fn(async () => ({ id: "proposal-1" }));
    const descriptor = createRoutineStructuralPreparationTool({
      routines: { get, validateForDraftMutation: validate },
      proposalRepository: { createProposal }, proposalRecovery: { recoverOperatorMcpProposal: vi.fn() },
      auditService: { record: vi.fn() },
      scopedReferences: { assertNoScopedReferences },
      now: () => new Date("2026-09-13T00:00:00Z"),
    });
    const output = await descriptor.createTool(context).invoke({
      kind: "edit", agentId: "11111111-1111-4111-8111-111111111111", routineId: routine.id,
      operations: [{ kind: "remove_transition", transition: routine.transitions[0] }],
    }, {} as never);

    expect(assertNoScopedReferences).toHaveBeenCalledWith({ workspaceId: "workspace-1", agentId: "11111111-1111-4111-8111-111111111111", routineId: routine.id, removedNodeIds: [], removedSlotIds: [] });
    expect(validate).toHaveBeenCalledWith("workspace-1", "11111111-1111-4111-8111-111111111111", expect.objectContaining({ transitions: [] }));
    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({
      origin: { type: "operator_mcp_invocation", invocationId: "prepare-1" }, targetType: "routine",
      reviewDigest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), expiresAt: new Date("2026-09-13T00:15:00Z"),
    }));
    expect(output).toMatchObject({ proposalId: "proposal-1", reviewDigest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), review: { beforeConnections: [{ fromStep: "step_collect", toRef: "terminal_done" }], afterConnections: [] } });
  });

  it("refuses a graph draft with canonical owner diagnostics before it can be reviewed", async () => {
    const createProposal = vi.fn();
    const descriptor = createRoutineStructuralPreparationTool({
      routines: { get: vi.fn(async () => routine), validateForDraftMutation: vi.fn(async () => ({ ok: false, diagnostics: [{ code: "dangling", location: "step_collect", message: "Dangling" }] })) },
      proposalRepository: { createProposal }, proposalRecovery: { recoverOperatorMcpProposal: vi.fn() }, auditService: { record: vi.fn() }, scopedReferences: { assertNoScopedReferences: vi.fn() },
    });
    await expect(descriptor.createTool(context).invoke({ kind: "edit", agentId: "11111111-1111-4111-8111-111111111111", routineId: routine.id, operations: [{ kind: "set_enabled", enabled: false }] }, {} as never)).rejects.toMatchObject({
      statusCode: 422, code: "revision_invalid", details: { diagnostics: [{ routineId: routine.id, code: "dangling", location: "step_collect", message: "The routine structure is not valid for serving." }] },
    });
    expect(createProposal).not.toHaveBeenCalled();
  });

  it("does not misidentify a new routine as its agent when create validation fails", async () => {
    const createProposal = vi.fn();
    const agentId = "11111111-1111-4111-8111-111111111111";
    const draft = { name: "Created", enabled: true, activation: routine.activation, slots: [], steps: routine.steps, transitions: routine.transitions, terminals: routine.terminals };
    const descriptor = createRoutineStructuralPreparationTool({
      routines: { get: vi.fn(), findCreateConflict: vi.fn(async () => null), validateForDraftMutation: vi.fn(async () => ({ ok: false, diagnostics: [{ code: "missing_terminal", location: "routine:Created", message: "No ending is reachable." }] })) },
      proposalRepository: { createProposal }, proposalRecovery: { recoverOperatorMcpProposal: vi.fn() }, auditService: { record: vi.fn() }, scopedReferences: { assertNoScopedReferences: vi.fn() },
    });

    await expect(descriptor.createTool(context).invoke({ kind: "create", agentId, draft }, {} as never)).rejects.toMatchObject({
      statusCode: 422,
      code: "revision_invalid",
      details: { diagnostics: [expect.objectContaining({ routineId: null, code: "missing_terminal" })] },
    });
    expect(createProposal).not.toHaveBeenCalled();
  });

  it("rejects malformed commands before loading or mutating the routine", async () => {
    const get = vi.fn();
    const descriptor = createRoutineStructuralPreparationTool({
      routines: { get, validateForDraftMutation: vi.fn() }, proposalRepository: { createProposal: vi.fn() }, proposalRecovery: { recoverOperatorMcpProposal: vi.fn() }, auditService: { record: vi.fn() }, scopedReferences: { assertNoScopedReferences: vi.fn() },
    });
    await expect(descriptor.createTool(context).invoke({ kind: "edit", agentId: "11111111-1111-4111-8111-111111111111", routineId: routine.id, operations: [{ kind: "remove_everything" }] }, {} as never)).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  });

  it("persists the owner authoring projection, not Date-bearing routine persistence metadata", async () => {
    const createProposal = vi.fn(async () => ({ id: "proposal-1" }));
    const descriptor = createRoutineStructuralPreparationTool({
      routines: { get: vi.fn(async () => ({ ...routine, createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-09-01T00:00:00Z") })), validateForDraftMutation: vi.fn(async () => ({ ok: true, diagnostics: [] })) },
      proposalRepository: { createProposal }, proposalRecovery: { recoverOperatorMcpProposal: vi.fn() }, auditService: { record: vi.fn() }, scopedReferences: { assertNoScopedReferences: vi.fn() },
    });
    await expect(descriptor.createTool(context).invoke({ kind: "edit", agentId: "11111111-1111-4111-8111-111111111111", routineId: routine.id, operations: [{ kind: "set_enabled", enabled: false }] }, {} as never)).resolves.toMatchObject({ proposalId: "proposal-1" });
    const payload = (createProposal.mock.calls as unknown as Array<[{ payload: { draft: unknown } }]>)[0][0].payload;
    expect(payload.draft).not.toHaveProperty("createdAt");
    expect(payload.draft).not.toHaveProperty("updatedAt");
  });

  it("shows exact authoring controls and keeps a complete projection when the visible review is bounded", async () => {
    const steps = Array.from({ length: 41 }, (_, ordinal) => ({ stableStepId: `step_${ordinal}`, kind: "chat", instruction: `Ask ${ordinal}`, toolRef: null, ordinal, metadata: {} }));
    const draft = { name: "Bounded", enabled: false, activation: routine.activation, slots: [{ stableSlotId: "slot_email", key: "email", type: "text", required: true, description: "Email", ordinal: 0 }], steps, transitions: [{ fromStep: "step_0", toRef: "done", guardKind: "field", fieldRef: "email", fieldOp: "is_present", ordinal: 0 }], terminals: [{ stableStepId: "done", kind: "complete", instruction: "Done", ordinal: 42 }] };
    const createProposal = vi.fn(async () => ({ id: "proposal-1" }));
    const descriptor = createRoutineStructuralPreparationTool({
      routines: { get: vi.fn(), validateForDraftMutation: vi.fn(async () => ({ ok: true, diagnostics: [] })), findCreateConflict: vi.fn(async () => null) },
      proposalRepository: { createProposal }, proposalRecovery: { recoverOperatorMcpProposal: vi.fn() }, auditService: { record: vi.fn() }, scopedReferences: { assertNoScopedReferences: vi.fn() },
    });
    const output = await descriptor.createTool(context).invoke({ kind: "create", agentId: "11111111-1111-4111-8111-111111111111", draft }, {} as never);
    expect(output).toMatchObject({ review: { truncated: true, detailAvailable: true, after: { enabled: false, activation: { triggerDescription: "Handle returns" }, slots: { email: { required: true, description: "Email" } }, steps: { step_0: { instruction: "Ask 0" } }, transitions: { "step_0 → done": { guardKind: "field", fieldRef: "email" } } } } });
    const reviewSnapshot = (createProposal.mock.calls as unknown as Array<[{ reviewSnapshot: { fullReview: { after: { steps: unknown; slots: unknown } } } }]>)[0][0].reviewSnapshot;
    expect(reviewSnapshot.fullReview.after.steps).toContainEqual(expect.objectContaining({ stableStepId: "step_40", instruction: "Ask 40" }));
    expect(reviewSnapshot.fullReview.after.slots).toContainEqual(expect.objectContaining({ stableSlotId: "slot_email" }));
  });
});
