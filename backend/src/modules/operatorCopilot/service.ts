import { randomUUID } from "node:crypto";

import type { AgenticCapabilityRunner, AgentTool, AgentTraceEvent } from "../../shared/agent-runtime/index.js";
import type { AuditService } from "../audit/contracts/index.js";
import type { UsageLimitPolicy } from "../../shared/domain/usageLimitPolicy.js";
import type {
  CopilotPageContext,
  CopilotSseEvent,
  CopilotToolDescriptor,
  CopilotTurnOutcome,
} from "./contracts.js";
import { mapCopilotTraceEvent, outcomeFromTerminatedReason } from "./sse.js";

const COPILOT_BUDGETS = { maxSteps: 6, maxToolResultTokens: 12_000, maxWallTimeMs: 30_000 } as const;
const TITLE_MAX_LENGTH = 120;
// Bounded history keeps follow-up turns anchored without letting long copilot
// conversations grow the model context unboundedly (spec 104 edge case).
const HISTORY_MESSAGE_LIMIT = 12;
const HISTORY_MESSAGE_CHARS = 2_000;

export interface CopilotConversation {
  readonly id: string;
  readonly workspaceId: string;
  readonly operatorUserId: string;
  readonly title: string | null;
  readonly status: "idle" | "running";
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CopilotMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly role: "operator" | "copilot";
  readonly content: string;
  readonly outcome?: CopilotTurnOutcome;
  readonly activity?: ReadonlyArray<{ tool: string; outcome: "completed" | "failed" }>;
  readonly createdAt: Date;
}

export interface CopilotRepositoryPort {
  createConversation(input: { workspaceId: string; operatorUserId: string; title: string | null }): Promise<CopilotConversation>;
  findConversation(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<CopilotConversation | null>;
  listConversations(input: { workspaceId: string; operatorUserId: string }): Promise<ReadonlyArray<CopilotConversation>>;
  deleteConversation(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<boolean>;
  createMessage(input: Omit<CopilotMessage, "id" | "createdAt">): Promise<CopilotMessage>;
  listMessages(input: { conversationId: string }): Promise<ReadonlyArray<CopilotMessage>>;
  acquireTurn(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<CopilotConversation | "running" | null>;
  finishTurn(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<void>;
}

export interface OperatorCopilotServiceDeps {
  readonly repository: CopilotRepositoryPort;
  readonly capabilityRunner: Pick<AgenticCapabilityRunner, "runStreaming">;
  readonly usageLimitPolicy: UsageLimitPolicy;
  readonly auditService: AuditService;
  readonly prompt: string;
  readonly tools: ReadonlyArray<CopilotToolDescriptor>;
  readonly now?: () => Date;
}

export class OperatorCopilotService {
  constructor(private readonly deps: OperatorCopilotServiceDeps) {}

  async list(workspaceId: string, operatorUserId: string): Promise<ReadonlyArray<CopilotConversation>> {
    return this.deps.repository.listConversations({ workspaceId, operatorUserId });
  }

  async get(workspaceId: string, operatorUserId: string, id: string): Promise<{
    conversation: CopilotConversation;
    messages: ReadonlyArray<CopilotMessage>;
  } | null> {
    const conversation = await this.deps.repository.findConversation({ id, workspaceId, operatorUserId });
    if (!conversation) return null;
    return { conversation, messages: await this.deps.repository.listMessages({ conversationId: id }) };
  }

  async delete(workspaceId: string, operatorUserId: string, id: string): Promise<boolean> {
    return this.deps.repository.deleteConversation({ id, workspaceId, operatorUserId });
  }

  async *runTurn(input: {
    workspaceId: string;
    accountId: string;
    operatorUserId: string;
    conversationId: string | null;
    message: string;
    pageContext: CopilotPageContext;
    permissions: ReadonlySet<string>;
  }): AsyncGenerator<CopilotSseEvent> {
    const conversation = await this.openConversation(input);
    if (conversation === "running") throw new CopilotConflictError();
    if (conversation === null) throw new CopilotNotFoundError();
    const turnId = randomUUID();
    const now = this.deps.now ?? (() => new Date());
    const startedAt = now();
    const reservation = await this.deps.usageLimitPolicy.reserveAnswer({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      surface: "operator_copilot",
    });
    let terminalPersisted = false;
    const activity: Array<{ tool: string; outcome: "completed" | "failed" }> = [];
    const labels = new Map(this.deps.tools.map((tool) => [tool.name, tool.uiLabel]));
    const tools = this.resolveTools(input, labels);
    try {
      const priorTranscript = await this.buildPriorTranscript(conversation.id);
      await this.deps.repository.createMessage({ conversationId: conversation.id, role: "operator", content: input.message });
      await this.deps.auditService.record({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        eventType: "copilot.turn.started",
        eventStatus: "success",
        metadata: { conversationId: conversation.id, turnId },
      });
      yield { event: "conversation", data: { conversationId: conversation.id, turnId } };
      const stream = this.deps.capabilityRunner.runStreaming(
        {
          systemPrompt: this.deps.prompt,
          userMessage: priorTranscript ? `${priorTranscript}\n${input.message}` : input.message,
        },
        tools,
        COPILOT_BUDGETS,
      );
      for await (const trace of stream.events) {
        const event = mapCopilotTraceEvent(trace, labels);
        trackActivity(trace, labels, activity);
        if (event) yield event;
      }
      const result = await stream.result;
      const outcome = outcomeFromTerminatedReason(result.terminatedReason);
      await this.persistTerminal(conversation, result.finalMessage ?? "", outcome, activity);
      terminalPersisted = true;
      await reservation.commit();
      await this.recordTerminal(input, conversation.id, turnId, outcome, startedAt, now(), activity);
      yield { event: "outcome", data: { status: outcome } };
    } catch (error) {
      if (!terminalPersisted) {
        await this.persistTerminal(conversation, "", "failed", activity);
        terminalPersisted = true;
        await reservation.commit();
        await this.recordTerminal(input, conversation.id, turnId, "failed", startedAt, now(), activity);
      }
      yield { event: "outcome", data: { status: "failed" } };
    } finally {
      if (!terminalPersisted) await reservation.release();
      await this.deps.repository.finishTurn({ id: conversation.id, workspaceId: input.workspaceId, operatorUserId: input.operatorUserId });
      yield { event: "done", data: {} };
    }
  }

  private async openConversation(input: { workspaceId: string; operatorUserId: string; conversationId: string | null; message: string }): Promise<CopilotConversation | "running" | null> {
    if (input.conversationId) {
      return this.deps.repository.acquireTurn({ id: input.conversationId, workspaceId: input.workspaceId, operatorUserId: input.operatorUserId });
    }
    const conversation = await this.deps.repository.createConversation({
      workspaceId: input.workspaceId,
      operatorUserId: input.operatorUserId,
      title: titleFor(input.message),
    });
    const acquired = await this.deps.repository.acquireTurn({ id: conversation.id, workspaceId: input.workspaceId, operatorUserId: input.operatorUserId });
    return acquired;
  }

  private resolveTools(input: { workspaceId: string; operatorUserId: string; pageContext: CopilotPageContext; permissions: ReadonlySet<string> }, labels: ReadonlyMap<string, string>): ReadonlyArray<AgentTool> {
    return this.deps.tools
      .filter((descriptor) => input.permissions.has(descriptor.requiredPermission))
      .map((descriptor) => descriptor.createTool({ workspaceId: input.workspaceId, operatorUserId: input.operatorUserId, pageContext: input.pageContext }))
      .map((tool) => ({ ...tool, description: tool.description, name: tool.name, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema, invoke: tool.invoke } as AgentTool));
  }

  private async buildPriorTranscript(conversationId: string): Promise<string | null> {
    const messages = await this.deps.repository.listMessages({ conversationId });
    if (messages.length === 0) return null;
    const lines = messages.slice(-HISTORY_MESSAGE_LIMIT).map((message) => {
      const content =
        message.content.length > HISTORY_MESSAGE_CHARS
          ? `${message.content.slice(0, HISTORY_MESSAGE_CHARS)}…`
          : message.content;
      return `${message.role === "operator" ? "Operator" : "Copilot"}: ${content}`;
    });
    return `Earlier messages in this copilot conversation:\n${lines.join("\n")}\n\nCurrent operator message:\n`;
  }

  private async persistTerminal(conversation: CopilotConversation, content: string, outcome: CopilotTurnOutcome, activity: ReadonlyArray<{ tool: string; outcome: "completed" | "failed" }>): Promise<void> {
    await this.deps.repository.createMessage({ conversationId: conversation.id, role: "copilot", content, outcome, activity });
  }

  private async recordTerminal(input: { workspaceId: string; accountId: string }, conversationId: string, turnId: string, outcome: CopilotTurnOutcome, startedAt: Date, completedAt: Date, activity: ReadonlyArray<{ tool: string; outcome: "completed" | "failed" }>): Promise<void> {
    await this.deps.auditService.record({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: outcome === "failed" ? "copilot.turn.failed" : "copilot.turn.completed",
      eventStatus: outcome === "failed" ? "failure" : "success",
      metadata: { conversationId, turnId, durationMs: completedAt.getTime() - startedAt.getTime(), toolCalls: activity.length, toolFailures: activity.filter((entry) => entry.outcome === "failed").length, budgetExhausted: outcome === "budget_exhausted" },
    });
  }
}

const trackActivity = (trace: AgentTraceEvent, labels: ReadonlyMap<string, string>, activity: Array<{ tool: string; outcome: "completed" | "failed" }>): void => {
  if (trace.kind === "tool_call_completed") activity.push({ tool: labels.get(trace.toolName) ?? "Operator capability", outcome: "completed" });
  if (trace.kind === "tool_call_failed" || trace.kind === "tool_call_rejected") activity.push({ tool: labels.get(trace.toolName) ?? "Operator capability", outcome: "failed" });
};

const titleFor = (message: string): string => message.slice(0, TITLE_MAX_LENGTH);

export class CopilotConflictError extends Error {}
export class CopilotNotFoundError extends Error {}
