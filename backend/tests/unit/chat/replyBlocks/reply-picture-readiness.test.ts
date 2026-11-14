import { describe, expect, it, vi } from "vitest";

import type { MessageRecord } from "../../../../src/db/repositories/messageRepository.js";
import type { StoredReplyBlock } from "../../../../src/modules/chat/contracts/replyBlocks.js";
import { ReplyPictureReadiness } from "../../../../src/modules/chat/services/replyBlocks/replyPictureReadiness.js";

// Before a channel whose provider fetches a card's picture by its address sends the cards, the
// pictures must be stored: a skill's picture is copied after the reply is written, so the readiness
// check asks for each one now, which copies it on demand, and waits a bounded time.

const block = (imageIds: string[]): StoredReplyBlock => ({
  type: "item_list",
  id: "b1",
  layout: "carousel",
  selection: "single",
  caption: "Homes",
  items: imageIds.map((imageId, index) => ({
    key: `/results/${index}`,
    title: `Home ${index}`,
    image: { imageId, width: 640, height: 480, alt: "" },
    actions: [{ type: "select" }],
  })),
});

const message = (blocks: StoredReplyBlock[] | undefined): MessageRecord => ({
  id: "message-1",
  conversationId: "conversation-1",
  workspaceId: "workspace-1",
  role: "assistant",
  content: "Homes.",
  createdAt: new Date(0),
  ...(blocks ? { metadata: { blocks } } : {}),
});

const setup = (options: { stored: MessageRecord | null; servable: (imageId: string, call: number) => boolean | Promise<boolean> }) => {
  let clock = 0;
  const calls = new Map<string, number>();
  const findServable = vi.fn(async ({ imageId }: { imageId: string; width: number }) => {
    const call = (calls.get(imageId) ?? 0) + 1;
    calls.set(imageId, call);
    return (await options.servable(imageId, call)) ? { bucket: "b", objectPath: imageId } : null;
  });
  const readiness = new ReplyPictureReadiness({
    messages: { findByIdAndWorkspaceId: vi.fn(async () => options.stored) },
    pictures: { findServable },
    width: 640,
    pollMs: 250,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  return { readiness, findServable };
};

describe("reply picture readiness", () => {
  it("is ready at once when every picture is stored, asking for each at the width the cards show", async () => {
    const { readiness, findServable } = setup({ stored: message([block(["a", "b"])]), servable: () => true });

    await expect(readiness.awaitStored({ workspaceId: "workspace-1", messageId: "message-1", withinMs: 6000 })).resolves.toBe(true);
    expect(findServable.mock.calls.map(([input]) => input)).toEqual([{ imageId: "a", width: 640 }, { imageId: "b", width: 640 }]);
  });

  it("asks again for the pictures still being copied, until they are stored", async () => {
    const { readiness, findServable } = setup({ stored: message([block(["a", "b"])]), servable: (imageId, call) => imageId === "a" || call >= 3 });

    await expect(readiness.awaitStored({ workspaceId: "workspace-1", messageId: "message-1", withinMs: 6000 })).resolves.toBe(true);
    expect(findServable.mock.calls.filter(([input]) => input.imageId === "a")).toHaveLength(1);
    expect(findServable.mock.calls.filter(([input]) => input.imageId === "b")).toHaveLength(3);
  });

  it("gives up when a picture is not stored within the time it was given", async () => {
    const { readiness } = setup({ stored: message([block(["a", "b"])]), servable: (imageId) => imageId === "a" });

    await expect(readiness.awaitStored({ workspaceId: "workspace-1", messageId: "message-1", withinMs: 1000 })).resolves.toBe(false);
  });

  it("gives up when one lookup outlasts the time it was given", async () => {
    vi.useFakeTimers();
    try {
      const readiness = new ReplyPictureReadiness({
        messages: { findByIdAndWorkspaceId: vi.fn(async () => message([block(["a"])])) },
        pictures: { findServable: () => new Promise(() => undefined) },
        width: 640,
      });
      const ready = readiness.awaitStored({ workspaceId: "workspace-1", messageId: "message-1", withinMs: 2000 });
      await vi.advanceTimersByTimeAsync(2000);
      await expect(ready).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is ready for a reply whose cards show no picture, and not for a message it cannot find", async () => {
    const pictureless: StoredReplyBlock = { ...block([]), items: [{ key: "k", title: "Suite", actions: [] }] };

    await expect(setup({ stored: message([pictureless]), servable: () => false }).readiness.awaitStored({ workspaceId: "workspace-1", messageId: "message-1", withinMs: 6000 })).resolves.toBe(true);
    await expect(setup({ stored: null, servable: () => true }).readiness.awaitStored({ workspaceId: "workspace-1", messageId: "message-1", withinMs: 6000 })).resolves.toBe(false);
    await expect(setup({ stored: message(undefined), servable: () => true }).readiness.awaitStored({ workspaceId: "workspace-1", messageId: "message-1", withinMs: 6000 })).resolves.toBe(false);
  });
});
