import { createToolSkillExecutor } from "@radioso/conversation-tools";
import type { Kysely } from "kysely";

import type { ApplicationModule } from "../src/app/composition/applicationModule.js";
import { McpConnectionRepository } from "../src/db/repositories/mcpConnectionRepository.js";
import { AgentSkillRepository } from "../src/modules/agentSkills/public.js";
import type { AuthoredDirectiveService } from "../src/modules/agents/public.js";
import { McpSkillExecutor } from "../src/modules/externalSkills/executor/mcpSkillExecutor.js";
import { EXTERNAL_SKILLS_ADAPTER } from "../src/modules/externalSkills/public.js";
import { SdkMcpToolService } from "../src/modules/externalSkills/toolService/sdkMcpToolService.js";
import type { DB } from "../src/shared/infra/kysely/types.js";
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

/**
 * Binds the tool-card agent's turns to the stub search: the MCP connection its skill targets, the
 * agent-selectable skill, and a directive that always applies. Idempotent: a repeat run finds them.
 */
export const seedToolCardAgent = async (
  deps: { db: Kysely<DB>; authoredDirectives: Pick<AuthoredDirectiveService, "create"> },
  target: { workspaceId: string; agentId: string },
): Promise<void> => {
  const connections = new McpConnectionRepository(deps.db);
  const connection = (await connections.listByWorkspace(target.workspaceId)).find((row) => row.displayName === STUB_CONNECTION.displayName)
    ?? await connections.create({ workspaceId: target.workspaceId, ...STUB_CONNECTION, authMethod: "access_token", status: "authorized" });
  const skills = new AgentSkillRepository(deps.db);
  if (!await skills.findByName(target.workspaceId, target.agentId, TOOL_CARD_SKILL_NAME)) {
    await skills.create({
      workspaceId: target.workspaceId,
      agentId: target.agentId,
      skillName: TOOL_CARD_SKILL_NAME,
      kind: "external_mcp",
      invocationMode: "agent_selectable",
      targetType: "mcp_connection",
      targetId: connection.id,
    });
  }
  try {
    await deps.authoredDirectives.create(target.workspaceId, target.agentId, toolCardDirective);
  } catch (error) {
    console.warn(`  seed: directive "${toolCardDirective.name}" skipped — ${(error as Error).message}`);
  }
};
