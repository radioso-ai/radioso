import { createToolSkillExecutor } from "@radioso/conversation-tools";
import type { ToolService } from "@radioso/conversation-tools";
import type {
  SkillDispatchResult,
  SkillExecutorPort,
  SkillInvocation,
} from "@radioso/conversation-defaults";

import { mergeToolInput, type SkillBinding } from "../skillDefinitions/resolver.js";

/** Persisted MCP connection (the bits the executor needs to reach the server). */
export interface McpConnectionRecord {
  id: string;
  serverUrl: string;
  authMethod: "access_token" | "oauth";
}

/** Persisted skill definition: a named binding of one tool on one connection. */
export interface SkillDefinitionRecord extends SkillBinding {
  id: string;
  agentId: string;
  skillName: string;
  connectionId: string;
  enabled: boolean;
}

export interface SkillDefinitionLookup {
  findEnabledByName(agentId: string, skillName: string): Promise<SkillDefinitionRecord | null>;
}

export interface ConnectionLookup {
  findById(agentId: string, connectionId: string): Promise<McpConnectionRecord | null>;
}

/** Builds a ToolService (MCP client) for a given connection, including auth. */
export interface ToolServiceFactory {
  create(connection: McpConnectionRecord): ToolService;
}

export interface McpSkillExecutorDeps {
  skills: SkillDefinitionLookup;
  connections: ConnectionLookup;
  toolServices: ToolServiceFactory;
}

const settledFailure = (code: string, message: string): SkillDispatchResult => ({
  disposition: "settled",
  outcome: { status: "failed", error: { code, message, retryable: false } },
});

const closable = (service: ToolService): { close?: () => Promise<void> } =>
  service as { close?: () => Promise<void> };

/**
 * Generic MCP skill executor — peer to `RetrievalAnswerSkillExecutor`. Resolves an
 * authored skill definition by name, merges its bound + conversation-supplied
 * params, and dispatches through the UNCHANGED `ToolSkillBridge`
 * (`createToolSkillExecutor`) so the result maps to the same `SkillOutcome` the
 * routine runner branches on. The conversation engine never sees MCP.
 *
 * The model can only reach authored, enabled skill definitions (looked up by the
 * routine-authored `skillName`); it can never select a raw discovered tool.
 */
export class McpSkillExecutor implements SkillExecutorPort {
  constructor(private readonly deps: McpSkillExecutorDeps) {}

  async dispatch(invocation: SkillInvocation): Promise<SkillDispatchResult> {
    const skillName = invocation.skill.name;
    const agentId = typeof invocation.context?.agentId === "string" ? invocation.context.agentId : undefined;
    if (!agentId) {
      return settledFailure("agent_context_missing", "External skill invoked without an agent context");
    }

    const record = await this.deps.skills.findEnabledByName(agentId, skillName);
    if (!record) {
      return settledFailure("skill_not_found", "External skill is not defined or not enabled");
    }

    const connection = await this.deps.connections.findById(agentId, record.connectionId);
    if (!connection) {
      return settledFailure("connection_unavailable", "External skill connection is unavailable");
    }

    const input = mergeToolInput(record, invocation.collected);
    const service = this.deps.toolServices.create(connection);
    try {
      const toolExecutor = createToolSkillExecutor(service);
      return (await toolExecutor.dispatch({
        skill: { name: skillName, metadata: { conversationTool: { toolName: record.toolName } } },
        collected: input,
        context: invocation.context,
        emit: invocation.emit,
        signal: invocation.signal,
      })) as SkillDispatchResult;
    } finally {
      await closable(service).close?.().catch(() => undefined);
    }
  }
}
