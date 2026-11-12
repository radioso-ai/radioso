import type {
  SkillDispatchResult,
  SkillExecutorPort,
  SkillInvocation,
  ToolService,
  ToolSkillExecutorPort,
} from "@radioso/conversation-contract";

import { mergeToolInput, type SkillBinding } from "../skillDefinitions/resolver.js";
import { setTraceAttributes, traceOperation } from "../../../shared/observability/tracing/operations.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import type { ToolImageIntake, ToolImageIntakeDropReason } from "../../toolImages/contracts/index.js";
import type { McpToolImageSink } from "../toolService/mcpToolImages.js";

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
   * lookup so the refresh/persist logic stays in composition.
   */
  oauthAccessTokenProvider?: () => Promise<string>;
}

/** Persisted skill definition: a named binding of one tool on one connection. */
export interface SkillDefinitionRecord extends SkillBinding {
  id: string;
  agentId: string;
  workspaceId: string;
  skillName: string;
  connectionId: string;
  enabled: boolean;
}

export interface SkillDefinitionLookup {
  findEnabledByName(agentId: string, skillName: string): Promise<SkillDefinitionRecord | null>;
}

export interface ConnectionLookup {
  findById(workspaceId: string, connectionId: string): Promise<McpConnectionRecord | null>;
}

/** What one call's tool service is given beside its connection. */
export interface ToolServiceCallOptions {
  /** Keeps the pictures the call returns as bytes, for the conversation that made it. */
  images?: McpToolImageSink;
}

/** Builds a ToolService (MCP client) for a given connection, including auth. */
export interface ToolServiceFactory {
  create(connection: McpConnectionRecord, call?: ToolServiceCallOptions): ToolService;
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
  /** Optional: emits one redacted warn log per settled failed dispatch. */
  logger?: Pick<AppLogger, "warn">;
  /** Optional: keeps the pictures a tool returns as bytes; without it, they are dropped. */
  imageIntake?: ToolImageIntake;
  metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
}

const contextString = (context: Record<string, unknown> | undefined, key: string): string | undefined => {
  const value = context?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

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
        ...(result.disposition === "settled" && result.outcome.status === "failed" && result.outcome.error?.code
          ? { "external_skill.error_code": result.outcome.error.code }
          : {}),
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

    const connection = await this.deps.connections.findById(record.workspaceId, record.connectionId);
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
      service = this.deps.toolServices.create(connection, { images: this.imageSinkFor(invocation.context) });
    } catch {
      return settledFailure("tool_service_unavailable", "External skill connection could not be initialized");
    }

    try {
      const toolExecutor = this.deps.toolSkillExecutorFactory(service);
      const result = await toolExecutor.dispatch({
        skill: { name: skillName, metadata: { conversationTool: { toolName: record.toolName } } },
        collected: input,
        context: invocation.context,
        emit: invocation.emit,
        signal: invocation.signal,
      });
      if (result.disposition === "settled" && result.outcome.status === "failed") {
        // Identity + code only — never params, results, URLs, or tokens.
        this.deps.logger?.warn({
          event: "external_skill",
          agentId,
          connectionId: connection.id,
          skillName,
          toolName: record.toolName,
          code: result.outcome.error?.code,
        }, "external_skill_dispatch_failed");
      }
      return result;
    } finally {
      await closable(service).close?.().catch(() => undefined);
    }
  }

  /**
   * Binds the intake to the conversation the call serves. A conversation that is not stored, such
   * as a replay or Test Chat, has nothing to keep pictures for, so they are dropped and counted.
   */
  private imageSinkFor(context: Record<string, unknown> | undefined): McpToolImageSink {
    const dropped = (reason: ToolImageIntakeDropReason): void => {
      this.deps.metrics?.incrementCounter("tool_image_intake_dropped_total", {
        help: "Pictures a tool returned as bytes that were not kept, by reason",
        labels: { reason },
      });
    };
    const intake = this.deps.imageIntake;
    const workspaceId = contextString(context, "workspaceId");
    const conversationId = contextString(context, "conversationId");
    if (!intake || !workspaceId || !conversationId || context?.conversationDurability === "ephemeral") {
      return { keep: async () => ({ kept: false, reason: "no_conversation" }), dropped };
    }
    return { keep: (bytes) => intake.accept({ workspaceId, conversationId, bytes }), dropped };
  }
}
