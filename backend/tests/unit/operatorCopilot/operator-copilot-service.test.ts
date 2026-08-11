import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  OperatorCopilotService,
  type CopilotConversation,
  type CopilotMessage,
  type CopilotRepositoryPort,
} from "../../../src/modules/operatorCopilot/public.js";

const now = new Date("2026-08-11T00:00:00.000Z");

describe("OperatorCopilotService", () => {
  it("persists a budget exhausted terminal turn, commits one reservation, and filters tools", async () => {
    const repository = new MemoryCopilotRepository();
    const commit = vi.fn(async () => {});
    const release = vi.fn(async () => {});
    const invoke = vi.fn(async () => ({ value: "safe" }));
    const service = new OperatorCopilotService({
      repository,
      capabilityRunner: {
        runStreaming: () => ({
          events: (async function* () {
            yield { kind: "tool_call_invoked" as const, stepIndex: 0, toolName: "visible", callId: "call", at: 1 };
            yield { kind: "tool_call_completed" as const, stepIndex: 0, toolName: "visible", callId: "call", output: { secret: "never stream" }, resultTokens: 1, latencyMs: 1, at: 2 };
          })(),
          result: Promise.resolve({ terminatedReason: "step_budget_exhausted" as const, finalMessage: "Partial result", stepsTaken: 6, toolResultTokensUsed: 1, wallTimeMs: 1 }),
        }),
      },
      usageLimitPolicy: { reserveAnswer: vi.fn(async () => ({ commit, release })), reserveDocument: vi.fn(), reserveIndexedStorage: vi.fn(), reserveMonthlyIndexedContent: vi.fn() },
      auditService: { record: vi.fn(async () => {}), getLatestSuccessfulChatAnswerMetadata: vi.fn(), updateChatAnswerSuggestions: vi.fn() },
      prompt: "system",
      tools: [
        tool("visible", "workspace.agents.read", invoke),
        tool("hidden", "workspace.history.read", vi.fn(async () => ({ value: "hidden" }))),
      ],
      now: () => now,
    });

    const events = [];
    for await (const event of service.runTurn({ workspaceId: "workspace", accountId: "account", operatorUserId: "operator", conversationId: null, message: "Investigate", pageContext: { view: "history", agentId: null, conversationId: null }, permissions: new Set(["workspace.agents.read"]) })) events.push(event);

    expect(events).toEqual([
      { event: "conversation", data: { conversationId: expect.any(String), turnId: expect.any(String) } },
      { event: "activity", data: { toolCallId: "call", tool: "Visible", stage: "started" } },
      { event: "activity", data: { toolCallId: "call", tool: "Visible", stage: "completed" } },
      { event: "outcome", data: { status: "budget_exhausted" } },
      { event: "done", data: {} },
    ]);
    expect(commit).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(repository.messages.at(-1)).toMatchObject({ role: "copilot", content: "Partial result", outcome: "budget_exhausted", activity: [{ tool: "Visible", outcome: "completed" }] });
  });
});

const tool = (name: string, requiredPermission: "workspace.agents.read" | "workspace.history.read", invoke: (input: unknown, ctx: unknown) => Promise<unknown>) => ({
  name,
  uiLabel: name === "visible" ? "Visible" : "Hidden",
  description: "reader",
  inputSchema: z.object({}),
  outputSchema: z.object({ value: z.string() }),
  requiredPermission,
  contributingModule: "test",
  createTool: () => ({ name, description: "reader", inputSchema: z.object({}), outputSchema: z.object({ value: z.string() }), invoke }),
});

class MemoryCopilotRepository implements CopilotRepositoryPort {
  conversations: CopilotConversation[] = [];
  messages: CopilotMessage[] = [];
  async createConversation(input: { workspaceId: string; operatorUserId: string; title: string | null }): Promise<CopilotConversation> { const conversation = { id: `c${this.conversations.length}`, ...input, status: "idle" as const, createdAt: now, updatedAt: now }; this.conversations.push(conversation); return conversation; }
  async findConversation(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<CopilotConversation | null> { return this.conversations.find((conversation) => conversation.id === input.id && conversation.workspaceId === input.workspaceId && conversation.operatorUserId === input.operatorUserId) ?? null; }
  async listConversations(): Promise<ReadonlyArray<CopilotConversation>> { return this.conversations; }
  async deleteConversation(): Promise<boolean> { return false; }
  async createMessage(input: Omit<CopilotMessage, "id" | "createdAt">): Promise<CopilotMessage> { const message = { id: `m${this.messages.length}`, ...input, createdAt: now }; this.messages.push(message); return message; }
  async listMessages(): Promise<ReadonlyArray<CopilotMessage>> { return this.messages; }
  async acquireTurn(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<CopilotConversation | "running" | null> { const conversation = await this.findConversation(input); if (!conversation) return null; if (conversation.status === "running") return "running"; return this.replace(conversation, "running"); }
  async finishTurn(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<void> { const conversation = await this.findConversation(input); if (conversation) this.replace(conversation, "idle"); }
  private replace(conversation: CopilotConversation, status: CopilotConversation["status"]): CopilotConversation { const next = { ...conversation, status }; this.conversations[this.conversations.indexOf(conversation)] = next; return next; }
}
