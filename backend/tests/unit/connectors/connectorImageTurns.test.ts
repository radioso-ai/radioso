import { describe, expect, it, vi } from "vitest";

import type { ConnectorInboundImage, ConnectorStoredImage } from "@radioso/connector-api";

import type { ChatDoorPhotoTurnPort } from "../../../src/modules/chat/contracts/index.js";
import { AppError } from "../../../src/shared/domain/errors.js";
import {
  CONNECTOR_IMAGES_STALE_CODE,
  CONNECTOR_IMAGES_UNAVAILABLE_CODE,
  createConnectorImageTurns,
} from "../../../src/modules/connectors/services/connectorImageTurns.js";
import type { VisitorImageAvailability, VisitorImageService } from "../../../src/modules/visitorImages/public.js";

const IMAGE_A = "6c3e9f2a-1d4b-4b8e-9f0a-2a4c6e8b0d12";
const IMAGE_B = "7d4f0a3b-2e5c-4c9f-8a1b-3b5d7f9c1e23";
const IMAGE_C = "8e5a1b4c-3f6d-4d0a-9b2c-4c6e8a0d2f34";
const PHOTO_A = new Uint8Array([0xff, 0xd8, 1]);
const PHOTO_B = new Uint8Array([0xff, 0xd8, 2]);

type Upload = Awaited<ReturnType<VisitorImageService["upload"]>>;
type DoorAnswer = Awaited<ReturnType<ChatDoorPhotoTurnPort["answer"]>>;

const accepted = (id: string): Upload => ({ kind: "accepted", id, readingStatus: "read" });

const setup = (overrides: {
  availability?: Awaited<ReturnType<VisitorImageAvailability["forAgent"]>>;
  conversationAgentId?: string | null;
  uploads?: (Upload | Error)[];
  door?: DoorAnswer;
} = {}) => {
  const uploads = [...(overrides.uploads ?? [accepted(IMAGE_A), accepted(IMAGE_B)])];
  const images = {
    upload: vi.fn<VisitorImageService["upload"]>(async () => {
      const next = uploads.shift() ?? { kind: "rejected" as const, reason: "unsupported_type" as const };
      if (next instanceof Error) throw next;
      return next;
    }),
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

const bytes = (key: string, data: Uint8Array = PHOTO_A): ConnectorInboundImage => ({ key, bytes: data });

const turnInput = (overrides: Partial<Parameters<ReturnType<typeof setup>["turns"]["answer"]>[0]> = {}) => ({
  workspaceId: "workspace-1",
  query: "Something like this",
  images: [bytes("wamid-1", PHOTO_A), bytes("wamid-2", PHOTO_B)],
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

    it("declares the channel's reply blocks to the door and hands back the cards the reply carries", async () => {
      const block = { type: "item_list" as const, id: "b1", layout: "carousel" as const, selection: "none" as const, caption: "Rooms", items: [{ key: "k", title: "Suite", actions: [] }] };
      const { turns, door } = setup({ door: { conversationId: "conversation-new", answer: "Like these.", skillOutcome: "grounded", assistantMessageId: "message-2", blocks: [block] } });
      const clientContextCapabilities = { "reply.blocks": { item_list: { layouts: ["carousel" as const], buttonLabels: true } } };

      const answered = await turns.answer(turnInput({ clientContextCapabilities }));

      expect(door.answer).toHaveBeenCalledWith(expect.objectContaining({ clientContextCapabilities }));
      expect(answered).toMatchObject({ assistantMessageId: "message-2", blocks: [block] });
    });

    it("runs a photo with no caption on the photo alone", async () => {
      const { turns, door } = setup({ uploads: [accepted(IMAGE_A)] });

      await turns.answer(turnInput({ query: "", images: [bytes("wamid-1")] }));

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
        uploads: [{ kind: "rejected", reason: "too_many_pixels" }, accepted(IMAGE_B)],
      });

      await turns.answer(turnInput());

      expect(door.answer).toHaveBeenCalledWith(expect.objectContaining({ imageIds: [IMAGE_B] }));
    });

    it("returns nothing, running no turn, when every photo is refused", async () => {
      const { turns, door } = setup({ uploads: [{ kind: "rejected", reason: "unsupported_type" }] });

      await expect(turns.answer(turnInput({ images: [bytes("wamid-1")] }))).resolves.toBeNull();
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

    it("lets any other refusal of the door pass as it is", async () => {
      const { turns, door } = setup();
      door.answer.mockRejectedValueOnce(new AppError(429, "usage_limit_exceeded", "Usage limit exceeded"));

      await expect(turns.answer(turnInput())).rejects.toMatchObject({ statusCode: 429, code: "usage_limit_exceeded" });
    });

    it("refuses more photos than a message carries", async () => {
      const { turns, images } = setup();

      await expect(turns.answer(turnInput({ images: [PHOTO_A, PHOTO_B, PHOTO_A, PHOTO_B].map((data, n) => bytes(`wamid-${n}`, data)) })))
        .rejects.toMatchObject({ statusCode: 400 });
      expect(images.upload).not.toHaveBeenCalled();
    });

    it("fails when the door answers without a conversation", async () => {
      const { turns } = setup({ door: null });

      await expect(turns.answer(turnInput())).rejects.toThrow("Chat turn returned no conversation");
    });

    describe("a photo the module is too busy to decode", () => {
      it("is retryable, not dropped like a photo that is not an image: the turn is refused with the busy error", async () => {
        const { turns, door } = setup({ uploads: [{ kind: "rejected", reason: "busy" }] });

        await expect(turns.answer(turnInput({ images: [bytes("wamid-1")] })))
          .rejects.toMatchObject({ statusCode: 503, code: "visitor_image_busy" });
        expect(door.answer).not.toHaveBeenCalled();
      });

      it("still reports the photos stored beside it, so a retry does not pay for them again", async () => {
        const { turns, door } = setup({ uploads: [accepted(IMAGE_A), { kind: "rejected", reason: "busy" }] });
        const onImagesStored = vi.fn<(stored: readonly ConnectorStoredImage[]) => Promise<void>>(async () => undefined);

        await expect(turns.answer(turnInput({ onImagesStored }))).rejects.toMatchObject({ code: "visitor_image_busy" });

        expect(onImagesStored).toHaveBeenCalledTimes(1);
        expect(onImagesStored.mock.calls[0]?.[0]).toEqual([{ key: "wamid-1", receipt: expect.any(String) }]);
        expect(door.answer).not.toHaveBeenCalled();
      });
    });

    describe("receipts", () => {
      it("reports each photo it stored by the key the connector gave it, before the turn runs", async () => {
        const { turns, door } = setup();
        const order: string[] = [];
        const onImagesStored = vi.fn(async (stored: readonly ConnectorStoredImage[]) => {
          order.push(`stored:${stored.map((item) => item.key).join(",")}`);
        });
        door.answer.mockImplementationOnce(async () => {
          order.push("turn");
          return { conversationId: "conversation-new", answer: "Looks lovely.", skillOutcome: "grounded" };
        });

        await turns.answer(turnInput({ onImagesStored }));

        expect(order).toEqual(["stored:wamid-1,wamid-2", "turn"]);
      });

      it("reports them even when the turn then fails", async () => {
        const { turns, door } = setup();
        const onImagesStored = vi.fn(async () => undefined);
        door.answer.mockRejectedValueOnce(new Error("model unavailable"));

        await expect(turns.answer(turnInput({ onImagesStored }))).rejects.toThrow("model unavailable");

        expect(onImagesStored).toHaveBeenCalledTimes(1);
      });

      it("reuses the photos of an earlier attempt, uploading nothing, under the owner they were stored for", async () => {
        const first = setup();
        const stored: ConnectorStoredImage[] = [];
        first.door.answer.mockRejectedValueOnce(new Error("model unavailable"));
        await expect(first.turns.answer(turnInput({ onImagesStored: async (items) => void stored.push(...items) }))).rejects.toThrow();
        const firstOwner = (first.images.upload.mock.calls[0]?.[0] as { owner: unknown }).owner;
        expect(stored.map((item) => item.key)).toEqual(["wamid-1", "wamid-2"]);

        const retry = setup({ uploads: [] });
        await retry.turns.answer(turnInput({
          images: stored.map((item) => ({ key: item.key, receipt: item.receipt })),
          onImagesStored: vi.fn(async () => undefined),
        }));

        expect(retry.images.upload).not.toHaveBeenCalled();
        expect(retry.door.answer).toHaveBeenCalledWith(expect.objectContaining({ imageIds: [IMAGE_A, IMAGE_B], imageOwner: firstOwner }));
      });

      it("uploads only the photos that have no receipt, and keeps the order they were named in", async () => {
        const first = setup({ uploads: [accepted(IMAGE_B)] });
        const stored: ConnectorStoredImage[] = [];
        first.door.answer.mockRejectedValueOnce(new Error("model unavailable"));
        await expect(first.turns.answer(turnInput({ images: [bytes("wamid-2", PHOTO_B)], onImagesStored: async (items) => void stored.push(...items) }))).rejects.toThrow();

        const retry = setup({ uploads: [accepted(IMAGE_C)] });
        const onImagesStored = vi.fn<(items: readonly ConnectorStoredImage[]) => Promise<void>>(async () => undefined);
        await retry.turns.answer(turnInput({
          images: [bytes("wamid-1", PHOTO_A), { key: "wamid-2", receipt: stored[0].receipt }],
          onImagesStored,
        }));

        expect(retry.images.upload).toHaveBeenCalledTimes(1);
        expect(retry.images.upload).toHaveBeenCalledWith(expect.objectContaining({
          owner: (first.images.upload.mock.calls[0]?.[0] as { owner: unknown }).owner,
        }));
        expect(retry.door.answer).toHaveBeenCalledWith(expect.objectContaining({ imageIds: [IMAGE_C, IMAGE_B] }));
        expect(onImagesStored.mock.calls[0]?.[0]).toEqual([{ key: "wamid-1", receipt: expect.any(String) }]);
      });

      it.each([
        ["is not one the host issued", [{ key: "wamid-1", receipt: "not-a-receipt" }]],
      ])("refuses a receipt that %s as stale, without uploading anything", async (_label, images) => {
        const { turns, images: service, door } = setup();

        await expect(turns.answer(turnInput({ images: [...images, bytes("wamid-2")] })))
          .rejects.toMatchObject({ statusCode: 409, code: CONNECTOR_IMAGES_STALE_CODE });
        expect(service.upload).not.toHaveBeenCalled();
        expect(door.answer).not.toHaveBeenCalled();
      });

      it("refuses receipts stored for different owners as stale", async () => {
        const a = setup();
        const b = setup({ uploads: [accepted(IMAGE_B)] });
        const storedA: ConnectorStoredImage[] = [];
        const storedB: ConnectorStoredImage[] = [];
        await a.turns.answer(turnInput({ images: [bytes("wamid-1")], onImagesStored: async (items) => void storedA.push(...items) }));
        await b.turns.answer(turnInput({ images: [bytes("wamid-2")], onImagesStored: async (items) => void storedB.push(...items) }));
        const retry = setup();

        await expect(retry.turns.answer(turnInput({
          images: [{ key: "wamid-1", receipt: storedA[0].receipt }, { key: "wamid-2", receipt: storedB[0].receipt }],
        }))).rejects.toMatchObject({ statusCode: 409, code: CONNECTOR_IMAGES_STALE_CODE });
        expect(retry.door.answer).not.toHaveBeenCalled();
      });

      it("calls a receipt stale, not the agent unavailable, when the door cannot claim it and the agent still takes photos", async () => {
        const first = setup();
        const stored: ConnectorStoredImage[] = [];
        await first.turns.answer(turnInput({ onImagesStored: async (items) => void stored.push(...items) }));
        const retry = setup();
        retry.door.answer.mockRejectedValueOnce(new AppError(409, "visitor_image_unavailable", "An attached image cannot be sent."));

        await expect(retry.turns.answer(turnInput({ images: stored.map((item) => ({ key: item.key, receipt: item.receipt })) })))
          .rejects.toMatchObject({ statusCode: 409, code: CONNECTOR_IMAGES_STALE_CODE });
      });

      it("calls it the agent stopping when the door cannot claim a receipt because photos are off", async () => {
        const first = setup();
        const stored: ConnectorStoredImage[] = [];
        await first.turns.answer(turnInput({ onImagesStored: async (items) => void stored.push(...items) }));
        const retry = setup();
        retry.availability.forAgent.mockResolvedValueOnce("available").mockResolvedValue("disabled");
        retry.door.answer.mockRejectedValueOnce(new AppError(409, "visitor_image_unavailable", "An attached image cannot be sent."));

        await expect(retry.turns.answer(turnInput({ images: stored.map((item) => ({ key: item.key, receipt: item.receipt })) })))
          .rejects.toMatchObject({ statusCode: 409, code: CONNECTOR_IMAGES_UNAVAILABLE_CODE });
      });
    });

    describe("when one upload fails", () => {
      it("waits for the others to settle and reports the photos they stored, then raises the failure", async () => {
        const { turns, images, door } = setup();
        const settled: string[] = [];
        images.upload
          .mockImplementationOnce(async () => {
            throw new AppError(429, "usage_limit_exceeded", "Usage limit exceeded");
          })
          .mockImplementationOnce(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            settled.push("second upload finished");
            return accepted(IMAGE_B);
          });
        const onImagesStored = vi.fn(async (items: readonly ConnectorStoredImage[]) => {
          settled.push(`reported ${items.map((item) => item.key).join(",")}`);
        });

        await expect(turns.answer(turnInput({ onImagesStored }))).rejects.toMatchObject({ statusCode: 429, code: "usage_limit_exceeded" });

        expect(settled).toEqual(["second upload finished", "reported wamid-2"]);
        expect(door.answer).not.toHaveBeenCalled();
      });
    });
  });
});
