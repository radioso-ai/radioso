import { describe, expect, it, vi } from "vitest";

import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import type {
  ConversationSummaryRecord,
  ConversationSummaryStore,
} from "../../src/modules/chat/contracts/conversationSummary.js";
import {
  ConversationSummaryService,
  type ConversationEarlyTitleGenerator,
  type ConversationSummaryGenerator,
  type ConversationSummaryMessageReader,
  type ConversationSummaryTitleWriter,
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

const inMemoryTitleWriter = (initialTitle?: string | null): ConversationSummaryTitleWriter & {
  calls: Array<{ conversationId: string; workspaceId: string; title: string }>;
} => {
  const state = { title: initialTitle ?? null };
  const calls: Array<{ conversationId: string; workspaceId: string; title: string }> = [];
  return {
    calls,
    async setTitle(conversationId: string, workspaceId: string, title: string) {
      calls.push({ conversationId, workspaceId, title });
      state.title = title;
    },
    async getTitle() {
      return state.title;
    },
  };
};

/** A title-only generator fake that never produces a title — the default double for
 * every test that doesn't exercise the early-title feature itself. */
const blankEarlyTitleGenerator = (): ConversationEarlyTitleGenerator & { generate: ReturnType<typeof vi.fn> } => ({
  generate: vi.fn(async () => ({})),
});

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
  maxInitialBackfillMessages: 160,
  maxSourceMessageChars: 500,
  maxSummaryChars: 1_500,
};

describe("ConversationSummaryService", () => {
  it("skips regeneration below the message threshold without calling the summary model, with no reply yet to title early either", async () => {
    const store = inMemoryStore();
    const save = vi.spyOn(store, "save");
    const generator: ConversationSummaryGenerator = { generate: vi.fn() };
    const earlyTitleGenerator = blankEarlyTitleGenerator();
    // A single user message: below threshold, and no assistant reply yet, so neither
    // the combined call nor the early-title call has anything to work from.
    const service = new ConversationSummaryService(store, messageReader([
      message({ id: "a", role: "user", content: "hi" }),
    ]), generator, inMemoryTitleWriter(), earlyTitleGenerator, undefined, config);

    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });

    expect(generator.generate).not.toHaveBeenCalled();
    expect(earlyTitleGenerator.generate).not.toHaveBeenCalled();
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
        return { summary: "Fresh summary of the conversation." };
      }),
    };
    const service = new ConversationSummaryService(store, messageReader(messages), generator, inMemoryTitleWriter(), blankEarlyTitleGenerator(), undefined, {
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
    const call = vi.mocked(generator.generate).mock.calls[0][0];
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

  it("backfills a first summary from the whole conversation in bounded chronological chunks", async () => {
    const messages = Array.from({ length: 9 }, (_, index) =>
      message({
        id: `m${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message ${index}`,
        createdAt: new Date(2026, 0, 1, 0, index),
      }),
    );
    const store = inMemoryStore();
    const prompts: string[] = [];
    const generator: ConversationSummaryGenerator = {
      generate: vi.fn(async ({ prompt }) => {
        prompts.push(prompt);
        return { summary: `summary ${prompts.length}` };
      }),
    };
    const service = new ConversationSummaryService(store, messageReader(messages), generator, inMemoryTitleWriter(), blankEarlyTitleGenerator(), undefined, {
      ...config,
      minMessages: 3,
      maxSourceMessages: 4,
      refreshEveryMessages: 2,
    });

    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });

    expect(generator.generate).toHaveBeenCalledTimes(3);
    expect(prompts[0]).toContain("message 0");
    expect(prompts[0]).toContain("message 3");
    expect(prompts[0]).not.toContain("message 4");
    expect(prompts[1]).toContain("summary 1");
    expect(prompts[1]).toContain("message 4");
    expect(prompts[1]).toContain("message 7");
    expect(prompts[2]).toContain("summary 2");
    expect(prompts[2]).toContain("message 8");
    expect(store.saved).toEqual({
      summary: "summary 3",
      coveredMessageCount: messages.length,
      coveredThrough: messages.at(-1)!.createdAt,
    });
  });

  it("caps first-summary backfill to a bounded recent history window", async () => {
    const messages = Array.from({ length: 13 }, (_, index) =>
      message({
        id: `m${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message ${index}`,
        createdAt: new Date(2026, 0, 1, 0, index),
      }),
    );
    const store = inMemoryStore();
    const prompts: string[] = [];
    const generator: ConversationSummaryGenerator = {
      generate: vi.fn(async ({ prompt }) => {
        prompts.push(prompt);
        return { summary: `summary ${prompts.length}` };
      }),
    };
    const service = new ConversationSummaryService(store, messageReader(messages), generator, inMemoryTitleWriter(), blankEarlyTitleGenerator(), undefined, {
      ...config,
      minMessages: 3,
      maxSourceMessages: 4,
      maxInitialBackfillMessages: 8,
      refreshEveryMessages: 2,
    });

    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });

    expect(generator.generate).toHaveBeenCalledTimes(2);
    expect(prompts[0]).not.toContain("message 4");
    expect(prompts[0]).toContain("message 5");
    expect(prompts[0]).toContain("message 8");
    expect(prompts[1]).toContain("summary 1");
    expect(prompts[1]).toContain("message 9");
    expect(prompts[1]).toContain("message 12");
    expect(vi.mocked(generator.generate).mock.calls.map(([call]) => call.usageContext.attemptKey)).toEqual([
      "conversation_summary:conv_1:13:backfill:0",
      "conversation_summary:conv_1:13:backfill:1",
    ]);
    expect(store.saved).toEqual({
      summary: "summary 2",
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
    const service = new ConversationSummaryService(store, messageReader(fifteenMessages()), generator, inMemoryTitleWriter(), blankEarlyTitleGenerator(), undefined, config);

    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });

    expect(generator.generate).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("makes the usage attempt key unique per regeneration coverage", async () => {
    const generator: ConversationSummaryGenerator = { generate: vi.fn(async () => ({ summary: "fresh" })) };
    const service = new ConversationSummaryService(inMemoryStore(), messageReader(fifteenMessages()), generator, inMemoryTitleWriter(), blankEarlyTitleGenerator(), undefined, config);

    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });

    // A fixed per-conversation key would collide in the usage ledger's
    // idempotency dedupe and drop every regeneration after the first.
    const call = vi.mocked(generator.generate).mock.calls[0][0];
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
    const service = new ConversationSummaryService(store, messageReader(messages), generator, inMemoryTitleWriter(), blankEarlyTitleGenerator(), undefined, config);

    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });

    expect(generator.generate).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("never persists a lone surrogate when the clamp cuts inside a surrogate pair", async () => {
    const store = inMemoryStore();
    const generator: ConversationSummaryGenerator = {
      generate: vi.fn(async () => ({ summary: `${"a".repeat(18)}😀 and more text` })),
    };
    const service = new ConversationSummaryService(store, messageReader(fifteenMessages()), generator, inMemoryTitleWriter(), blankEarlyTitleGenerator(), undefined, {
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
        return { summary: "ok" };
      }),
    };
    const service = new ConversationSummaryService(inMemoryStore(), messageReader(messages), generator, inMemoryTitleWriter(), blankEarlyTitleGenerator(), undefined, {
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
      generate: vi.fn(async () => ({ summary: "y".repeat(50) })),
    };
    const service = new ConversationSummaryService(store, messageReader(fifteenMessages()), generator, inMemoryTitleWriter(), blankEarlyTitleGenerator(), undefined, {
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
    const generator: ConversationSummaryGenerator = { generate: vi.fn(async () => ({ summary: "   " })) };
    const service = new ConversationSummaryService(store, messageReader(fifteenMessages()), generator, inMemoryTitleWriter(), blankEarlyTitleGenerator(), undefined, config);

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
    const service = new ConversationSummaryService(store, messageReader(fifteenMessages()), generator, inMemoryTitleWriter(), blankEarlyTitleGenerator(), logger, config);

    await expect(service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" })).resolves.toBeUndefined();

    expect(save).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "conversation_summary_generation_failed", conversationId: "conv_1" }),
      expect.any(String),
    );
    // The log payload never carries summary/message content.
    const [payload] = logger.warn.mock.calls[0];
    expect(JSON.stringify(payload)).not.toContain("message 14");
  });
});

describe("ConversationSummaryService title generation", () => {
  it("persists the generated title on the conversation row after the summary saves", async () => {
    const store = inMemoryStore();
    const titleWriter = inMemoryTitleWriter();
    const generator: ConversationSummaryGenerator = {
      generate: vi.fn(async () => ({ summary: "Fresh summary.", title: "Refund for order 4821" })),
    };
    const service = new ConversationSummaryService(store, messageReader(fifteenMessages()), generator, titleWriter, blankEarlyTitleGenerator(), undefined, config);

    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });

    expect(titleWriter.calls).toEqual([
      { conversationId: "conv_1", workspaceId: "ws_1", title: "Refund for order 4821" },
    ]);
    // The summary itself never carries the title — it stays a separate write to
    // a separate (non-expiring) row.
    expect(store.saved).toEqual(
      expect.not.objectContaining({ title: expect.anything() }),
    );
  });

  it("treats a blank title as absent and skips the title write", async () => {
    const titleWriter = inMemoryTitleWriter();
    const generator: ConversationSummaryGenerator = {
      generate: vi.fn(async () => ({ summary: "Fresh summary.", title: "   " })),
    };
    const service = new ConversationSummaryService(inMemoryStore(), messageReader(fifteenMessages()), generator, titleWriter, blankEarlyTitleGenerator(), undefined, config);

    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });

    expect(titleWriter.calls).toEqual([]);
  });

  it("treats an omitted title as absent and skips the title write", async () => {
    const titleWriter = inMemoryTitleWriter();
    const generator: ConversationSummaryGenerator = {
      generate: vi.fn(async () => ({ summary: "Fresh summary." })),
    };
    const service = new ConversationSummaryService(inMemoryStore(), messageReader(fifteenMessages()), generator, titleWriter, blankEarlyTitleGenerator(), undefined, config);

    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });

    expect(titleWriter.calls).toEqual([]);
  });

  it("clamps an overlong title before persisting", async () => {
    const titleWriter = inMemoryTitleWriter();
    const generator: ConversationSummaryGenerator = {
      generate: vi.fn(async () => ({ summary: "Fresh summary.", title: "t".repeat(50) })),
    };
    const service = new ConversationSummaryService(inMemoryStore(), messageReader(fifteenMessages()), generator, titleWriter, blankEarlyTitleGenerator(), undefined, {
      ...config,
      maxTitleChars: 20,
    });

    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });

    expect(titleWriter.calls).toHaveLength(1);
    expect(titleWriter.calls[0].title.length).toBeLessThanOrEqual(20);
    expect(titleWriter.calls[0].title.endsWith("…")).toBe(true);
  });

  it("normalizes internal whitespace in the title to a single line", async () => {
    const titleWriter = inMemoryTitleWriter();
    const generator: ConversationSummaryGenerator = {
      generate: vi.fn(async () => ({ summary: "Fresh summary.", title: "Refund\nfor  order   4821" })),
    };
    const service = new ConversationSummaryService(inMemoryStore(), messageReader(fifteenMessages()), generator, titleWriter, blankEarlyTitleGenerator(), undefined, config);

    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });

    expect(titleWriter.calls[0].title).toBe("Refund for order 4821");
  });

  it("does not save a title when the summary itself is blank (whole regeneration skipped)", async () => {
    const titleWriter = inMemoryTitleWriter();
    const generator: ConversationSummaryGenerator = {
      generate: vi.fn(async () => ({ summary: "   ", title: "Some topic" })),
    };
    const service = new ConversationSummaryService(inMemoryStore(), messageReader(fifteenMessages()), generator, titleWriter, blankEarlyTitleGenerator(), undefined, config);

    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });

    expect(titleWriter.calls).toEqual([]);
  });

  it("does not fail the whole regeneration when the title write itself throws", async () => {
    const store = inMemoryStore();
    const titleWriter: ConversationSummaryTitleWriter = {
      async setTitle() {
        throw new Error("db unavailable");
      },
      async getTitle() {
        return null;
      },
    };
    const generator: ConversationSummaryGenerator = {
      generate: vi.fn(async () => ({ summary: "Fresh summary.", title: "Some topic" })),
    };
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const service = new ConversationSummaryService(store, messageReader(fifteenMessages()), generator, titleWriter, blankEarlyTitleGenerator(), logger, config);

    await expect(service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" })).resolves.toBeUndefined();

    // The summary itself still saved: a title-write failure must not undo it.
    expect(store.saved?.summary).toBe("Fresh summary.");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "conversation_title_write_failed", conversationId: "conv_1" }),
      expect.any(String),
    );
    // Never logged as a failed regeneration — the summary succeeded.
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "conversation_summary_generation_failed" }),
      expect.any(String),
    );
  });

  it("writes the final chunk's title once after a multi-chunk backfill, not once per chunk", async () => {
    const messages = Array.from({ length: 9 }, (_, index) =>
      message({
        id: `m${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message ${index}`,
        createdAt: new Date(2026, 0, 1, 0, index),
      }),
    );
    const titleWriter = inMemoryTitleWriter();
    let call = 0;
    const generator: ConversationSummaryGenerator = {
      generate: vi.fn(async () => {
        call += 1;
        return { summary: `summary ${call}`, title: `title ${call}` };
      }),
    };
    const service = new ConversationSummaryService(inMemoryStore(), messageReader(messages), generator, titleWriter, blankEarlyTitleGenerator(), undefined, {
      ...config,
      minMessages: 3,
      maxSourceMessages: 4,
      refreshEveryMessages: 2,
    });

    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });

    expect(generator.generate).toHaveBeenCalledTimes(3);
    expect(titleWriter.calls).toEqual([
      { conversationId: "conv_1", workspaceId: "ws_1", title: "title 3" },
    ]);
  });
});

// Issue #1129: most real conversations (3-7 messages) never reach minMessages, so
// without a separate path the title feature is invisible for typical traffic. These
// tests exercise ConversationSummaryService's below-threshold branch directly.
describe("ConversationSummaryService early title generation", () => {
  const twoMessages = (): MessageRecord[] => [
    message({ id: "u1", role: "user", content: "I want to learn meditation" }),
    message({ id: "a1", role: "assistant", content: "Sure, here is a beginner overview." }),
  ];

  it("generates and persists an early title once the conversation has a user message and a reply, without calling the combined summary generator", async () => {
    const store = inMemoryStore();
    const save = vi.spyOn(store, "save");
    const titleWriter = inMemoryTitleWriter();
    const summaryGenerator: ConversationSummaryGenerator = { generate: vi.fn() };
    let capturedPrompt = "";
    const earlyTitleGenerator: ConversationEarlyTitleGenerator = {
      generate: vi.fn(async ({ prompt }) => {
        capturedPrompt = prompt;
        return { title: "Meditation for beginners" };
      }),
    };
    const service = new ConversationSummaryService(
      store,
      messageReader(twoMessages()),
      summaryGenerator,
      titleWriter,
      earlyTitleGenerator,
      undefined,
      config,
    );

    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });

    expect(summaryGenerator.generate).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(earlyTitleGenerator.generate).toHaveBeenCalledOnce();
    expect(capturedPrompt).toContain("I want to learn meditation");
    expect(titleWriter.calls).toEqual([
      { conversationId: "conv_1", workspaceId: "ws_1", title: "Meditation for beginners" },
    ]);
  });

  it("does not attempt an early title before there is at least one assistant reply", async () => {
    const titleWriter = inMemoryTitleWriter();
    const earlyTitleGenerator = blankEarlyTitleGenerator();
    const service = new ConversationSummaryService(
      inMemoryStore(),
      messageReader([message({ id: "u1", role: "user", content: "hi" })]),
      { generate: vi.fn() },
      titleWriter,
      earlyTitleGenerator,
      undefined,
      config,
    );

    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });

    expect(earlyTitleGenerator.generate).not.toHaveBeenCalled();
    expect(titleWriter.calls).toEqual([]);
  });

  it("skips the early-title call entirely once the conversation already has a title", async () => {
    const titleWriter = inMemoryTitleWriter("Existing title");
    const earlyTitleGenerator = blankEarlyTitleGenerator();
    const service = new ConversationSummaryService(
      inMemoryStore(),
      messageReader(twoMessages()),
      { generate: vi.fn() },
      titleWriter,
      earlyTitleGenerator,
      undefined,
      config,
    );

    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });

    expect(earlyTitleGenerator.generate).not.toHaveBeenCalled();
    expect(titleWriter.calls).toEqual([]);
  });

  it("retries on a later turn commit after a blank early title, and writes the title once a later attempt succeeds", async () => {
    const titleWriter = inMemoryTitleWriter();
    let call = 0;
    const earlyTitleGenerator: ConversationEarlyTitleGenerator = {
      generate: vi.fn(async () => {
        call += 1;
        return call === 1 ? {} : { title: "Meditation for beginners" };
      }),
    };
    const service = new ConversationSummaryService(
      inMemoryStore(),
      messageReader(twoMessages()),
      { generate: vi.fn() },
      titleWriter,
      earlyTitleGenerator,
      undefined,
      config,
    );

    // Turn 1: blank response, no title written yet.
    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });
    expect(titleWriter.calls).toEqual([]);

    // Turn 2 (a later turn commit, same conversation still below threshold and
    // title-less): retried, and this time it succeeds.
    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });
    expect(earlyTitleGenerator.generate).toHaveBeenCalledTimes(2);
    expect(titleWriter.calls).toEqual([
      { conversationId: "conv_1", workspaceId: "ws_1", title: "Meditation for beginners" },
    ]);
  });

  it("caps early-title attempts so a persistently blank model is not retried forever", async () => {
    const titleWriter = inMemoryTitleWriter();
    const earlyTitleGenerator: ConversationEarlyTitleGenerator = { generate: vi.fn(async () => ({})) };
    const service = new ConversationSummaryService(
      inMemoryStore(),
      messageReader(twoMessages()),
      { generate: vi.fn() },
      titleWriter,
      earlyTitleGenerator,
      undefined,
      { ...config, maxEarlyTitleAttempts: 2 },
    );

    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });
    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });
    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });

    // A third turn commit must not cost a third LLM call — the cap is 2.
    expect(earlyTitleGenerator.generate).toHaveBeenCalledTimes(2);
    expect(titleWriter.calls).toEqual([]);
  });

  it("counts a thrown error toward the attempt cap, logging a content-free failure event each time", async () => {
    const titleWriter = inMemoryTitleWriter();
    const earlyTitleGenerator: ConversationEarlyTitleGenerator = {
      generate: vi.fn(async () => {
        throw new Error("provider exploded");
      }),
    };
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const service = new ConversationSummaryService(
      inMemoryStore(),
      messageReader(twoMessages()),
      { generate: vi.fn() },
      titleWriter,
      earlyTitleGenerator,
      logger,
      { ...config, maxEarlyTitleAttempts: 2 },
    );

    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });
    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });
    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });

    expect(earlyTitleGenerator.generate).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "conversation_early_title_generation_failed", conversationId: "conv_1" }),
      expect.any(String),
    );
    // Content-free: the log payload never carries message content.
    for (const [payload] of logger.warn.mock.calls) {
      expect(JSON.stringify(payload)).not.toContain("meditation");
    }
  });

  it("never calls the early-title generator once the conversation reaches the summary threshold", async () => {
    const earlyTitleGenerator = blankEarlyTitleGenerator();
    const summaryGenerator: ConversationSummaryGenerator = {
      generate: vi.fn(async () => ({ summary: "Fresh summary.", title: "Combined-call title" })),
    };
    const service = new ConversationSummaryService(
      inMemoryStore(),
      messageReader(fifteenMessages()),
      summaryGenerator,
      inMemoryTitleWriter(),
      earlyTitleGenerator,
      undefined,
      config,
    );

    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });

    expect(summaryGenerator.generate).toHaveBeenCalledOnce();
    expect(earlyTitleGenerator.generate).not.toHaveBeenCalled();
  });

  it("logs the early-title write with content-free, duration/count-only fields", async () => {
    const titleWriter = inMemoryTitleWriter();
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const earlyTitleGenerator: ConversationEarlyTitleGenerator = {
      generate: vi.fn(async () => ({ title: "Meditation for beginners" })),
    };
    const service = new ConversationSummaryService(
      inMemoryStore(),
      messageReader(twoMessages()),
      { generate: vi.fn() },
      titleWriter,
      earlyTitleGenerator,
      logger,
      config,
    );

    await service.refresh({ workspaceId: "ws_1", conversationId: "conv_1" });

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ event: "conversation_early_title_written", conversationId: "conv_1", titleWritten: true }),
      expect.any(String),
    );
    const writtenCall = logger.debug.mock.calls.find(([payload]) => payload.event === "conversation_early_title_written");
    expect(JSON.stringify(writtenCall![0])).not.toContain("Meditation for beginners");
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

  it("caps early-title attempts to a small number, matching the retry policy", async () => {
    const { CHAT_BEHAVIOR } = await import("../../src/shared/domain/behaviorConfig.js");
    expect(CHAT_BEHAVIOR.conversationSummary.maxEarlyTitleAttempts).toBeGreaterThan(0);
    expect(CHAT_BEHAVIOR.conversationSummary.maxEarlyTitleAttempts).toBeLessThanOrEqual(3);
  });
});
