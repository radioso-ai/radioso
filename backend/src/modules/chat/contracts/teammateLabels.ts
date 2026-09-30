/**
 * How chat history names the teammate who wrote a human-agent reply on operator reads: their
 * teammate label as it is now, keyed by user id. Batched so a transcript read costs one lookup. A
 * user id the reader cannot resolve is absent from the map. The label can be an email, so it is
 * operator-only and never reaches a visitor surface.
 */
export interface TeammateLabelReaderPort {
  labelsByUserIds(userIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
}
