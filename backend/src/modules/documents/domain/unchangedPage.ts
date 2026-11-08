/**
 * Whether a synced page can skip reprocessing: its content hash matches and the title it carries is
 * unchanged.
 *
 * The content hash leaves the title out on purpose (folding it in would reprocess every stored page
 * on the next sync), so the title is compared on its own. A caller that supplies no title is not
 * proposing a change, and the stored one stays.
 */
export const isUnchangedPage = (
  stored: { contentHash: string | null; title: string },
  incoming: { contentHash: string; title: string },
): boolean => {
  if (!stored.contentHash || stored.contentHash !== incoming.contentHash) {
    return false;
  }
  const titleSupplied = incoming.title.trim() !== "";
  return !titleSupplied || incoming.title === stored.title;
};
