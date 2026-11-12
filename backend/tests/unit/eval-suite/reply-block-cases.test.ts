import { describe, expect, it, vi } from "vitest";

import { createReplyImageUrls } from "../../../src/app/http/routes/replyImageAddress.js";
import {
  evaluateTraceAssertion,
  scoreObservedOutput,
  type ConversationQualityObservedOutput,
} from "../../../src/modules/eval/suite/index.js";
import {
  conversationQualityCases,
  GUEST_HOUSE_DOC_ID,
  HIKING_BOOK_DOC_IDS,
  replyBlockImages,
} from "../../fixtures/conversation-quality/index.js";
import { canonicalAnswerEnvelope, conversationQualityChatHarness } from "../../support/conversationQualityChatHarness.js";
import { InMemoryDocumentImages } from "../../support/inMemoryDocumentImages.js";

const block = (layout: "carousel" | "grid", items: Array<{ title: string; url?: string }>) => ({
  type: "item_list" as const,
  id: "b1",
  layout,
  selection: "none" as const,
  caption: "Guides",
  items: items.map((item, index) => ({
    key: `image-${index}`,
    title: item.title,
    actions: item.url ? [{ type: "open" as const, url: item.url }] : [],
  })),
});

const observed = (overrides: Partial<ConversationQualityObservedOutput>): ConversationQualityObservedOutput => ({
  retrievedChunks: [
    { chunkId: "c1", documentId: "d1", title: "Hut to Hut", rank: 0, metadata: { sourceUrl: "https://shop.example/books/hut-to-hut" } },
    { chunkId: "c2", documentId: "d2", title: "Family Day Hikes", rank: 1 },
  ],
  ...overrides,
});

describe("reply block assertions", () => {
  it("passes reply_block on a block of the expected layout and size whose items come from the evidence", () => {
    const output = observed({ replyBlocks: [block("carousel", [{ title: "Hut to Hut", url: "https://shop.example/books/hut-to-hut" }, { title: "Family Day Hikes" }])] });

    expect(evaluateTraceAssertion({ type: "reply_block", layout: "carousel", minItems: 2, itemsFromEvidence: true }, output).status).toBe("pass");
  });

  it("fails reply_block without a block, on another layout, below the size, or with an item from elsewhere", () => {
    const foreign = observed({ replyBlocks: [block("carousel", [{ title: "A Book We Never Retrieved", url: "https://elsewhere.example/book" }])] });

    expect(evaluateTraceAssertion({ type: "reply_block" }, observed({})).status).toBe("fail");
    expect(evaluateTraceAssertion({ type: "reply_block", layout: "grid" }, foreign).status).toBe("fail");
    expect(evaluateTraceAssertion({ type: "reply_block", minItems: 2 }, foreign).status).toBe("fail");
    expect(evaluateTraceAssertion({ type: "reply_block", itemsFromEvidence: true }, foreign).status).toBe("fail");
  });

  it("fails answer_excludes_image_url on an image address or a handle in the answer", () => {
    const { src, srcSet } = createReplyImageUrls("https://app.example/backend").forImage("abc");
    const presented = block("carousel", [{ title: "Hut to Hut" }]);
    const withImage = { ...presented, items: presented.items.map((item) => ({ ...item, image: { src, srcSet, width: 800, height: 1200, alt: "" } })) };
    const answer = (text: string) =>
      evaluateTraceAssertion({ type: "answer_excludes_image_url" }, observed({ answer: text, replyBlocks: [withImage] })).status;
    const smallest = srcSet.split(",")[0]?.trim().split(" ")[0] ?? "";

    expect(answer("We carry two hiking guides.")).toBe("pass");
    expect(answer("See [Hut to Hut](https://shop.example/books/hut-to-hut).")).toBe("pass");
    expect(answer("Here is the cover: https://shop.example/covers/hut-to-hut.jpg")).toBe("fail");
    expect(answer(`Cover: ${src}`)).toBe("fail");
    expect(answer(`Cover: ${smallest}`)).toBe("fail");
    expect(answer("Here it is [m2].")).toBe("fail");
  });
});

const scoreContext = (question: string | undefined) => ({ workspaceId: "cq-workspace", question: question ?? "", runId: "run-1" });

describe("reply block cases on the deterministic harness", () => {
  const hikingCase = conversationQualityCases.find((evalCase) => evalCase.id === "reply-blocks-hiking-books")!;
  const guestHouseCase = conversationQualityCases.find((evalCase) => evalCase.id === "reply-blocks-guest-house-photos")!;

  const imagesFor = (documentIds: readonly string[]) => {
    const documentImages = new InMemoryDocumentImages();
    for (const documentId of documentIds) {
      for (const [position, image] of (replyBlockImages[documentId] ?? []).entries()) {
        documentImages.add("cq-workspace", {
          id: `${documentId}-${position}`,
          documentId,
          chunkId: image.role === "inline" ? `chunk-${documentId}` : null,
          role: image.role,
          position,
          alt: image.alt,
          caption: image.caption ?? null,
          width: image.width,
          height: image.height,
          sha256: image.sourceUrl,
        });
      }
    }
    return documentImages;
  };

  const reply = (present: { images: string[]; caption: string }, claims: number[][]) => canonicalAnswerEnvelope({
    coverage: "answered_sufficient_evidence",
    requestFocus: "what we have",
    outcome: "answer",
    answer: claims.map((group) => group.map((index) => `[[${index}]]`).join("")).join(" ").replace(/^/u, "Here is what we have"),
    claims,
    grounding: "grounded",
    present,
  });

  it("passes the hiking books case when the model presents covers from the retrieved product pages", async () => {
    const retrieved = [...HIKING_BOOK_DOC_IDS.slice(0, 3)];
    const harness = conversationQualityChatHarness({
      reply: reply({ images: ["m1", "m2", "m3"], caption: "Hiking books" }, [[1, 2, 3]]),
      retrievedDocumentIds: retrieved,
      documentImages: imagesFor(retrieved),
    });

    const output: ConversationQualityObservedOutput = await harness.port.run(hikingCase);
    const scored = await scoreObservedOutput(hikingCase.assertions, output, scoreContext(hikingCase.query));

    expect(output.replyBlocks?.[0]?.items).toHaveLength(3);
    expect(scored.verdicts.map((verdict) => verdict.status)).toEqual(["pass", "pass"]);
  });

  it("passes the guest house case when the model presents the page's photos", async () => {
    const harness = conversationQualityChatHarness({
      reply: reply({ images: ["m1", "m2"], caption: "The guest house" }, [[1]]),
      retrievedDocumentIds: [GUEST_HOUSE_DOC_ID],
      documentImages: imagesFor([GUEST_HOUSE_DOC_ID]),
    });

    const scored = await scoreObservedOutput(guestHouseCase.assertions, await harness.port.run(guestHouseCase), scoreContext(guestHouseCase.query));

    expect(scored.verdicts.map((verdict) => verdict.status)).toEqual(["pass", "pass"]);
  });

  it("offers no pictures and carries no block when the case declares no reply blocks", async () => {
    const retrieved = [...HIKING_BOOK_DOC_IDS.slice(0, 2)];
    const harness = conversationQualityChatHarness({
      reply: reply({ images: ["m1", "m2"], caption: "Hiking books" }, [[1, 2]]),
      retrievedDocumentIds: retrieved,
      documentImages: imagesFor(retrieved),
    });
    const { clientContextCapabilities: _capabilities, ...textOnlyCase } = hikingCase;

    const output: ConversationQualityObservedOutput = await harness.port.run(textOnlyCase);

    expect(output.replyBlocks).toBeUndefined();
    const [call] = vi.mocked(harness.chatGateway.answer).mock.calls;
    expect(call?.[0].prompt).not.toContain("Result images");
    expect(JSON.stringify(call?.[0].generation?.responseFormat)).not.toContain("\"present\"");
  });
});
