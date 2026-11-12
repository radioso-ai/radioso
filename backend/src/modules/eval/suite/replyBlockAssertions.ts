import type { ReplyBlock } from "../../chat/contracts/index.js";
import { resolveContextSourceUrl } from "../../retrieval/public.js";
import type { EvalRunRetrievedChunk } from "../domain/types.js";

/** What a reply block assertion expects of the turn's first block. */
export interface ReplyBlockExpectation {
  layout?: "carousel" | "grid" | "list";
  minItems?: number;
  /** Every item comes from a document the turn retrieved: it links to one, or is titled as one. */
  itemsFromEvidence?: boolean;
}

type Verdict = { passed: true; reason: string } | { passed: false; reason: string };

const evidenceOf = (chunks: readonly EvalRunRetrievedChunk[]) => ({
  urls: new Set(chunks.flatMap((chunk) => resolveContextSourceUrl(chunk.metadata) ?? [])),
  titles: new Set(chunks.map((chunk) => chunk.title)),
});

/** Judges the turn's first reply block against the expectation, from the observed blocks and retrieval alone. */
export const judgeReplyBlock = (
  expectation: ReplyBlockExpectation,
  blocks: readonly ReplyBlock[] | undefined,
  retrievedChunks: readonly EvalRunRetrievedChunk[],
): Verdict => {
  const [block] = blocks ?? [];
  if (!block) {
    return { passed: false, reason: "The reply carried no block." };
  }
  if (expectation.layout && block.layout !== expectation.layout) {
    return { passed: false, reason: `The block was laid out as "${block.layout}"; expected "${expectation.layout}".` };
  }
  if (expectation.minItems !== undefined && block.items.length < expectation.minItems) {
    return { passed: false, reason: `The block had ${block.items.length} item(s); expected at least ${expectation.minItems}.` };
  }
  if (expectation.itemsFromEvidence) {
    const evidence = evidenceOf(retrievedChunks);
    const foreign = block.items.filter((item) =>
      !item.actions.some((action) => action.type === "open" && evidence.urls.has(action.url))
      && !evidence.titles.has(item.title));
    if (foreign.length > 0) {
      return { passed: false, reason: `${foreign.length} item(s) came from no retrieved document: ${foreign.map((item) => item.title).join(", ")}.` };
    }
  }
  return { passed: true, reason: `The reply carried a ${block.layout} block of ${block.items.length} item(s).` };
};

// Structural patterns: an address of an image file, and a ledger handle.
const IMAGE_URL_PATTERN = /https?:\/\/\S+?\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#)\s"']|$)/iu;
const IMAGE_HANDLE_PATTERN = /\[m\d{1,3}\]/u;

/** Every address the reply's blocks serve their images at: each `src`, and each URL in each `srcSet`. */
const servedImageAddresses = (blocks: readonly ReplyBlock[]): string[] =>
  blocks.flatMap((block) => block.items.flatMap((item) => item.image
    ? [item.image.src, ...(item.image.srcSet ?? "").split(",").map((entry) => entry.trim().split(/\s+/u)[0] ?? "")]
    : []))
    .filter((address) => address.length > 0);

/**
 * Whether the answer text names a picture the way only the block may: by an image file's address,
 * by an address the reply's own blocks serve an image at, or by its handle.
 */
export const answerNamesImage = (answer: string | undefined, blocks: readonly ReplyBlock[] = []): string | null => {
  const text = answer ?? "";
  if (IMAGE_URL_PATTERN.test(text) || servedImageAddresses(blocks).some((address) => text.includes(address))) {
    return "The answer contains an image address.";
  }
  return IMAGE_HANDLE_PATTERN.test(text) ? "The answer contains an image handle." : null;
};
