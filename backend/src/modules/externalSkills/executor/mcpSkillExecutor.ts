import type {
  SkillDispatchResult,
  SkillExecutorPort,
  SkillInvocation,
  ToolService,
  ToolSkillExecutorPort,
} from "@radioso/conversation-contract";

import { mergeToolInput, type SkillBinding } from "../skillDefinitions/resolver.js";
import { setTraceAttributes, traceOperation } from "../../../shared/observability/tracing/operations.js";

/** Skill-executor descriptor adapter shared by all external (MCP) skills. */
export const EXTERNAL_SKILLS_ADAPTER = "external-skills";

/** Persisted MCP connection (the bits the executor needs to reach the server). */
export interface McpConnectionRecord {
  id: string;
  serverUrl: string;
  authMethod: "access_token" | "oauth";
  /** Decrypted access token (access_token connections; resolved by the lookup; never logged). */
  accessToken?: string;
  /**
   * OAuth connections: resolves a fresh bearer token at call time (refreshing
   * transparently). Throws if the connection is not authorized / refresh fails,
   * which degrades the skill to its failure outcome. Built by the connection
   * lookup so the agent-bound refresh/persist logic stays in composition.
   */
  oauthAccessTokenProvider?: () => Promise<string>;
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

/**
 * Wraps a ToolService into the transport-agnostic `ToolSkillBridge` executor.
 * Injected from composition: `conversation-tools` is a concrete that domain/runtime
 * code must not import directly (boundary rule `engine-concretes-only-via-composition`),
 * so the `createToolSkillExecutor` factory is supplied here instead.
 */
export type ToolSkillExecutorFactory = (service: ToolService) => ToolSkillExecutorPort;

export interface McpSkillExecutorDeps {
  skills: SkillDefinitionLookup;
  connections: ConnectionLookup;
  toolServices: ToolServiceFactory;
  toolSkillExecutorFactory: ToolSkillExecutorFactory;
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
    return traceOperation({
      name: "external_skill.dispatch",
      attributes: { "external_skill.name": invocation.skill.name },
      run: () => this.dispatchInner(invocation),
      resultAttributes: (result) => ({
        "external_skill.outcome_status": result.disposition === "settled" ? result.outcome.status : "deferred",
      }),
    });
  }

  private async dispatchInner(invocation: SkillInvocation): Promise<SkillDispatchResult> {
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

    // Observability: identity only (ids) — never params, secrets, or results.
    setTraceAttributes({
      "external_skill.agent_id": agentId,
      "external_skill.connection_id": connection.id,
      "external_skill.tool_name": record.toolName,
    });

    const input = mergeToolInput(record, invocation.collected);

    let service: ToolService;
    try {
      // Building the ToolService resolves the connection's credentials/auth; a
      // failure here (missing secret, invalid auth state) must degrade to a
      // settled failure, not a rejected dispatch.
      service = this.deps.toolServices.create(connection);
    } catch {
      return settledFailure("tool_service_unavailable", "External skill connection could not be initialized");
    }

    try {
      const toolExecutor = this.deps.toolSkillExecutorFactory(service);
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
