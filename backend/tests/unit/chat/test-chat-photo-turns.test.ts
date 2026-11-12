import { describe, expect, it, vi } from "vitest";

import { AppError } from "../../../src/shared/domain/errors.js";
import { createTestChatPhotoTurns } from "../../../src/modules/chat/composition.js";
import type { VisitorImageClaim, VisitorImageTurnInput } from "../../../src/modules/visitorImages/public.js";

const IMAGE_A = "6c3e9f2a-1d4b-4b8e-9f0a-2a4c6e8b0d12";
const IMAGE_B = "7d4f0a3b-2e5c-4c9f-8a1b-3b5d7f9c1e23";
const OPERATOR = { kind: "user" as const, id: "5b7d9f1c-3e5a-4b7d-9f1c-3e5a7b9d1f55" };

const claim: VisitorImageClaim = {
  claimId: "claim-1",
  images: [
    { id: IMAGE_A, reading: "A stone farmhouse with a terracotta roof." },
    { id: IMAGE_B, reading: null },
  ],
};

const imagesPort = () => ({
  claim: vi.fn<VisitorImageTurnInput["claim"]>(async () => claim),
  bind: vi.fn<VisitorImageTurnInput["bind"]>(async () => undefined),
  release: vi.fn<VisitorImageTurnInput["release"]>(async () => undefined),
});

const send = {
  workspaceId: "workspace-1",
  agentId: "agent-1",
  message: "  Something like this, near the coast ",
  imageIds: [IMAGE_A, IMAGE_B],
  owner: OPERATOR,
  revision: { visitorImagesEnabled: true },
};

describe("Test Chat photo turns", () => {
  it("claims the photos for their uploader and renders them into the turn text the chat door would", async () => {
    const visitorImages = imagesPort();

    const turn = await createTestChatPhotoTurns(visitorImages).claim(send);

    expect(visitorImages.claim).toHaveBeenCalledWith({ workspaceId: "workspace-1", agentId: "agent-1", owner: OPERATOR, imageIds: [IMAGE_A, IMAGE_B], revision: { visitorImagesEnabled: true } });
    expect(turn.message).toBe([
      "Something like this, near the coast",
      "<attached_photo index=\"1\">A stone farmhouse with a terracotta roof.</attached_photo>",
      "<attached_photo index=\"2\" status=\"unreadable\"/>",
    ].join("\n"));
    expect(turn.imageInput).toEqual({
      typedText: "Something like this, near the coast",
      images: [{ id: IMAGE_A, reading: "A stone farmhouse with a terracotta roof." }, { id: IMAGE_B, reading: null }],
    });
  });

  it("hands over the claim for the test's store to bind with the turn, binding nothing itself", async () => {
    const visitorImages = imagesPort();

    const turn = await createTestChatPhotoTurns(visitorImages).claim(send);

    expect(turn.claim).toBe(claim);
    expect(visitorImages.bind).not.toHaveBeenCalled();
  });

  it("lets the photos go when the test stored no turn, so the operator can send them again", async () => {
    const visitorImages = imagesPort();
    const turn = await createTestChatPhotoTurns(visitorImages).claim(send);

    await turn.release();

    expect(visitorImages.bind).not.toHaveBeenCalled();
    expect(visitorImages.release).toHaveBeenCalledWith({ workspaceId: "workspace-1", claim });
  });

  it("passes the refusal of a photo the caller cannot send on, claiming nothing", async () => {
    const visitorImages = imagesPort();
    visitorImages.claim.mockRejectedValueOnce(new AppError(409, "visitor_image_unavailable", "unavailable"));

    await expect(createTestChatPhotoTurns(visitorImages).claim(send)).rejects.toMatchObject({ code: "visitor_image_unavailable" });
  });
});
