import { randomUUID } from "node:crypto";

import type { AgentRevisionService } from "../../modules/agents/public.js";
import { TrustedTestExecutionRunnerAdapter, createTestChatPhotoTurns } from "../../modules/chat/composition.js";
import { TestExecutionService } from "../../modules/test-execution/testExecution.js";
import type { VisitorImageTurnInput } from "../../modules/visitorImages/public.js";
import { createLiveAgentConfigReader } from "./liveAgentConfigReader.js";

type ServiceOptions = ConstructorParameters<typeof TestExecutionService>[0];
type RunnerOptions = ConstructorParameters<typeof TrustedTestExecutionRunnerAdapter>[0];

/**
 * Test Chat's private tests: the service over the test-execution store, running every turn through
 * the trusted runner on the revision under test, seeding a test from a conversation, and taking a
 * message's photos through the chat door's own claim, bound to the test rather than a message.
 */
export const buildTestExecutionService = (deps: {
  store: ServiceOptions["repository"] & ServiceOptions["revisions"] & RunnerOptions["revisions"];
  agentRevisions: Pick<AgentRevisionService, "resolveDefaultTestRevision">;
  contextCatalog: ServiceOptions["contextCatalog"];
  agentRepository: Parameters<typeof createLiveAgentConfigReader>[0]["agentRepository"];
  chat: { workbenchReplayRunner: RunnerOptions["replay"]; chatBootstrapService: RunnerOptions["bootstrap"]; testExecutionSeedSource: ServiceOptions["seedSource"] };
  visitorImages: VisitorImageTurnInput;
  usageLimitPolicy: ServiceOptions["usageLimitPolicy"];
  audit: ServiceOptions["audit"];
  logger: ServiceOptions["logger"];
}): TestExecutionService => new TestExecutionService({
  revisions: deps.store,
  // The agents module owns which revision a test runs when the caller names none.
  defaultRevision: { resolveDefault: ({ workspaceId, agentId }) => deps.agentRevisions.resolveDefaultTestRevision(workspaceId, agentId) },
  contextCatalog: deps.contextCatalog,
  repository: deps.store,
  runner: new TrustedTestExecutionRunnerAdapter({
    replay: deps.chat.workbenchReplayRunner,
    liveAgentConfig: createLiveAgentConfigReader({ agentRepository: deps.agentRepository }),
    revisions: deps.store,
    bootstrap: deps.chat.chatBootstrapService,
  }),
  seedSource: deps.chat.testExecutionSeedSource,
  photos: createTestChatPhotoTurns(deps.visitorImages),
  usageLimitPolicy: deps.usageLimitPolicy,
  audit: deps.audit,
  logger: deps.logger,
  createId: randomUUID,
});
