import { createToolSkillExecutor } from "@radioso/conversation-tools";
import type { Kysely } from "kysely";

import type { ApplicationModule } from "../src/app/composition/applicationModule.js";
import { McpConnectionRepository } from "../src/db/repositories/mcpConnectionRepository.js";
import { AgentSkillRepository } from "../src/modules/agentSkills/public.js";
import type { AuthoredDirectiveService } from "../src/modules/agents/public.js";
import type { RoutineDefinitionService } from "../src/modules/routines/public.js";
import { McpSkillExecutor } from "../src/modules/externalSkills/executor/mcpSkillExecutor.js";
import { EXTERNAL_SKILLS_ADAPTER } from "../src/modules/externalSkills/public.js";
import { SdkMcpToolService } from "../src/modules/externalSkills/toolService/sdkMcpToolService.js";
import type { DB } from "../src/shared/infra/kysely/types.js";
import { propertyFlowRoutine } from "../tests/fixtures/conversation-quality/routineCardCases.js";
import { TOOL_CARD_SKILL_NAME, toolCardDirective, toolCardStubTool } from "../tests/fixtures/conversation-quality/toolCardCases.js";
import { connectMockMcpServer } from "../tests/support/mockMcpServer.js";

/** The connection the tool-card agent's skill targets. Never dialled: the eval answers in process. */
const STUB_CONNECTION = { displayName: "Conversation-quality catalog (stub)", serverUrl: "https://catalog.homes.example/mcp" } as const;

/**
 * The external-skills executor for an eval run, in place of the one that dials MCP servers: every
 * external skill is the stub catalog search, answered by an in-process MCP server over an
 * in-memory transport, so the eval opens no connection and reaches no address. Registered as an
 * application module ahead of the default executor, which then stands aside; only the eval's
 * dependency graph is built with it.
 */
export const toolCardStubModule = (): ApplicationModule => ({
  id: "eval-tool-card-stub",
  register(context) {
    context.registerSkillExecutor({
      kind: "internal",
      adapter: EXTERNAL_SKILLS_ADAPTER,
      executor: new McpSkillExecutor({
        skills: {
          findEnabledByName: async (agentId, skillName) => skillName === TOOL_CARD_SKILL_NAME
            ? {
                id: TOOL_CARD_SKILL_NAME,
                agentId,
                workspaceId: "",
                skillName,
                connectionId: "",
                toolName: toolCardStubTool.name,
                boundParams: {},
                exposedParams: { message: { description: "The visitor's message." } },
                enabled: true,
              }
            : null,
        },
        connections: { findById: async (_workspaceId, connectionId) => ({ id: connectionId, serverUrl: STUB_CONNECTION.serverUrl, authMethod: "access_token" }) },
        toolServices: {
          create: () => new SdkMcpToolService({
            transportFactory: async () => (await connectMockMcpServer([toolCardStubTool])).clientTransport,
          }),
        },
        toolSkillExecutorFactory: createToolSkillExecutor,
      }),
    });
  },
});

/** The stub catalog search as one of the agent's skills, and the MCP connection it targets. Idempotent. */
const seedStubSearchSkill = async (
  db: Kysely<DB>,
  target: { workspaceId: string; agentId: string },
  invocationMode: "agent_selectable" | "routine_named",
): Promise<void> => {
  const connections = new McpConnectionRepository(db);
  const connection = (await connections.listByWorkspace(target.workspaceId)).find((row) => row.displayName === STUB_CONNECTION.displayName)
    ?? await connections.create({ workspaceId: target.workspaceId, ...STUB_CONNECTION, authMethod: "access_token", status: "authorized" });
  const skills = new AgentSkillRepository(db);
  if (!await skills.findByName(target.workspaceId, target.agentId, TOOL_CARD_SKILL_NAME)) {
    await skills.create({
      workspaceId: target.workspaceId,
      agentId: target.agentId,
      skillName: TOOL_CARD_SKILL_NAME,
      kind: "external_mcp",
      invocationMode,
      targetType: "mcp_connection",
      targetId: connection.id,
    });
  }
};

/**
 * Gives the routine-card agent the stub search as a routine's skill and the viewing routine whose
 * step shows its results (#1763), with no directive, so the routine claims the turn. Returns the
 * fixture routine id mapped to the live one. Idempotent: a repeat run finds them.
 */
export const seedRoutineCardAgent = async (
  deps: { db: Kysely<DB>; routines: Pick<RoutineDefinitionService, "createDraft" | "list"> },
  target: { workspaceId: string; agentId: string },
): Promise<Map<string, string>> => {
  await seedStubSearchSkill(deps.db, target, "routine_named");
  const { id: fixtureId, ...draft } = propertyFlowRoutine;
  const existing = (await deps.routines.list(target.workspaceId, target.agentId)).find((routine) => routine.name === draft.name && routine.enabled);
  const liveId = existing?.id ?? (await deps.routines.createDraft(target.workspaceId, target.agentId, draft)).routine.id;
  return new Map([[fixtureId, liveId]]);
};

/**
 * Binds the tool-card agent's turns to the stub search: the MCP connection its skill targets, the
 * agent-selectable skill, and a directive that always applies. Idempotent: a repeat run finds them.
 */
export const seedToolCardAgent = async (
  deps: { db: Kysely<DB>; authoredDirectives: Pick<AuthoredDirectiveService, "create"> },
  target: { workspaceId: string; agentId: string },
): Promise<void> => {
  await seedStubSearchSkill(deps.db, target, "agent_selectable");
  try {
    await deps.authoredDirectives.create(target.workspaceId, target.agentId, toolCardDirective);
  } catch (error) {
    console.warn(`  seed: directive "${toolCardDirective.name}" skipped — ${(error as Error).message}`);
  }
};
