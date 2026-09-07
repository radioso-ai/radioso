import { z } from "zod";

/**
 * Bounds every free-form value the protocol carries. A checkpoint, a storage
 * record, and an App's declared output are all author-shaped, so the contract
 * cannot say what is inside them — it can only say how much of it there may be.
 * Without that, a schema pass hands a 100 MB nested object to whatever runs
 * next and the first component with a real limit is the one that fails.
 */
export const MAX_JSON_DEPTH = 8;
export const MAX_JSON_OBJECT_KEYS = 256;
export const MAX_JSON_ARRAY_ITEMS = 1024;
export const MAX_JSON_STRING_LENGTH = 8192;
const MAX_JSON_KEY_LENGTH = 128;
export const MAX_JSON_SERIALIZED_BYTES = 64 * 1024;

/** Entries in one header map, in either direction. */
export const MAX_HEADER_ENTRIES = 64;

/** Decoded size of a base64 body, in either direction. */
export const MAX_BASE64_DECODED_BYTES = 4 * 1024 * 1024;

export type BoundedJsonValue =
  | string
  | number
  | boolean
  | null
  | BoundedJsonValue[]
  | { [key: string]: BoundedJsonValue };

export type BoundedJsonRecord = { [key: string]: BoundedJsonValue };

const addIssue = (context: z.RefinementCtx, path: (string | number)[], message: string): void => {
  context.addIssue({ code: z.ZodIssueCode.custom, path, message });
};

const walk = (
  value: unknown,
  depth: number,
  path: (string | number)[],
  context: z.RefinementCtx,
): void => {
  if (value === null || typeof value === "boolean") return;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) addIssue(context, path, "A number must be finite");
    return;
  }

  if (typeof value === "string") {
    if (value.length > MAX_JSON_STRING_LENGTH) {
      addIssue(context, path, `A string may hold at most ${MAX_JSON_STRING_LENGTH} characters`);
    }
    return;
  }

  if (depth > MAX_JSON_DEPTH) {
    addIssue(context, path, `A value may nest at most ${MAX_JSON_DEPTH} levels deep`);
    return;
  }

  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ARRAY_ITEMS) {
      addIssue(context, path, `An array may hold at most ${MAX_JSON_ARRAY_ITEMS} items`);
      return;
    }
    value.forEach((item, index) => walk(item, depth + 1, [...path, index], context));
    return;
  }

  if (typeof value !== "object") {
    addIssue(context, path, "A value must be JSON: a string, number, boolean, null, array, or object");
    return;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_JSON_OBJECT_KEYS) {
    addIssue(context, path, `An object may hold at most ${MAX_JSON_OBJECT_KEYS} keys`);
    return;
  }
  for (const [key, entry] of entries) {
    if (key.length > MAX_JSON_KEY_LENGTH) {
      addIssue(context, [...path, key], `A key may hold at most ${MAX_JSON_KEY_LENGTH} characters`);
      continue;
    }
    if (entry === undefined) {
      addIssue(context, [...path, key], "A key must carry a JSON value");
      continue;
    }
    walk(entry, depth + 1, [...path, key], context);
  }
};

const checkSerializedSize = (value: unknown, context: z.RefinementCtx): void => {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "";
  } catch {
    addIssue(context, [], "A value must be serializable as JSON");
    return;
  }
  const bytes = new TextEncoder().encode(serialized).length;
  if (bytes > MAX_JSON_SERIALIZED_BYTES) {
    addIssue(context, [], `A value may serialize to at most ${MAX_JSON_SERIALIZED_BYTES} bytes`);
  }
};

/** Any JSON value, bounded in depth, breadth, string length, and serialized size. */
export const boundedJsonValueSchema: z.ZodType<BoundedJsonValue> = z
  .custom<BoundedJsonValue>()
  .superRefine((value, context) => {
    if (value === undefined) {
      addIssue(context, [], "A value is required");
      return;
    }
    walk(value, 1, [], context);
    checkSerializedSize(value, context);
  });

/** The same bounds, for the places the protocol requires an object: checkpoints, storage records. */
export const boundedJsonRecordSchema: z.ZodType<BoundedJsonRecord> = z
  .custom<BoundedJsonRecord>()
  .superRefine((value, context) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      addIssue(context, [], "A record must be a JSON object");
      return;
    }
    walk(value, 1, [], context);
    checkSerializedSize(value, context);
  });

/**
 * One character-class loop rather than a quantified group. A grouped `{4}`
 * repetition over a multi-megabyte body exhausts the regex engine's stack
 * before any size check can act, which would turn the body bound itself into
 * the way through it. Length modulo four, checked alongside this, is what makes
 * the two equivalent.
 */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;

export const base64DecodedByteLength = (data: string): number => {
  if (data.length === 0) return 0;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding;
};

/**
 * A body crosses the boundary base64-encoded because the host verified a
 * signature over exact bytes. Validating the encoding here means a decoder
 * downstream never sees something that is not base64, and the decoded cap is
 * checked before anything allocates the bytes.
 */
export const base64BodySchema = z
  .object({
    encoding: z.literal("base64"),
    data: z
      .string()
      .max(Math.ceil(MAX_BASE64_DECODED_BYTES / 3) * 4)
      .refine((data) => data.length % 4 === 0, "Base64 data must be a multiple of four characters")
      .refine((data) => BASE64_PATTERN.test(data), "Body data must be base64")
      .refine(
        (data) => base64DecodedByteLength(data) <= MAX_BASE64_DECODED_BYTES,
        `A body may decode to at most ${MAX_BASE64_DECODED_BYTES} bytes`,
      ),
  })
  .strict();

/** A header map: bounded keys, bounded values, and a bounded number of entries. */
export const boundedHeaderRecordSchema = (keySchema: z.ZodString): z.ZodType<Record<string, string>> =>
  z
    .record(keySchema, z.string().max(MAX_JSON_STRING_LENGTH))
    .refine(
      (headers) => Object.keys(headers).length <= MAX_HEADER_ENTRIES,
      `At most ${MAX_HEADER_ENTRIES} headers`,
    );
