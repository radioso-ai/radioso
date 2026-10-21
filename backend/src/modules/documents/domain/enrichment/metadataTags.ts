/** Flat metadata-map helpers shared by the enrichment ownership rules. */

export const hasOwnKey = (metadata: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(metadata, key);

export const omitKeys = (
  metadata: Record<string, unknown>,
  keys: ReadonlySet<string>,
): Record<string, unknown> => {
  if (keys.size === 0) {
    return metadata;
  }
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !keys.has(key)));
};

export const pickKeys = (
  metadata: Record<string, unknown> | undefined,
  keys: ReadonlySet<string>,
): Record<string, unknown> =>
  Object.fromEntries(Object.entries(metadata ?? {}).filter(([key]) => keys.has(key)));

/**
 * Whether a tag is set. `null` and blank strings read as unset, for catalog
 * fields and dates alike: extraction may fill them in, and they never block it.
 */
export const holdsValue = (metadata: Record<string, unknown> | undefined, key: string): boolean => {
  if (!metadata || !hasOwnKey(metadata, key)) {
    return false;
  }
  const value = metadata[key];
  if (value === null || value === undefined) {
    return false;
  }
  return typeof value !== "string" || value.trim().length > 0;
};
