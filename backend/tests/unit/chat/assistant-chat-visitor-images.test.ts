import { describe, expect, it, vi } from "vitest";

import { AppError } from "../../../src/shared/domain/errors.js";
import { AssistantChatService } from "../../../src/modules/chat/composition.js";
import type { ChatStreamEvent } from "../../../src/modules/chat/contracts/index.js";
import type { UserMessageStoredListener } from "../../../src/modules/chat/types/assistantApi.js";
import type { VisitorImageClaim, VisitorImageTurnInput } from "../../../src/modules/visitorImages/public.js";

const IMAGE_A = "6c3e9f2a-1d4b-4b8e-9f0a-2a4c6e8b0d12";
const IMAGE_B = "7d4f0a3b-2e5c-4c9f-8a1b-3b5d7f9c1e23";
const OWNER = { kind: "public_session" as const, id: "4b6d8f0a-2c4e-4f6a-8b0d-1e3f5a7c9e33" };

const claimOf = (images: VisitorImageClaim["images"]): VisitorImageClaim => ({ claimId: "claim-1", images });

const imagesPort = (claim: VisitorImageClaim = claimOf([
  { id: IMAGE_A, reading: "A stone farmhouse with a terracotta roof." },
  { id: IMAGE_B, reading: null },
])) => ({
  claim: vi.fn<VisitorImageTurnInput["claim"]>(async () => claim),
  bind: vi.fn<VisitorImageTurnInput["bind"]>(async () => undefined),
  release: vi.fn<VisitorImageTurnInput["release"]>(async () => undefined),
});

type TurnInput = { onUserMessageStored?: UserMessageStoredListener };

/** A turn that stores the user message, as the preparer does, then answers. */
const answered = (conversationId = "conversation-1") => ({
  answer: vi.fn(async (input: TurnInput) => {
    await input.onUserMessageStored?.({ conversationId, messageId: `${conversationId}-message` });
    return {
      conversationId,
      agentId: "agent-1",
      answer: "Answer",
      citations: [],
      answerSegments: [],
      suggestions: [],
      activitySummary: {},
      route: { type: "direct", reason: "social_only" },
    };
  }),
  streamAnswer: vi.fn(async function* (input: TurnInput): AsyncGenerator<ChatStreamEvent> {
    yield { type: "status", stage: "interpreting" };
    await input.onUserMessageStored?.({ conversationId, messageId: `${conversationId}-message` });
    yield { type: "conversation", conversationId };
    yield { type: "chunk", text: "Answer" };
  }),
});

const send = {
  workspaceId: "workspace-1",
  agentId: "agent-1",
  stream: false,
  message: "  Something like this, near the coast ",
  imageIds: [IMAGE_A, IMAGE_B],
  imageOwner: OWNER,
};

const drain = async (events: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> => {
  const seen: ChatStreamEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
};

describe("AssistantChatService with photos", () => {
  it("runs the turn on the typed text followed by each photo's reading, and stores the structured form", async () => {
    const chatService = answered();
    const visitorImages = imagesPort();
    const service = new AssistantChatService(chatService as never, { startConversation: vi.fn() } as never, { visitorImages });

    await service.answer(send);

    expect(visitorImages.claim).toHaveBeenCalledWith({ workspaceId: "workspace-1", agentId: "agent-1", owner: OWNER, imageIds: [IMAGE_A, IMAGE_B] });
    expect(chatService.answer).toHaveBeenCalledWith(expect.objectContaining({
      query: [
        "Something like this, near the coast",
        "<visitor_image index=\"1\">A stone farmhouse with a terracotta roof.</visitor_image>",
        "<visitor_image index=\"2\" unread/>",
      ].join("\n"),
      inputMetadata: {
        method: "typed",
        imageInput: {
          typedText: "Something like this, near the coast",
          images: [{ id: IMAGE_A, reading: "A stone farmhouse with a terracotta roof." }, { id: IMAGE_B, reading: null }],
        },
      },
    }));
  });

  it("takes photos with no typed text", async () => {
    const chatService = answered();
    const service = new AssistantChatService(chatService as never, { startConversation: vi.fn() } as never, {
      visitorImages: imagesPort(claimOf([{ id: IMAGE_A, reading: "A red bicycle." }])),
    });

    await service.answer({ ...send, message: undefined, imageIds: [IMAGE_A] });

    expect(chatService.answer).toHaveBeenCalledWith(expect.objectContaining({
      query: "<visitor_image index=\"1\">A red bicycle.</visitor_image>",
      inputMetadata: { method: "typed", imageInput: { typedText: "", images: [{ id: IMAGE_A, reading: "A red bicycle." }] } },
    }));
  });

  it("keeps how the visitor sent the message beside the photos", async () => {
    const chatService = answered();
    const service = new AssistantChatService(chatService as never, { startConversation: vi.fn() } as never, { visitorImages: imagesPort() });

    await service.answer({ ...send, inputMetadata: { method: "suggestion_click", suggestionSourceMessageId: "message-1" } });

    expect(chatService.answer).toHaveBeenCalledWith(expect.objectContaining({
      inputMetadata: expect.objectContaining({ method: "suggestion_click", suggestionSourceMessageId: "message-1", imageInput: expect.any(Object) }),
    }));
  });

  it("binds the photos to the user message the turn stores, while the turn is still running", async () => {
    const visitorImages = imagesPort();
    let boundBeforeTurnEnded = false;
    const chatService = {
      answer: vi.fn(async (input: TurnInput) => {
        await input.onUserMessageStored?.({ conversationId: "conversation-9", messageId: "message-9" });
        boundBeforeTurnEnded = visitorImages.bind.mock.calls.length === 1;
        return { conversationId: "conversation-9" };
      }),
    };
    const service = new AssistantChatService(chatService as never, { startConversation: vi.fn() } as never, { visitorImages });

    await service.answer(send);

    expect(boundBeforeTurnEnded).toBe(true);
    expect(visitorImages.bind).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      claim: await visitorImages.claim.mock.results[0].value,
      conversationId: "conversation-9",
      messageId: "message-9",
    });
    expect(visitorImages.release).not.toHaveBeenCalled();
  });

  it("keeps the photos with the stored message when the turn fails after storing it", async () => {
    const visitorImages = imagesPort();
    const chatService = {
      answer: vi.fn(async (input: TurnInput) => {
        await input.onUserMessageStored?.({ conversationId: "conversation-9", messageId: "message-9" });
        throw new AppError(429, "usage_limit_exceeded", "Usage limit exceeded");
      }),
    };
    const service = new AssistantChatService(chatService as never, { startConversation: vi.fn() } as never, { visitorImages });

    await expect(service.answer(send)).rejects.toMatchObject({ code: "usage_limit_exceeded" });

    expect(visitorImages.bind).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "conversation-9", messageId: "message-9" }));
    expect(visitorImages.release).not.toHaveBeenCalled();
  });

  it("lets the photos go when the turn fails before storing the message, so the caller can send them again", async () => {
    const visitorImages = imagesPort();
    const chatService = { answer: vi.fn(async () => { throw new AppError(409, "turn_superseded", "Superseded"); }) };
    const service = new AssistantChatService(chatService as never, { startConversation: vi.fn() } as never, { visitorImages });

    await expect(service.answer(send)).rejects.toMatchObject({ code: "turn_superseded" });

    expect(visitorImages.bind).not.toHaveBeenCalled();
    expect(visitorImages.release).toHaveBeenCalledWith({ workspaceId: "workspace-1", claim: await visitorImages.claim.mock.results[0].value });
  });

  it("fails the turn and lets the photos go when they cannot be bound", async () => {
    const visitorImages = imagesPort();
    visitorImages.bind.mockRejectedValueOnce(new Error("connection reset"));
    const service = new AssistantChatService(answered() as never, { startConversation: vi.fn() } as never, { visitorImages });

    await expect(service.answer(send)).rejects.toThrow("connection reset");

    expect(visitorImages.release).toHaveBeenCalledTimes(1);
  });

  it("binds a streamed turn's photos when it stores the message", async () => {
    const chatService = answered("conversation-7");
    const visitorImages = imagesPort();
    const service = new AssistantChatService(chatService as never, { startConversation: vi.fn() } as never, { visitorImages });

    const events = await drain(service.streamAnswer({ ...send, stream: true }));

    expect(events.map((event) => event.type)).toEqual(["status", "conversation", "chunk"]);
    expect(chatService.streamAnswer).toHaveBeenCalledWith(expect.objectContaining({ query: expect.stringContaining("A stone farmhouse with a terracotta roof.") }));
    expect(visitorImages.bind).toHaveBeenCalledTimes(1);
    expect(visitorImages.bind).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "conversation-7", messageId: "conversation-7-message" }));
    expect(visitorImages.release).not.toHaveBeenCalled();
  });

  it("lets a streamed turn's photos go when the stream is abandoned before the message is stored", async () => {
    const visitorImages = imagesPort();
    const service = new AssistantChatService(answered("conversation-7") as never, { startConversation: vi.fn() } as never, { visitorImages });

    for await (const event of service.streamAnswer({ ...send, stream: true })) {
      expect(event.type).toBe("status");
      break;
    }

    expect(visitorImages.bind).not.toHaveBeenCalled();
    expect(visitorImages.release).toHaveBeenCalledTimes(1);
  });

  it("refuses photos where no owner or agent is known, claiming nothing", async () => {
    const visitorImages = imagesPort();
    const service = new AssistantChatService(answered() as never, { startConversation: vi.fn() } as never, { visitorImages });

    await expect(service.answer({ ...send, imageOwner: undefined })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.answer({ ...send, agentId: undefined })).rejects.toMatchObject({ statusCode: 400 });
    expect(visitorImages.claim).not.toHaveBeenCalled();
  });

  it("refuses photos when no photo store is wired", async () => {
    const service = new AssistantChatService(answered() as never, { startConversation: vi.fn() } as never);

    await expect(service.answer(send)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("leaves a message without photos as it was", async () => {
    const chatService = answered();
    const visitorImages = imagesPort();
    const service = new AssistantChatService(chatService as never, { startConversation: vi.fn() } as never, { visitorImages });

    await service.answer({ workspaceId: "workspace-1", agentId: "agent-1", stream: false, message: "Hello" });

    expect(chatService.answer).toHaveBeenCalledWith(expect.objectContaining({ query: "Hello", inputMetadata: undefined }));
    expect(visitorImages.claim).not.toHaveBeenCalled();
    expect(visitorImages.release).not.toHaveBeenCalled();
  });
});
