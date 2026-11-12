import { randomUUID } from "node:crypto";

import { TestExecutionRepository } from "../../db/repositories/testExecutionRepository.js";
import type { AgentRevisionService } from "../../modules/agents/public.js";
import { TrustedTestExecutionRunnerAdapter, createTestChatPhotoTurns } from "../../modules/chat/composition.js";
import { TestExecutionService } from "../../modules/test-execution/testExecution.js";
import { bindVisitorImageClaimIn } from "../../modules/visitorImages/composition.js";
import type { VisitorImageTurnInput } from "../../modules/visitorImages/public.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import { createLiveAgentConfigReader } from "./liveAgentConfigReader.js";

type ServiceOptions = ConstructorParameters<typeof TestExecutionService>[0];
type RunnerOptions = ConstructorParameters<typeof TrustedTestExecutionRunnerAdapter>[0];

/**
 * Test Chat's private tests: the service over the test-execution store, running every turn through
 * the trusted runner on the revision under test, seeding a test from a conversation, and taking a
 * message's photos through the chat door's own claim. The store binds those photos to the test in
 * the transaction that stores the turn, through the photo store on that transaction.
 */
export const buildTestExecutionService = (deps: {
  db: Db;
  agentRevisions: Pick<AgentRevisionService, "resolveDefaultTestRevision">;
  contextCatalog: ServiceOptions["contextCatalog"];
  agentRepository: Parameters<typeof createLiveAgentConfigReader>[0]["agentRepository"];
  chat: { workbenchReplayRunner: RunnerOptions["replay"]; chatBootstrapService: RunnerOptions["bootstrap"]; testExecutionSeedSource: ServiceOptions["seedSource"] };
  visitorImages: VisitorImageTurnInput;
  usageLimitPolicy: ServiceOptions["usageLimitPolicy"];
  audit: ServiceOptions["audit"];
  logger: ServiceOptions["logger"];
}): TestExecutionService => {
  const store = new TestExecutionRepository(deps.db, (trx, photos) => bindVisitorImageClaimIn(trx)({ ...photos, boundAt: new Date() }));
  return new TestExecutionService({
    revisions: store,
    // The agents module owns which revision a test runs when the caller names none.
    defaultRevision: { resolveDefault: ({ workspaceId, agentId }) => deps.agentRevisions.resolveDefaultTestRevision(workspaceId, agentId) },
    contextCatalog: deps.contextCatalog,
    repository: store,
    runner: new TrustedTestExecutionRunnerAdapter({
      replay: deps.chat.workbenchReplayRunner,
      liveAgentConfig: createLiveAgentConfigReader({ agentRepository: deps.agentRepository }),
      revisions: store,
      bootstrap: deps.chat.chatBootstrapService,
    }),
    seedSource: deps.chat.testExecutionSeedSource,
    photos: createTestChatPhotoTurns(deps.visitorImages),
    usageLimitPolicy: deps.usageLimitPolicy,
    audit: deps.audit,
    logger: deps.logger,
    createId: randomUUID,
  });
};
