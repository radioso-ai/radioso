import { randomUUID } from "node:crypto";

import type { DirectiveCoherenceChecker } from "@radioso/conversation-contract";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { buildStarterPackApplyService } from "../../src/app/composition/agentStarterPackComposition.js";
import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { agentRevisionLockKey } from "../../src/db/repositories/agentDraftMutation.js";
import { transactionAdvisoryLock } from "../../src/shared/infra/kysely/sqlHelpers.js";
import { pendingDirectiveId } from "../../src/modules/agents/public.js";
import { AgentRepository } from "../../src/db/repositories/agentRepository.js";
import { RoutineDefinitionRepository } from "../../src/db/repositories/routineDefinitionRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { starterPackApplyRequestSchema, type StarterPackApplyRequest } from "../../src/modules/agentStarterPack/public.js";
import { AuthoredDirectiveService } from "../../src/modules/agents/public.js";
import { RoutineDefinitionService, type RoutineDefinitionDraftInput } from "../../src/modules/routines/public.js";
import { registeredCapabilityNames } from "../../src/shared/domain/capabilityPolicy.js";
import { Database } from "../../src/shared/infra/database.js";
import type { Db } from "../../src/shared/infra/kysely/types.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const coherentChecker: DirectiveCoherenceChecker = {
  check: async () => ({ coherent: true, conflicts: [], rationale: "Integration test verdict." }),
};

const directive = (name: string, action = `Follow the ${name} guideline.`) => ({
  name,
  condition: { kind: "always" as const },
  action,
});

const routine = (name: string, overrides: Partial<RoutineDefinitionDraftInput> = {}): RoutineDefinitionDraftInput => ({
  enabled: true,
  name,
  activation: { triggerDescription: "The visitor wants an appointment.", gateRef: null, priority: 10, reentryMode: "once_per_conversation" },
  slots: [{ stableSlotId: "slot_date", key: "date", type: "text", required: true, description: "Preferred date", ordinal: 0 }],
  steps: [{ stableStepId: "step_collect_date", kind: "chat", instruction: "Ask for {{slot.date}}.", toolRef: null, ordinal: 0, metadata: {} }],
  transitions: [{ fromStep: "step_collect_date", toRef: "terminal_complete", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 0 }],
  terminals: [{ stableStepId: "terminal_complete", kind: "complete", instruction: "Confirm {{slot.date}}.", ordinal: 1 }],
  ...overrides,
});

/** Parsed as the apply route parses a request body, so defaults such as `excludes: []` are filled in. */
const pack = (items: unknown[], idempotencyKey = `key-${randomUUID()}`): StarterPackApplyRequest =>
  starterPackApplyRequestSchema.parse({ idempotencyKey, items });

const directiveItem = (itemKey: string, name: string, action?: string, excludes?: string[]) =>
  ({ itemKey, kind: "directive", directive: { ...directive(name, action), ...(excludes ? { excludes } : {}) } });

const routineItem = (itemKey: string, name: string, overrides?: Partial<RoutineDefinitionDraftInput>) =>
  ({ itemKey, kind: "routine", routine: routine(name, overrides) });

describeIntegration("starter pack apply against Postgres", () => {
  let database: Database;
  let accounts: AccountRepository;
  let workspaces: WorkspaceRepository;
  let agents: AgentRepository;

  /**
   * The production composition, with an optional fault injected into the transaction-bound
   * services. `checker` backs the coherence assessment; the transaction-bound directive service
   * gets its own spy, which must never be called because no model call may happen in the lock.
   */
  const buildService = (fault?: { failOnDirective?: string; failOnRoutine?: boolean }, checker: DirectiveCoherenceChecker = coherentChecker) => {
    const checkerInsideTransaction = vi.fn(coherentChecker.check);
    const authoringServicesOn = (db: Db) => {
      const agentRepository = new AgentRepository(db);
      const authoredDirectiveService = new AuthoredDirectiveService({
        repository: agentRepository,
        coherenceChecker: { check: checkerInsideTransaction },
        registeredCapabilityNames,
      });
      const routineDefinitionService = new RoutineDefinitionService({
        agentRepository,
        repository: new RoutineDefinitionRepository(db),
      });
      return {
        authoredDirectiveService: {
          list: authoredDirectiveService.list.bind(authoredDirectiveService),
          coherenceContextToken: authoredDirectiveService.coherenceContextToken.bind(authoredDirectiveService),
          create: async (...args: Parameters<AuthoredDirectiveService["create"]>) => {
            const saved = await authoredDirectiveService.create(...args);
            // Fail after the row was written, as a crash or constraint error mid-apply would.
            if (fault?.failOnDirective === saved.directive.name) throw new Error("injected failure after write");
            return saved;
          },
        },
        routineDefinitionService: {
          findCreateConflict: routineDefinitionService.findCreateConflict.bind(routineDefinitionService),
          createDraft: async (...args: Parameters<RoutineDefinitionService["createDraft"]>) => {
            const saved = await routineDefinitionService.createDraft(...args);
            if (fault?.failOnRoutine) throw new Error("injected failure after write");
            return saved;
          },
        },
      };
    };
    const committedRoutineFollowUp = vi.fn(async () => undefined);
    const audit = { record: vi.fn(async () => undefined) };
    const sharedRoutines = new RoutineDefinitionService({
      agentRepository: new AgentRepository(database.kysely),
      repository: new RoutineDefinitionRepository(database.kysely),
    });
    const service = buildStarterPackApplyService({
      db: database.kysely,
      authoredDirectiveService: new AuthoredDirectiveService({
        repository: new AgentRepository(database.kysely),
        coherenceChecker: checker,
        registeredCapabilityNames,
      }),
      authoringServicesOn,
      routineDefinitionService: {
        completeExternalDraftMutation: committedRoutineFollowUp,
        findCreateConflict: sharedRoutines.findCreateConflict.bind(sharedRoutines),
      },
      auditService: audit,
    });
    return { service, committedRoutineFollowUp, audit, checkerInsideTransaction };
  };

  const createAgent = async () => {
    const account = await accounts.create({ name: "Starter pack org", email: `starter-pack-${randomUUID()}@example.com`, passwordHash: "hash" });
    const workspace = await workspaces.create(account.id, "Starter pack workspace");
    const agent = await agents.create(workspace.id, { name: "Front desk" });
    return { accountId: account.id, workspaceId: workspace.id, agentId: agent.id };
  };

  const stateOf = async (workspaceId: string, agentId: string) => {
    const [directives, routines, applies, draft] = await Promise.all([
      // The order the agent's directives are listed and run in (`listDirectives`), not by name.
      database.kysely.selectFrom("agent_directives").select(["id", "name", "action"]).where("agent_id", "=", agentId).orderBy("created_at").orderBy("id").execute(),
      database.kysely.selectFrom("routine_definition").select(["id", "name"]).where("agent_id", "=", agentId).orderBy("name").execute(),
      database.kysely.selectFrom("agent_starter_pack_applies").select(["idempotency_key"]).where("agent_id", "=", agentId).execute(),
      database.kysely.selectFrom("agent_drafts").select(["generation"]).where("workspace_id", "=", workspaceId).where("agent_id", "=", agentId).executeTakeFirstOrThrow(),
    ]);
    return { directives, routines, applies, draftGeneration: draft.generation };
  };

  /** A second connection pool, so a probe never shares a session with the apply under test. */
  let probe: Database;

  /** Whether the agent's draft lock is free right now, seen from another session. */
  const agentLockIsFree = async (workspaceId: string, agentId: string): Promise<boolean> => {
    const key = agentRevisionLockKey(workspaceId, agentId);
    const [row] = await probe.query<{ ok: boolean }>("select pg_try_advisory_lock(hashtextextended($1, 0)) as ok", [key]);
    if (row?.ok) {
      await probe.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key]);
    }
    return row?.ok === true;
  };

  beforeAll(() => {
    database = new Database(integrationDatabaseUrl);
    probe = new Database(integrationDatabaseUrl, { poolMax: 1 });
    accounts = new AccountRepository(database.kysely);
    workspaces = new WorkspaceRepository(database.kysely);
    agents = new AgentRepository(database.kysely);
  });

  afterAll(async () => {
    await database.close();
    await probe.close();
  });

  it("lists the pack's directives in the order they were sent, though one transaction creates them all", async () => {
    const { accountId, workspaceId, agentId } = await createAgent();
    const { service } = buildService();
    const names = ["zeta-rule", "alpha-rule", "mu-rule", "beta-rule", "omega-rule", "gamma-rule"];

    await service.apply(workspaceId, agentId, { accountId }, pack(names.map((name, index) => directiveItem(`directive-${index + 1}`, name))));

    expect((await agents.listDirectives(agentId, workspaceId)).map((directive) => directive.name)).toEqual(names);
  });

  it("applies all selected directives and the routine in one commit", async () => {
    const { accountId, workspaceId, agentId } = await createAgent();
    const before = await stateOf(workspaceId, agentId);
    const { service, committedRoutineFollowUp, audit } = buildService();

    const result = await service.apply(workspaceId, agentId, { accountId }, pack([
      directiveItem("directive-1", "confirm-details"),
      directiveItem("directive-2", "no-diagnosis"),
      routineItem("routine-1", "book-appointment"),
    ]));

    expect(result.replayed).toBe(false);
    expect(result.items.map(({ itemKey, kind, name }) => ({ itemKey, kind, name }))).toEqual([
      { itemKey: "directive-1", kind: "directive", name: "confirm-details" },
      { itemKey: "directive-2", kind: "directive", name: "no-diagnosis" },
      { itemKey: "routine-1", kind: "routine", name: "book-appointment" },
    ]);
    const after = await stateOf(workspaceId, agentId);
    expect(after.directives.map((row) => row.name)).toEqual(["confirm-details", "no-diagnosis"]);
    expect(after.routines.map((row) => row.name)).toEqual(["book-appointment"]);
    expect(new Set(result.items.map((item) => item.id))).toEqual(new Set([...after.directives, ...after.routines].map((row) => row.id)));
    expect(after.applies).toHaveLength(1);
    // Each item went through the owning service's draft mutation, so the agent draft advanced once per item.
    expect(after.draftGeneration).toBe(before.draftGeneration + 3);
    expect(result.items[2]).toMatchObject({ kind: "routine", validation: { ok: true, diagnostics: [] } });
    // Apply only creates, so the routine's authoring follow-up is recorded as a create.
    expect(committedRoutineFollowUp).toHaveBeenCalledWith(workspaceId, agentId, expect.objectContaining({ name: "book-appointment" }), "create");
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: "agent_starter_pack.apply", workspaceId }));
  });

  it("creates only the directives that were selected", async () => {
    const { accountId, workspaceId, agentId } = await createAgent();
    const { service } = buildService();

    await service.apply(workspaceId, agentId, { accountId }, pack([
      directiveItem("directive-2", "no-diagnosis"),
    ]));

    const after = await stateOf(workspaceId, agentId);
    expect(after.directives.map((row) => row.name)).toEqual(["no-diagnosis"]);
    expect(after.routines).toEqual([]);
  });

  it("applies the selected routine on its own", async () => {
    const { accountId, workspaceId, agentId } = await createAgent();
    const { service } = buildService();

    const result = await service.apply(workspaceId, agentId, { accountId }, pack([routineItem("routine-1", "book-appointment")]));

    const after = await stateOf(workspaceId, agentId);
    expect(after.routines).toEqual([{ id: result.items[0]?.id, name: "book-appointment" }]);
    expect(after.directives).toEqual([]);
  });

  it("applies directives without a routine", async () => {
    const { accountId, workspaceId, agentId } = await createAgent();
    const { service, committedRoutineFollowUp } = buildService();

    await service.apply(workspaceId, agentId, { accountId }, pack([
      directiveItem("directive-1", "confirm-details"),
      directiveItem("directive-2", "no-diagnosis"),
    ]));

    const after = await stateOf(workspaceId, agentId);
    expect(after.directives).toHaveLength(2);
    expect(after.routines).toEqual([]);
    expect(committedRoutineFollowUp).not.toHaveBeenCalled();
  });

  it("returns the stored result for a repeated request and creates nothing more", async () => {
    const { accountId, workspaceId, agentId } = await createAgent();
    const { service, audit } = buildService();
    const request = pack([directiveItem("directive-1", "confirm-details"), routineItem("routine-1", "book-appointment")]);

    const first = await service.apply(workspaceId, agentId, { accountId }, request);
    const afterFirst = await stateOf(workspaceId, agentId);
    const second = await service.apply(workspaceId, agentId, { accountId }, request);

    expect(second).toEqual({ ...first, replayed: true });
    expect(await stateOf(workspaceId, agentId)).toEqual(afterFirst);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it("refuses to reuse an idempotency key for a different selection, creating nothing", async () => {
    const { accountId, workspaceId, agentId } = await createAgent();
    const { service } = buildService();
    await service.apply(workspaceId, agentId, { accountId }, pack([directiveItem("directive-1", "confirm-details")], "shared-key-1"));
    const afterFirst = await stateOf(workspaceId, agentId);

    await expect(service.apply(workspaceId, agentId, { accountId }, pack([directiveItem("directive-1", "different-name")], "shared-key-1")))
      .rejects.toMatchObject({ statusCode: 409, code: "idempotency_key_reused" });
    expect(await stateOf(workspaceId, agentId)).toEqual(afterFirst);
  });

  it("rejects the whole pack when a selected directive name already exists, leaving the existing one untouched", async () => {
    const { accountId, workspaceId, agentId } = await createAgent();
    await agents.createDirective(agentId, workspaceId, directive("no-diagnosis", "The operator's own wording."));
    const before = await stateOf(workspaceId, agentId);
    const { service } = buildService();

    await expect(service.apply(workspaceId, agentId, { accountId }, pack([
      directiveItem("directive-1", "confirm-details"),
      directiveItem("directive-2", "no-diagnosis", "The starter pack's wording."),
      routineItem("routine-1", "book-appointment"),
    ]))).rejects.toMatchObject({
      statusCode: 409,
      code: "starter_pack_name_conflict",
      details: { items: [{ itemKey: "directive-2", kind: "directive", name: "no-diagnosis" }] },
    });

    const after = await stateOf(workspaceId, agentId);
    expect(after).toEqual(before);
    expect(after.directives).toEqual([expect.objectContaining({ name: "no-diagnosis", action: "The operator's own wording." })]);
  });

  it("rejects the whole pack when the selected routine name already exists", async () => {
    const { accountId, workspaceId, agentId } = await createAgent();
    await new RoutineDefinitionRepository(database.kysely).createDraftWithAgentDraft(workspaceId, agentId, routine("book-appointment"));
    const before = await stateOf(workspaceId, agentId);
    const { service } = buildService();

    await expect(service.apply(workspaceId, agentId, { accountId }, pack([
      directiveItem("directive-1", "confirm-details"),
      routineItem("routine-1", "book-appointment"),
    ]))).rejects.toMatchObject({ statusCode: 409, code: "starter_pack_name_conflict" });

    expect(await stateOf(workspaceId, agentId)).toEqual(before);
  });

  it("returns 404 and creates nothing for an agent in another workspace", async () => {
    const owner = await createAgent();
    const other = await createAgent();
    const before = await stateOf(owner.workspaceId, owner.agentId);
    const { service } = buildService();

    await expect(service.apply(other.workspaceId, owner.agentId, { accountId: other.accountId }, pack([
      directiveItem("directive-1", "confirm-details"),
    ]))).rejects.toMatchObject({ statusCode: 404 });

    expect(await stateOf(owner.workspaceId, owner.agentId)).toEqual(before);
  });

  it("rolls everything back when the routine fails after the directives were written", async () => {
    const { accountId, workspaceId, agentId } = await createAgent();
    const before = await stateOf(workspaceId, agentId);
    const { service, committedRoutineFollowUp, audit } = buildService({ failOnRoutine: true });

    await expect(service.apply(workspaceId, agentId, { accountId }, pack([
      directiveItem("directive-1", "confirm-details"),
      directiveItem("directive-2", "no-diagnosis"),
      routineItem("routine-1", "book-appointment"),
    ]))).rejects.toThrow("injected failure after write");

    expect(await stateOf(workspaceId, agentId)).toEqual(before);
    expect(committedRoutineFollowUp).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("rolls everything back when a database constraint fails partway, and a retry with the same key starts clean", async () => {
    const { accountId, workspaceId, agentId } = await createAgent();
    const before = await stateOf(workspaceId, agentId);
    const { service } = buildService();
    const unknownDestination = randomUUID();
    const failing = pack([
      directiveItem("directive-1", "confirm-details"),
      routineItem("routine-1", "book-appointment", {
        completionExport: { enabled: true, triggerKinds: ["complete"], destinationRef: unknownDestination },
      }),
    ], "retry-key-1");

    await expect(service.apply(workspaceId, agentId, { accountId }, failing)).rejects.toMatchObject({ statusCode: 400 });
    expect(await stateOf(workspaceId, agentId)).toEqual(before);

    const corrected = pack([directiveItem("directive-1", "confirm-details"), routineItem("routine-1", "book-appointment")], "retry-key-1");
    const retried = await service.apply(workspaceId, agentId, { accountId }, corrected);
    expect(retried.replayed).toBe(false);
    expect((await stateOf(workspaceId, agentId)).directives.map((row) => row.name)).toEqual(["confirm-details"]);
  });

  it("is atomic across directives: a failure on the second directive removes the first", async () => {
    const { accountId, workspaceId, agentId } = await createAgent();
    const before = await stateOf(workspaceId, agentId);
    const { service } = buildService({ failOnDirective: "no-diagnosis" });

    await expect(service.apply(workspaceId, agentId, { accountId }, pack([
      directiveItem("directive-1", "confirm-details"),
      directiveItem("directive-2", "no-diagnosis"),
    ]))).rejects.toThrow("injected failure after write");

    expect(await stateOf(workspaceId, agentId)).toEqual(before);
  });

  it("serializes concurrent requests with the same key: one creates, the other replays", async () => {
    const { accountId, workspaceId, agentId } = await createAgent();
    const request = pack([directiveItem("directive-1", "confirm-details"), routineItem("routine-1", "book-appointment")]);

    const results = await Promise.all([
      buildService().service.apply(workspaceId, agentId, { accountId }, request),
      buildService().service.apply(workspaceId, agentId, { accountId }, request),
    ]);

    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(results[0]?.applyId).toBe(results[1]?.applyId);
    const after = await stateOf(workspaceId, agentId);
    expect(after.directives).toHaveLength(1);
    expect(after.routines).toHaveLength(1);
    expect(after.applies).toHaveLength(1);
  });

  it("lets only one of two concurrent applies with different keys create the same names", async () => {
    const { accountId, workspaceId, agentId } = await createAgent();
    const items = [directiveItem("directive-1", "confirm-details"), routineItem("routine-1", "book-appointment")];

    const results = await Promise.allSettled([
      buildService().service.apply(workspaceId, agentId, { accountId }, pack(items)),
      buildService().service.apply(workspaceId, agentId, { accountId }, pack(items)),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toMatchObject({ statusCode: 409, code: "starter_pack_name_conflict" });
    const after = await stateOf(workspaceId, agentId);
    expect(after.directives.map((row) => row.name)).toEqual(["confirm-details"]);
    expect(after.routines.map((row) => row.name)).toEqual(["book-appointment"]);
  });

  it("never lets an apply and a direct directive write both create the same name", async () => {
    const { accountId, workspaceId, agentId } = await createAgent();
    const directWriter = new AuthoredDirectiveService({
      repository: new AgentRepository(database.kysely),
      coherenceChecker: coherentChecker,
      registeredCapabilityNames,
    });

    const results = await Promise.allSettled([
      buildService().service.apply(workspaceId, agentId, { accountId }, pack([
        directiveItem("directive-1", "confirm-details"),
        directiveItem("directive-2", "no-diagnosis"),
      ])),
      directWriter.create(workspaceId, agentId, directive("no-diagnosis", "Written directly.")),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const names = (await stateOf(workspaceId, agentId)).directives.map((row) => row.name);
    expect(names.filter((name) => name === "no-diagnosis")).toHaveLength(1);
    // Either the whole pack landed, or only the direct write did; never a partial pack.
    expect([["confirm-details", "no-diagnosis"], ["no-diagnosis"]]).toContainEqual(names);
  });

  it("makes every coherence model call while the agent's lock is free and no apply transaction holds it", async () => {
    const { accountId, workspaceId, agentId } = await createAgent();
    // Positive control: the probe does see the lock while a transaction holds it.
    const heldResult = await database.kysely.transaction().execute(async (trx) => {
      await transactionAdvisoryLock(agentRevisionLockKey(workspaceId, agentId)).execute(trx);
      return agentLockIsFree(workspaceId, agentId);
    });
    expect(heldResult).toBe(false);

    const lockFreeDuringCalls: boolean[] = [];
    const checker: DirectiveCoherenceChecker = {
      check: async () => {
        lockFreeDuringCalls.push(await agentLockIsFree(workspaceId, agentId));
        return { coherent: true, conflicts: [], rationale: "Probe verdict." };
      },
    };
    const { service, checkerInsideTransaction } = buildService(undefined, checker);

    await service.apply(workspaceId, agentId, { accountId }, pack([
      directiveItem("directive-1", "confirm-details"),
      directiveItem("directive-2", "no-diagnosis"),
      routineItem("routine-1", "book-appointment"),
    ]));

    expect(lockFreeDuringCalls).toEqual([true, true]);
    expect(checkerInsideTransaction).not.toHaveBeenCalled();
    expect((await stateOf(workspaceId, agentId)).directives).toHaveLength(2);
  });

  it("saves with the unavailable verdict when the greeting instruction changes during assessment, a change the draft generation does not record", async () => {
    const { accountId, workspaceId, agentId } = await createAgent();
    const generations: number[] = [];
    let calls = 0;
    const checker: DirectiveCoherenceChecker = {
      check: async () => {
        calls += 1;
        // Another writer edits the agent while the assessment is in flight.
        generations.push((await stateOf(workspaceId, agentId)).draftGeneration);
        await agents.update(agentId, workspaceId, { greetingInstruction: "Willkommen in der Praxis!" });
        generations.push((await stateOf(workspaceId, agentId)).draftGeneration);
        return { coherent: false, conflicts: [], rationale: "Verdict on the old greeting." };
      },
    };
    const { service, checkerInsideTransaction } = buildService(undefined, checker);

    const result = await service.apply(workspaceId, agentId, { accountId }, pack([directiveItem("directive-1", "confirm-details")]));

    // The draft generation is unchanged by the greeting edit, so only the content hash could notice.
    expect(generations[0]).toBe(generations[1]);
    // Advisory: the stale verdict is replaced, not reassessed, and the apply goes through.
    expect(calls).toBe(1);
    expect(result.replayed).toBe(false);
    expect(result.items[0]).toMatchObject({ coherence: { coherent: true, conflicts: [], rationale: "Coherence check unavailable." } });
    expect((await stateOf(workspaceId, agentId)).directives.map((row) => row.name)).toEqual(["confirm-details"]);
    expect(checkerInsideTransaction).not.toHaveBeenCalled();
  });

  it("refuses a directive that excludes one listed after it before any model call, and accepts the same pack in the other order", async () => {
    const { accountId, workspaceId, agentId } = await createAgent();
    const check = vi.fn(coherentChecker.check);
    const { service } = buildService(undefined, { check });
    const before = await stateOf(workspaceId, agentId);

    await expect(service.apply(workspaceId, agentId, { accountId }, pack([
      directiveItem("directive-1", "short-answers", undefined, ["detailed-answers"]),
      directiveItem("directive-2", "detailed-answers"),
    ]))).rejects.toMatchObject({ statusCode: 400 });
    expect(check).not.toHaveBeenCalled();
    expect(await stateOf(workspaceId, agentId)).toEqual(before);

    await service.apply(workspaceId, agentId, { accountId }, pack([
      directiveItem("directive-2", "detailed-answers"),
      directiveItem("directive-1", "short-answers", undefined, ["detailed-answers"]),
    ]));
    expect((await stateOf(workspaceId, agentId)).directives.map((row) => row.name)).toEqual(["detailed-answers", "short-answers"]);
  });

  it("returns each directive's verdict with references to earlier pack directives resolved, and replays it", async () => {
    const { accountId, workspaceId, agentId } = await createAgent();
    const checker: DirectiveCoherenceChecker = {
      check: async (input) => input.candidate.name === "no-diagnosis"
        ? { coherent: false, conflicts: [{ directiveId: pendingDirectiveId("directive-1"), directiveName: "confirm-details", reason: "Overlaps." }], rationale: "Conflict." }
        : { coherent: true, conflicts: [], rationale: "Coherent." },
    };
    const { service } = buildService(undefined, checker);
    const request = pack([directiveItem("directive-1", "confirm-details"), directiveItem("directive-2", "no-diagnosis")]);

    const first = await service.apply(workspaceId, agentId, { accountId }, request);
    const replay = await service.apply(workspaceId, agentId, { accountId }, request);

    const [confirm, noDiagnosis] = first.items;
    expect(confirm).toMatchObject({ kind: "directive", coherence: { coherent: true } });
    expect(noDiagnosis).toMatchObject({
      kind: "directive",
      coherence: { coherent: false, conflicts: [{ directiveId: confirm?.id, directiveName: "confirm-details" }] },
    });
    expect(replay).toEqual({ ...first, replayed: true });
  });

  it("lets two concurrent applies with different names both succeed, the later one saving the unavailable verdict", async () => {
    const { accountId, workspaceId, agentId } = await createAgent();
    // Hold both assessments until each has started, so both run before either transaction.
    let arrived = 0;
    let releaseBoth!: () => void;
    const bothArrived = new Promise<void>((resolve) => { releaseBoth = resolve; });
    const checker: DirectiveCoherenceChecker = {
      check: async () => {
        arrived += 1;
        if (arrived === 2) releaseBoth();
        await bothArrived;
        return { coherent: true, conflicts: [], rationale: "Verdict." };
      },
    };

    const results = await Promise.all([
      buildService(undefined, checker).service.apply(workspaceId, agentId, { accountId }, pack([directiveItem("directive-1", "confirm-details")])),
      buildService(undefined, checker).service.apply(workspaceId, agentId, { accountId }, pack([directiveItem("directive-1", "no-diagnosis")])),
    ]);

    expect(results.map((result) => result.replayed)).toEqual([false, false]);
    expect(arrived).toBe(2);
    // The apply that took the lock second was assessed without the other's directive, so its verdict is stale.
    const rationales = results.map((result) => result.items[0]?.kind === "directive" ? result.items[0].coherence.rationale : null);
    expect(rationales.sort()).toEqual(["Coherence check unavailable.", "Verdict."]);
    // Which apply takes the lock first is a race, so only the set of names is fixed.
    expect((await stateOf(workspaceId, agentId)).directives.map((row) => row.name).sort()).toEqual(["confirm-details", "no-diagnosis"]);
  });
});
