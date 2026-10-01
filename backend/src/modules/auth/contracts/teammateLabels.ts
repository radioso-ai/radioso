/**
 * How operator reads name teammates: each one's teammate label as it is now (display name, else
 * email), keyed by user id. Batched so a read costs one lookup. A user id the reader cannot resolve
 * is absent from the map. The label can be an email, so it is operator-only and never reaches a
 * visitor surface.
 */
export interface TeammateLabelReaderPort {
  labelsByUserIds(userIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
}
