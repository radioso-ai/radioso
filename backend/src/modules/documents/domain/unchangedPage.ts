/** Whitespace runs (newlines, double spaces, no-break spaces) collapse to one space, ends trimmed. */
const normalizeTitle = (title: string): string => title.replace(/\s+/g, " ").trim();

/**
 * Whether a synced page can skip reprocessing: its content hash matches and the title it carries is
 * unchanged.
 *
 * The content hash leaves the title out on purpose (folding it in would reprocess every stored page
 * on the next sync), so the title is compared on its own. Both titles go through one normalization,
 * because a title stored before extraction collapsed whitespace still carries its newlines and
 * no-break spaces. A caller that supplies no title is not proposing a change, and the stored one
 * stays.
 */
export const isUnchangedPage = (
  stored: { contentHash: string | null; title: string },
  incoming: { contentHash: string; title: string },
): boolean => {
  if (!stored.contentHash || stored.contentHash !== incoming.contentHash) {
    return false;
  }
  const incomingTitle = normalizeTitle(incoming.title);
  return incomingTitle === "" || incomingTitle === normalizeTitle(stored.title);
};
