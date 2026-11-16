import type { UserMessageInputMetadata } from "./chatInputMetadata.js";

/** What a person reads of a stored message: the words, and how many photos came with them. */
interface VisibleMessageText {
  /** What the visitor typed. For a message with photos, never the readings its turn text carries. */
  readonly text: string;
  /** The photos the message carries; 0 for one with none. A surface that can show the count shows it beside `text`. */
  readonly photoCount: number;
}

/**
 * What an operator-facing surface shows of a user message, outside the thread bubble that renders
 * the photos themselves: a preview, a title fallback, a quoted question, a search match.
 *
 * A message with photos stores `content` as the turn text the agent's model ran on (the typed
 * text, then one `<attached_photo>` block per photo with what the model read in it) and keeps what
 * the visitor did in `inputMetadata.imageInput`. A person is shown the second. The turn text is
 * never parsed for its blocks: the typed text can quote the same markup, so the structured form
 * is the only reliable split. Transcripts a model reads (summaries, facets, eval capture) keep
 * `content` and so keep the readings. A query that must pick or match by these words reads
 * `visibleMessageTextSql` (`shared/infra/kysely/sqlHelpers.ts`), which must agree with this.
 */
export const visibleMessageText = <Metadata extends { readonly imageInput?: UserMessageInputMetadata["imageInput"] }>(message: {
  readonly content: string;
  readonly inputMetadata?: Metadata | null;
}): VisibleMessageText => {
  const imageInput = message.inputMetadata?.imageInput;
  return imageInput
    ? { text: imageInput.typedText, photoCount: imageInput.images.length }
    : { text: message.content, photoCount: 0 };
};
