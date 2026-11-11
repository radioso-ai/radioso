const MARKUP_ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

/** A reading quotes whatever text the photo showed; escaped, it can never close or open a block. */
const escapeMarkup = (text: string): string => text.replace(/[&<>]/g, (character) => MARKUP_ESCAPES[character] ?? character);

/**
 * The turn text a message with photos runs on: what the visitor typed, then one block per photo
 * with what the agent's model read in it, or an `unread` marker when it could not. Structural and
 * language-neutral, so every transcript reader (history, summaries, facets, export, eval capture)
 * carries the photo's text form as it carries a voice transcript. The structured form, which the
 * UIs render, is the message's `imageInput` metadata.
 */
export const renderVisitorImageTurn = (typedText: string, images: readonly { readonly reading: string | null }[]): string => {
  const blocks = images.map((image, index) => (image.reading === null
    ? `<visitor_image index="${index + 1}" unread/>`
    : `<visitor_image index="${index + 1}">${escapeMarkup(image.reading)}</visitor_image>`));
  const typed = typedText.trim();
  return [...(typed.length > 0 ? [typed] : []), ...blocks].join("\n");
};
