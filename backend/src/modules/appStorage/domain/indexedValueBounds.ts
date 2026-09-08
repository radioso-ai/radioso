import { storageScalarValueSchema } from "@radioso/app-contract";

/**
 * How long an indexed string may be. Two ceilings apply, and a value has to
 * clear both.
 *
 * The first is the contract's: `storage.query` compares against a bounded scalar,
 * so a stored value longer than that bound is one no query can ever ask for. It
 * is read from the contract rather than copied, because a copy is a second
 * definition that drifts. The contract states it as a character bound and exports
 * no constant for it, so it is measured once here by asking the schema.
 *
 * The second is Postgres's: an index entry is a B-tree tuple, and a page holds
 * roughly a third of a page per tuple. A byte bound keeps a valid put from
 * failing on an index-tuple-size error deep inside the write.
 */
const PROBE_CEILING = 1 << 20;

const measureScalarStringBound = (): number => {
  const accepts = (length: number): boolean =>
    storageScalarValueSchema.safeParse("a".repeat(length)).success;

  if (!accepts(1)) return 0;

  let accepted = 1;
  let rejected = 0;
  while (accepted < PROBE_CEILING && accepts(accepted * 2)) accepted *= 2;
  rejected = accepted * 2;
  if (accepted >= PROBE_CEILING) return PROBE_CEILING;

  while (rejected - accepted > 1) {
    const midpoint = accepted + Math.floor((rejected - accepted) / 2);
    if (accepts(midpoint)) accepted = midpoint;
    else rejected = midpoint;
  }

  return accepted;
};

/** The longest string a `storage.query` `equals` comparison carries. */
export const INDEXED_STRING_CHARACTER_BOUND = measureScalarStringBound();

/** The longest indexed string a B-tree entry holds, in UTF-8 bytes. */
export const INDEXED_STRING_BYTE_BOUND = 2048;

/**
 * Whether a value may be written into an index entry. A string past either
 * ceiling is refused at validation, so the collection never holds a record its
 * own declared index cannot find.
 */
export const withinIndexedStringBounds = (value: string): boolean =>
  value.length <= INDEXED_STRING_CHARACTER_BOUND &&
  Buffer.byteLength(value, "utf8") <= INDEXED_STRING_BYTE_BOUND;
