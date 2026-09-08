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
 * The second is Postgres's, and it is about the whole index tuple rather than the
 * value: an entry also carries the two scope uuids, the collection id, the index
 * id, and the record key, and the B-tree refuses the tuple — not the column — once
 * the total passes what a page admits. So the byte ceiling below is what is left
 * after the other columns are charged at their contract maxima.
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

/**
 * What one B-tree entry may weigh on an 8 KiB page: a third of the page, less the
 * page's own overhead. Postgres rejects a larger tuple outright rather than
 * spilling it, and it does so inside the write that produced it.
 */
const BTREE_MAX_ITEM_BYTES = 2704;
/** Tuple header, line pointer, null bitmap, and inter-attribute alignment padding. */
const INDEX_TUPLE_OVERHEAD_BYTES = 40;
/** `workspace_id` and `installation_id`. */
const SCOPE_UUID_BYTES = 32;
const VARLENA_HEADER_BYTES = 4;
/** A collection id and an index id are lower-case snake identifiers of at most 64 characters. */
const IDENTIFIER_BYTES = 64 + VARLENA_HEADER_BYTES;
/** A record key is at most 256 characters the App chose, so it is charged at UTF-8's worst case. */
const RECORD_KEY_BYTES = 256 * 4 + VARLENA_HEADER_BYTES;

/**
 * The longest indexed string a B-tree entry holds, in UTF-8 bytes. It is derived
 * rather than chosen: every other column of the entry is charged at the maximum
 * its own contract admits, and what remains is the value's budget. A shorter
 * collection id or record key leaves more room in practice, which is the point —
 * the bound has to hold for the worst tuple the contract allows, not the average
 * one, or a valid put fails deep inside the write.
 */
export const INDEXED_STRING_BYTE_BOUND =
  BTREE_MAX_ITEM_BYTES -
  INDEX_TUPLE_OVERHEAD_BYTES -
  SCOPE_UUID_BYTES -
  IDENTIFIER_BYTES -
  IDENTIFIER_BYTES -
  RECORD_KEY_BYTES -
  VARLENA_HEADER_BYTES;

/**
 * Whether a value may be written into an index entry. A string past either
 * ceiling is refused at validation, so the collection never holds a record its
 * own declared index cannot find; a value that was stored before the field became
 * indexed is checked again by the rebuild, which reports it rather than letting
 * the database raise.
 */
export const withinIndexedStringBounds = (value: string): boolean =>
  value.length <= INDEXED_STRING_CHARACTER_BOUND &&
  Buffer.byteLength(value, "utf8") <= INDEXED_STRING_BYTE_BOUND;
