import { describe, expect, it, vi } from "vitest";

import type { ChatDoorPhotoTurnPort } from "../../../src/modules/chat/contracts/index.js";
import { AppError } from "../../../src/shared/domain/errors.js";
import {
  CONNECTOR_IMAGES_UNAVAILABLE_CODE,
  createConnectorImageTurns,
} from "../../../src/modules/connectors/services/connectorImageTurns.js";
import type { VisitorImageAvailability, VisitorImageService } from "../../../src/modules/visitorImages/public.js";

const IMAGE_A = "6c3e9f2a-1d4b-4b8e-9f0a-2a4c6e8b0d12";
const IMAGE_B = "7d4f0a3b-2e5c-4c9f-8a1b-3b5d7f9c1e23";
const PHOTO_A = new Uint8Array([0xff, 0xd8, 1]);
const PHOTO_B = new Uint8Array([0xff, 0xd8, 2]);

type Upload = Awaited<ReturnType<VisitorImageService["upload"]>>;
type DoorAnswer = Awaited<ReturnType<ChatDoorPhotoTurnPort["answer"]>>;

const setup = (overrides: {
  availability?: Awaited<ReturnType<VisitorImageAvailability["forAgent"]>>;
  conversationAgentId?: string | null;
  uploads?: Upload[];
  door?: DoorAnswer;
} = {}) => {
  const uploads = [...(overrides.uploads ?? [
    { kind: "accepted" as const, id: IMAGE_A, readingStatus: "read" as const },
    { kind: "accepted" as const, id: IMAGE_B, readingStatus: "read" as const },
  ])];
  const images = {
    upload: vi.fn<VisitorImageService["upload"]>(async () => uploads.shift() ?? { kind: "rejected", reason: "unsupported_type" }),
  };
  const door = {
    answer: vi.fn<ChatDoorPhotoTurnPort["answer"]>(async () => (overrides.door === undefined
      ? { conversationId: "conversation-new", answer: "Looks lovely.", skillOutcome: "grounded" }
      : overrides.door)),
  };
  const agents = { resolve: vi.fn(async (_workspaceId: string, agentId?: string | null) => ({ id: agentId ?? "default-agent" })) };
  const conversations = {
    findByIdAndWorkspaceId: vi.fn(async () => (
      overrides.conversationAgentId === undefined ? null : { agentId: overrides.conversationAgentId }
    )),
  };
  const availability = { forAgent: vi.fn(async () => overrides.availability ?? "available" as const) };
  const turns = createConnectorImageTurns({ agents, conversations, availability, images, door });
  return { turns, images, door, agents, conversations, availability };
};

const turnInput = (overrides: Partial<Parameters<ReturnType<typeof setup>["turns"]["answer"]>[0]> = {}) => ({
  workspaceId: "workspace-1",
  query: "Something like this",
  images: [{ bytes: PHOTO_A }, { bytes: PHOTO_B }],
  sourceChannel: "whatsapp",
  ...overrides,
});

describe("createConnectorImageTurns", () => {
  describe("imageAllowance", () => {
    it("allows up to three photos on the workspace's default agent when it reads them and the conversation is new", async () => {
      const { turns, agents, availability } = setup();

      await expect(turns.imageAllowance({ workspaceId: "workspace-1" })).resolves.toEqual({ maxImages: 3 });
      expect(agents.resolve).toHaveBeenCalledWith("workspace-1", null);
      expect(availability.forAgent).toHaveBeenCalledWith({ workspaceId: "workspace-1", agentId: "default-agent" });
    });

    it("asks about the agent the conversation already runs on", async () => {
      const { turns, agents, conversations } = setup({ conversationAgentId: "agent-9" });

      await expect(turns.imageAllowance({ workspaceId: "workspace-1", conversationId: "conversation-1" }))
        .resolves.toEqual({ maxImages: 3 });
      expect(conversations.findByIdAndWorkspaceId).toHaveBeenCalledWith("conversation-1", "workspace-1");
      expect(agents.resolve).toHaveBeenCalledWith("workspace-1", "agent-9");
    });

    it("prefers the agent a caller names", async () => {
      const { turns, agents, conversations } = setup({ conversationAgentId: "agent-9" });

      await turns.imageAllowance({ workspaceId: "workspace-1", agentId: "agent-3", conversationId: "conversation-1" });

      expect(agents.resolve).toHaveBeenCalledWith("workspace-1", "agent-3");
      expect(conversations.findByIdAndWorkspaceId).not.toHaveBeenCalled();
    });

    it.each(["disabled", "model_cannot_read", "agent_not_found"] as const)("allows none when the agent's availability is %s", async (availability) => {
      const { turns } = setup({ availability });

      await expect(turns.imageAllowance({ workspaceId: "workspace-1" })).resolves.toBeNull();
    });
  });

  describe("answer", () => {
    it("uploads each photo for the conversation and runs the turn through the chat door with their ids, in order", async () => {
      const { turns, images, door } = setup({ conversationAgentId: "agent-9" });
      const channelContext = { provider: "web", origin: "https://example.com" } as const;

      const answered = await turns.answer(turnInput({ conversationId: "conversation-1", channelContext }));

      const owner = { kind: "connector_conversation", id: "conversation-1" };
      expect(images.upload).toHaveBeenCalledTimes(2);
      expect(images.upload).toHaveBeenNthCalledWith(1, expect.objectContaining({
        workspaceId: "workspace-1",
        agentId: "agent-9",
        owner,
        locale: null,
        surface: "whatsapp",
      }));
      expect(Buffer.from((images.upload.mock.calls[0]?.[0] as { bytes: Buffer }).bytes)).toEqual(Buffer.from(PHOTO_A));
      expect(Buffer.from((images.upload.mock.calls[1]?.[0] as { bytes: Buffer }).bytes)).toEqual(Buffer.from(PHOTO_B));
      expect(door.answer).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        agentId: "agent-9",
        conversationId: "conversation-1",
        message: "Something like this",
        stream: false,
        sourceChannel: "whatsapp",
        channelContext,
        imageIds: [IMAGE_A, IMAGE_B],
        imageOwner: owner,
      });
      expect(answered).toEqual({ conversationId: "conversation-new", answer: "Looks lovely.", skillOutcome: "grounded" });
    });

    it("runs a photo with no caption on the photo alone", async () => {
      const { turns, door } = setup({ uploads: [{ kind: "accepted", id: IMAGE_A, readingStatus: "read" }] });

      await turns.answer(turnInput({ query: "", images: [{ bytes: PHOTO_A }] }));

      expect(door.answer).toHaveBeenCalledWith(expect.objectContaining({ message: "", imageIds: [IMAGE_A] }));
    });

    it("gives a first turn, which has no conversation yet, an owner of its own that the door and the upload agree on", async () => {
      const first = setup();
      const second = setup();

      await first.turns.answer(turnInput());
      await second.turns.answer(turnInput());

      const owner = (first.images.upload.mock.calls[0]?.[0] as { owner: { kind: string; id: string } }).owner;
      const otherOwner = (second.images.upload.mock.calls[0]?.[0] as { owner: { kind: string; id: string } }).owner;
      expect(owner.kind).toBe("connector_conversation");
      expect(owner.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(owner.id).not.toBe(otherOwner.id);
      expect(first.door.answer).toHaveBeenCalledWith(expect.objectContaining({ imageOwner: owner }));
    });

    it("leaves out a photo the module refuses, and sends the rest", async () => {
      const { turns, door } = setup({
        uploads: [{ kind: "rejected", reason: "too_many_pixels" }, { kind: "accepted", id: IMAGE_B, readingStatus: "unread" }],
      });

      await turns.answer(turnInput());

      expect(door.answer).toHaveBeenCalledWith(expect.objectContaining({ imageIds: [IMAGE_B] }));
    });

    it("returns nothing, running no turn, when every photo is refused", async () => {
      const { turns, door } = setup({ uploads: [{ kind: "rejected", reason: "unsupported_type" }] });

      await expect(turns.answer(turnInput({ images: [{ bytes: PHOTO_A }] }))).resolves.toBeNull();
      expect(door.answer).not.toHaveBeenCalled();
    });

    it.each(["disabled", "model_cannot_read"] as const)("refuses the turn when the agent no longer reads photos (%s)", async (availability) => {
      const { turns, images, door } = setup({ availability });

      await expect(turns.answer(turnInput())).rejects.toMatchObject({ statusCode: 409, code: CONNECTOR_IMAGES_UNAVAILABLE_CODE });
      expect(images.upload).not.toHaveBeenCalled();
      expect(door.answer).not.toHaveBeenCalled();
    });

    it("tells a connector the agent stopped taking photos when the door refuses the claim, as it does before the upload", async () => {
      const { turns, door } = setup();
      door.answer.mockRejectedValueOnce(new AppError(409, "visitor_image_unavailable", "An attached image cannot be sent."));

      await expect(turns.answer(turnInput())).rejects.toMatchObject({ statusCode: 409, code: CONNECTOR_IMAGES_UNAVAILABLE_CODE });
    });

    it("lets the refusals of the upload pass as they are: over plan, and busy", async () => {
      const overPlan = setup();
      overPlan.images.upload.mockRejectedValue(new AppError(429, "usage_limit_exceeded", "Usage limit exceeded"));
      const busy = setup();
      busy.images.upload.mockRejectedValue(new AppError(503, "visitor_image_busy", "Too many images are being processed."));

      await expect(overPlan.turns.answer(turnInput())).rejects.toMatchObject({ statusCode: 429, code: "usage_limit_exceeded" });
      await expect(busy.turns.answer(turnInput())).rejects.toMatchObject({ statusCode: 503, code: "visitor_image_busy" });
      expect(overPlan.door.answer).not.toHaveBeenCalled();
      expect(busy.door.answer).not.toHaveBeenCalled();
    });

    it("lets any other refusal of the door pass as it is", async () => {
      const { turns, door } = setup();
      door.answer.mockRejectedValueOnce(new AppError(429, "usage_limit_exceeded", "Usage limit exceeded"));

      await expect(turns.answer(turnInput())).rejects.toMatchObject({ statusCode: 429, code: "usage_limit_exceeded" });
    });

    it("refuses more photos than a message carries", async () => {
      const { turns, images } = setup();

      await expect(turns.answer(turnInput({ images: [PHOTO_A, PHOTO_B, PHOTO_A, PHOTO_B].map((bytes) => ({ bytes })) })))
        .rejects.toMatchObject({ statusCode: 400 });
      expect(images.upload).not.toHaveBeenCalled();
    });

    it("fails when the door answers without a conversation", async () => {
      const { turns } = setup({ door: null });

      await expect(turns.answer(turnInput())).rejects.toThrow("Chat turn returned no conversation");
    });
  });
});
