const MARKUP_ESCAPES: Readonly<Record<string, string>> = { "<": "&lt;", ">": "&gt;" };

/** A reading quotes whatever text the photo showed; with `<` and `>` escaped, it can never close or open a block. */
const escapeMarkup = (text: string): string => text.replace(/[<>]/g, (character) => MARKUP_ESCAPES[character] ?? character);

/**
 * The turn text a message with photos runs on: what the visitor typed, then one
 * `<attached_photo index="n">` block per photo with what the agent's model read in it, or
 * `<attached_photo index="n" status="unreadable"/>` when it could not. The tag names what it holds,
 * so the answering model reads it with no prompt explaining it; structural and language-neutral, so
 * every transcript reader (history, summaries, facets, export, eval capture) carries the photo's
 * text form as it carries a voice transcript. The structured form, which the UIs render, is the
 * message's `imageInput` metadata.
 */
export const renderVisitorImageTurn = (typedText: string, images: readonly { readonly reading: string | null }[]): string => {
  const blocks = images.map((image, index) => (image.reading === null
    ? `<attached_photo index="${index + 1}" status="unreadable"/>`
    : `<attached_photo index="${index + 1}">${escapeMarkup(image.reading)}</attached_photo>`));
  const typed = typedText.trim();
  return [...(typed.length > 0 ? [typed] : []), ...blocks].join("\n");
};
