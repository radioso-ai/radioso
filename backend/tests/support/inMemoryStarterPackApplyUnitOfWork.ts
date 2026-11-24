import type { StarterPackApplyUnitOfWork, StarterPackNameReads } from "../../src/modules/agentStarterPack/public.js";
import type { AuthoredDirectiveService } from "../../src/modules/agents/public.js";
import type { RoutineDefinitionService } from "../../src/modules/routines/public.js";

/**
 * The in-memory test app's stand-in for the Postgres unit of work. It serializes applies per
 * agent, as the agent draft lock does, and keeps the idempotency records in a map. It cannot roll
 * writes back; transaction rollback and atomicity are covered against Postgres in
 * `tests/integration/agent-starter-pack-apply.integration.test.ts`.
 */
export const createInMemoryStarterPackApply = (services: {
  authoredDirectiveService: Pick<AuthoredDirectiveService, "list" | "create" | "coherenceContextToken">;
  routineDefinitionService: Pick<RoutineDefinitionService, "findCreateConflict" | "createDraft">;
}): {
  unitOfWork: StarterPackApplyUnitOfWork;
  findCompletedApply(workspaceId: string, agentId: string, key: string): Promise<{ requestFingerprint: string; result: unknown } | null>;
  readNames(workspaceId: string, agentId: string): StarterPackNameReads;
} => {
  const records = new Map<string, { requestFingerprint: string; result: unknown }>();
  const queues = new Map<string, Promise<unknown>>();
  const readNames = (workspaceId: string, agentId: string): StarterPackNameReads => ({
    listDirectiveNames: async () =>
      (await services.authoredDirectiveService.list(workspaceId, agentId)).map((directive) => directive.name),
    routineNameTaken: async (name) =>
      (await services.routineDefinitionService.findCreateConflict(workspaceId, agentId, name)) !== null,
  });

  return {
    findCompletedApply: async (workspaceId, agentId, key) => records.get(`${workspaceId}:${agentId}:${key}`) ?? null,
    readNames,
    unitOfWork: {
      run(workspaceId, agentId, work) {
        const lockKey = `${workspaceId}:${agentId}`;
        const previous = queues.get(lockKey) ?? Promise.resolve();
        const current = previous.catch(() => undefined).then(() => work({
          ...readNames(workspaceId, agentId),
          coherenceContextToken: (candidates) =>
            services.authoredDirectiveService.coherenceContextToken(workspaceId, agentId, candidates),
          createDirective: async (directive, assessedCoherence) =>
            (await services.authoredDirectiveService.create(workspaceId, agentId, directive, { assessedCoherence })).directive,
          createRoutine: (routine) => services.routineDefinitionService.createDraft(workspaceId, agentId, routine),
          findApply: async (key) => records.get(`${lockKey}:${key}`) ?? null,
          recordApply: async (record) => {
            records.set(`${lockKey}:${record.idempotencyKey}`, {
              requestFingerprint: record.requestFingerprint,
              result: record.result,
            });
          },
        }));
        queues.set(lockKey, current);
        return current;
      },
    },
  };
};
