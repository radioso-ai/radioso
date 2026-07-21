import { describe, expect, it, vi } from "vitest";

import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import type {
  ConversationSummaryRecord,
  ConversationSummaryStore,
} from "../../src/modules/chat/contracts/conversationSummary.js";
import {
  ConversationSummaryService,
  type ConversationSummaryGenerator,
  type ConversationSummaryMessageReader,
} from "../../src/modules/chat/services/summary/conversationSummaryService.js";

const message = (overrides: Partial<MessageRecord> & Pick<MessageRecord, "id" | "role" | "content">): MessageRecord => ({
  conversationId: "conv_1",
  workspaceId: "ws_1",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

const messageReader = (messages: MessageRecord[]): ConversationSummaryMessageReader => ({
  async countByConversationId() {
    return messages.length;
  },
  async listRecentByConversationId(_ws, _conv, limit) {
    return messages.slice(-limit);
  },
});

const inMemoryStore = (initial?: ConversationSummaryRecord): ConversationSummaryStore & {
  saved?: ConversationSummaryRecord;
} => {
  const state = { current: initial ?? null };
  const store = {
    saved: undefined as ConversationSummaryRecord | undefined,
    async load() {
      return state.current;
    },
    async save(input: { sessionId: string; summary: ConversationSummaryRecord }) {
      state.current = input.summary;
      store.saved = input.summary;
    },
  };
  return store;
};

const fifteenMessages = (): MessageRecord[] =>
  Array.from({ length: 15 }, (_, index) =>
    message({
      id: `m${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index}`,
      createdAt: new Date(2026, 0, 1, 0, index),
    }),
  );

const config = {
  minMessages: 10,
  refreshEveryMessages: 6,
  maxSourceMessages: 40,
  maxSourceMessageChars: 500,
  maxSummaryChars: 1_500,
};

describe("ConversationSummaryService", () => {
  it("skips regeneration below the message threshold without calling the model or store", async () => {
    const store = inMemoryStore();
    const save = vi.spyOn(store, "save");
    const generator: ConversationSummaryGenerator = { generate: vi.fn() };
    const service = new ConversationSummaryService(store, messageReader([
      message({ id: "a", role: "user", content: "hi" }),
      message({ id: "b", role: "assistant", content: "hello" }),
    ]), generator, undefined, config);

    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });

    expect(generator.generate).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("assembles the regeneration input from the previous summary plus clamped message tail and saves the watermark", async () => {
    const messages = [
      message({ id: "old", role: "user", content: "x".repeat(20) }),
      ...fifteenMessages(),
    ];
    const store = inMemoryStore({
      summary: "Earlier: the user asked about refunds.",
      coveredMessageCount: 10,
      coveredThrough: new Date("2026-01-01T00:00:00.000Z"),
    });
    let capturedPrompt = "";
    const generator: ConversationSummaryGenerator = {
      generate: vi.fn(async ({ prompt }) => {
        capturedPrompt = prompt;
        return "Fresh summary of the conversation.";
      }),
    };
    const service = new ConversationSummaryService(store, messageReader(messages), generator, undefined, {
      ...config,
      maxSourceMessages: 3,
      maxSourceMessageChars: 500,
    });

    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1", accountId: "acct_1" });

    expect(generator.generate).toHaveBeenCalledOnce();
    // Previous summary seeds the call.
    expect(capturedPrompt).toContain("Earlier: the user asked about refunds.");
    // Only the last maxSourceMessages appear (window of 3: messages 12-14).
    expect(capturedPrompt).toContain("message 14");
    expect(capturedPrompt).toContain("message 12");
    expect(capturedPrompt).not.toContain("message 11");
    // Usage context is passed for accounting.
    const call = vi.mocked(generator.generate).mock.calls[0]![0];
    expect(call.usageContext).toMatchObject({
      workspaceId: "ws_1",
      conversationId: "conv_1",
      accountId: "acct_1",
      operation: "conversation_summary",
    });
    // Watermark is the true total message count, not the tail length.
    expect(store.saved).toEqual({
      summary: "Fresh summary of the conversation.",
      coveredMessageCount: messages.length,
      coveredThrough: messages.at(-1)!.createdAt,
    });
  });

  it("debounces regeneration while the uncovered tail still fits the recent window", async () => {
    const store = inMemoryStore({
      summary: "Existing summary.",
      coveredMessageCount: 12,
      coveredThrough: new Date("2026-01-01T00:00:00.000Z"),
    });
    const save = vi.spyOn(store, "save");
    const generator: ConversationSummaryGenerator = { generate: vi.fn() };
    // 15 total, 12 covered: 3 uncovered < refreshEveryMessages (6) → skip.
    const service = new ConversationSummaryService(store, messageReader(fifteenMessages()), generator, undefined, config);

    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });

    expect(generator.generate).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("makes the usage attempt key unique per regeneration coverage", async () => {
    const generator: ConversationSummaryGenerator = { generate: vi.fn(async () => "fresh") };
    const service = new ConversationSummaryService(inMemoryStore(), messageReader(fifteenMessages()), generator, undefined, config);

    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });

    // A fixed per-conversation key would collide in the usage ledger's
    // idempotency dedupe and drop every regeneration after the first.
    const call = vi.mocked(generator.generate).mock.calls[0]![0];
    expect(call.usageContext.attemptKey).toBe("conversation_summary:conv_1:15");
  });

  it("skips when the conversational (non-system) population is below the threshold", async () => {
    const store = inMemoryStore();
    const save = vi.spyOn(store, "save");
    const generator: ConversationSummaryGenerator = { generate: vi.fn() };
    // 12 rows cross the cheap count gate, but only 4 are user/assistant.
    const messages = [
      ...Array.from({ length: 8 }, (_, index) =>
        message({ id: `sys${index}`, role: "system", content: `system event ${index}` })),
      ...fifteenMessages().slice(0, 4),
    ];
    const service = new ConversationSummaryService(store, messageReader(messages), generator, undefined, config);

    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });

    expect(generator.generate).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("never persists a lone surrogate when the clamp cuts inside a surrogate pair", async () => {
    const store = inMemoryStore();
    const generator: ConversationSummaryGenerator = {
      generate: vi.fn(async () => `${"a".repeat(18)}😀 and more text`),
    };
    const service = new ConversationSummaryService(store, messageReader(fifteenMessages()), generator, undefined, {
      ...config,
      maxSummaryChars: 20,
    });

    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });

    // The cut point (index 19) lands between the emoji's surrogate halves; the
    // clamp must back off rather than persist a lone surrogate (which would
    // become U+FFFD in Postgres and poison every prompt injection).
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
    expect(loneSurrogate.test(store.saved!.summary)).toBe(false);
    expect(store.saved?.summary.endsWith("…")).toBe(true);
    expect(store.saved!.summary.length).toBeLessThanOrEqual(20);
  });

  it("clamps each source message excerpt in the regeneration input", async () => {
    const messages = [
      ...fifteenMessages().slice(0, 14),
      message({ id: "long", role: "user", content: "SUPER_LONG_" + "z".repeat(80), createdAt: new Date(2026, 0, 2) }),
    ];
    let capturedPrompt = "";
    const generator: ConversationSummaryGenerator = {
      generate: vi.fn(async ({ prompt }) => {
        capturedPrompt = prompt;
        return "ok";
      }),
    };
    const service = new ConversationSummaryService(inMemoryStore(), messageReader(messages), generator, undefined, {
      ...config,
      maxSourceMessageChars: 12,
    });

    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });

    expect(capturedPrompt).toContain("…");
    expect(capturedPrompt).not.toContain("z".repeat(80));
  });

  it("hard-clamps the generated summary before persisting", async () => {
    const store = inMemoryStore();
    const generator: ConversationSummaryGenerator = {
      generate: vi.fn(async () => "y".repeat(50)),
    };
    const service = new ConversationSummaryService(store, messageReader(fifteenMessages()), generator, undefined, {
      ...config,
      maxSummaryChars: 20,
    });

    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });

    expect(store.saved?.summary.length).toBe(20);
    expect(store.saved?.summary.endsWith("…")).toBe(true);
  });

  it("does not save when the model returns a blank summary", async () => {
    const store = inMemoryStore();
    const save = vi.spyOn(store, "save");
    const generator: ConversationSummaryGenerator = { generate: vi.fn(async () => "   ") };
    const service = new ConversationSummaryService(store, messageReader(fifteenMessages()), generator, undefined, config);

    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });

    expect(save).not.toHaveBeenCalled();
  });

  it("tolerates a model failure without throwing and logs a content-free failure event", async () => {
    const store = inMemoryStore();
    const save = vi.spyOn(store, "save");
    const generator: ConversationSummaryGenerator = {
      generate: vi.fn(async () => {
        throw new Error("provider exploded");
      }),
    };
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const service = new ConversationSummaryService(store, messageReader(fifteenMessages()), generator, logger, config);

    await expect(service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" })).resolves.toBeUndefined();

    expect(save).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "conversation_summary_generation_failed", conversationId: "conv_1" }),
      expect.any(String),
    );
    // The log payload never carries summary/message content.
    const [payload] = logger.warn.mock.calls[0]!;
    expect(JSON.stringify(payload)).not.toContain("message 14");
  });
});

describe("conversationSummary behavior config", () => {
  it("keeps the refresh interval below the recent-message window", async () => {
    const { CHAT_BEHAVIOR, RETRIEVAL_BEHAVIOR } = await import("../../src/shared/domain/behaviorConfig.js");
    // If the interval reached the window size, messages between the summary
    // watermark and the visible window could fall out of both.
    expect(CHAT_BEHAVIOR.conversationSummary.refreshEveryMessages).toBeLessThan(
      RETRIEVAL_BEHAVIOR.rewriteConversationContextMaxMessages,
    );
  });
});
