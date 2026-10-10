import type { ConnectorReplyDraft } from "@radioso/connector-api";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The chunks a review turn's draft drew on, in the order the turn ranked them, read back from the
 * host-owned presentation the turn recorded on it (`metadata.retrievedChunks`). Empty when the turn
 * retrieved nothing, or the presentation records no chunks in that shape.
 */
export const reviewDraftRetrievedChunkIds = (draft: ConnectorReplyDraft): string[] => {
  const metadata = draft.presentation.metadata;
  if (!isRecord(metadata) || !Array.isArray(metadata.retrievedChunks)) return [];
  return metadata.retrievedChunks.flatMap((chunk: unknown) => (isRecord(chunk) && typeof chunk.chunkId === "string" ? [chunk.chunkId] : []));
};
