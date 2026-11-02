import { describe, expect, it } from "vitest";

import {
  mapWebhookPostToIngestInput,
  type WebhookPostPayload,
} from "../../../../src/modules/connectors/plugins/wordpress/wordpressIngest.js";
import { mergeDocumentMetadataForChunks } from "../../../../src/modules/documents/domain/sourceDocumentMetadata.js";
import type {
  RerankedCandidate,
  RetrievedCandidate,
} from "../../../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
import { PromptContextSelectorService } from "../../../../src/modules/retrieval/services/promptContextSelectorService.js";
import {
  composeRangeAnswerPool,
  rangeAnswerSelectionStages,
} from "../../../../src/modules/retrieval/services/temporal/rangeAnswerComposer.js";

// A range answer reads a passage's dates from its chunk metadata, which carries the document's
// own metadata as the connector wrote it. These tests take that metadata straight from the
// WordPress mapper, so what the connector writes is what the range answer places.

const december = { dateFrom: "2026-12-01", dateTo: "2026-12-31" };

const wordpressPost = (overrides: Partial<WebhookPostPayload> & Pick<WebhookPostPayload, "id" | "type">): WebhookPostPayload => ({
  status: "publish",
  slug: `item-${overrides.id}`,
  title: `Item ${overrides.id}`,
  content_rendered: "<p>Body</p>",
  link: `https://example.com/item-${overrides.id}`,
  modified_gmt: "2026-12-01T09:00:00",
  ...overrides,
});

const candidate = (chunkId: string, metadata: Record<string, unknown>): RetrievedCandidate => ({
  chunkId,
  documentId: `doc-${chunkId}`,
  title: chunkId,
  content: `${chunkId} content with enough words to be useful in a prompt`,
  similarity: 0.5,
  retrievalSources: ["semantic_rewritten"],
  retrievalText: chunkId,
  semanticScore: 0.5,
  lexicalScore: 0,
  metadata,
});

const passageOf = (chunkId: string, post: WebhookPostPayload): RetrievedCandidate =>
  candidate(chunkId, mergeDocumentMetadataForChunks({}, mapWebhookPostToIngestInput("ws-1", post).metadata));

// A busy December: far more events in the range than the answer can list.
const decemberEvents = Array.from({ length: 40 }, (_value, index) =>
  candidate(`event-${index}`, { dateFrom: "2026-12-10", dateTo: "2026-12-10" }));

// An evergreen page put up in March: prices, the venue, what to bring.
const evergreenPage = passageOf("venue-page", wordpressPost({ id: 1, type: "page", date_gmt: "2026-03-02T10:00:00" }));
// A weekly post published at the start of the week it describes.
const thisWeekPost = passageOf("this-week-post", wordpressPost({ id: 2, type: "post", date_gmt: "2026-12-07T07:00:00" }));
// The same weekly post from a week in November.
const novemberPost = passageOf("november-post", wordpressPost({ id: 3, type: "post", date_gmt: "2026-11-09T07:00:00" }));

const answerFor = (generalCandidates: RetrievedCandidate[]) => {
  const plan = composeRangeAnswerPool({
    rangeCandidates: decemberEvents,
    generalCandidates,
    range: december,
    temporalQueryMode: "listing",
    poolSize: 20,
    reservedCount: 4,
  });
  const ranked: RerankedCandidate[] = plan.pool.map((entry, index) => ({
    ...entry,
    relevanceScore: 1 - index / 1000,
    rerankPosition: index,
  }));
  const selected = new PromptContextSelectorService(100_000).selectInStages(
    rangeAnswerSelectionStages({ ranked, groups: plan.groups, maxPassages: 20, minPassages: 12 }),
  );
  return { groups: plan.groups, selectedIds: selected.map((context) => context.chunkId) };
};

describe("WordPress publish days in a range answer", () => {
  it("counts an evergreen page as undated, so it takes a reserved slot in a busy range", () => {
    const { groups, selectedIds } = answerFor([evergreenPage]);

    expect(evergreenPage.metadata).toMatchObject({ published_at: "2026-03-02T10:00:00" });
    expect(groups.get("venue-page")).toBe("reserved");
    expect(selectedIds).toContain("venue-page");
  });

  it("keeps a post about its own week in that period", () => {
    // Placed in the range, it competes with the range's own passages rather than for the reserve.
    expect(answerFor([thisWeekPost]).groups.get("this-week-post")).toBe("range");
  });

  it("keeps a post from another week out of a busy range's reserved slots", () => {
    const { groups, selectedIds } = answerFor([novemberPost, evergreenPage]);

    expect(groups.get("november-post")).toBe("outside");
    expect(selectedIds).not.toContain("november-post");
    expect(selectedIds).toContain("venue-page");
  });
});
