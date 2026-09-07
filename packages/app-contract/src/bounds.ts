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

/** One header name, and one header value. */
const MAX_HEADER_NAME_LENGTH = 128;
const MAX_HEADER_VALUE_LENGTH = 8192;

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

interface Violation {
  path: (string | number)[];
  message: string;
}

const HIGH_SURROGATE_START = 0xd800;
const LOW_SURROGATE_START = 0xdc00;
const SURROGATE_END = 0xe000;

const isHighSurrogate = (code: number): boolean =>
  code >= HIGH_SURROGATE_START && code < LOW_SURROGATE_START;
const isLowSurrogate = (code: number): boolean => code >= LOW_SURROGATE_START && code < SURROGATE_END;

/**
 * A code unit that has no pair is not a character. `JSON.stringify` writes it as
 * a six-character `\uXXXX` escape and `TextEncoder` replaces it, so anything
 * that measures or encodes one has to say which. Callers that refuse it outright
 * ask here first.
 */
export const containsLoneSurrogate = (value: string): boolean => {
  for (let position = 0; position < value.length; position += 1) {
    const code = value.charCodeAt(position);
    if (isLowSurrogate(code)) return true;
    if (!isHighSurrogate(code)) continue;
    if (!isLowSurrogate(value.charCodeAt(position + 1))) return true;
    position += 1;
  }
  return false;
};

/**
 * What one string costs in a JSON document: the two quotes, the UTF-8 encoding,
 * and the escapes. Counted rather than produced, because the point of measuring
 * during the walk is that nothing ever allocates a copy of the input.
 *
 * A surrogate pair is one character in four UTF-8 bytes. A lone surrogate is not
 * a character at all: `JSON.stringify` emits the six ASCII bytes of a `\uXXXX`
 * escape for it, so counting it as its two UTF-16 bytes would let a string of
 * them serialize to three times the measured size.
 */
const jsonStringBytes = (value: string): number => {
  let bytes = 2;
  for (let position = 0; position < value.length; position += 1) {
    const code = value.charCodeAt(position);
    if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (code < 0x20) {
      // Backspace, tab, newline, form feed, and carriage return have two-character
      // escapes; every other control character is written as \uXXXX.
      bytes += code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6;
    } else if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (isHighSurrogate(code) && isLowSurrogate(value.charCodeAt(position + 1))) {
      bytes += 4;
      position += 1;
    } else if (isHighSurrogate(code) || isLowSurrogate(code)) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
};

/** Bytes an ASCII alphanumeric, `*`, `-`, `.`, or `_` keeps unescaped. */
const isFormUrlencodedSafe = (code: number): boolean =>
  (code >= 0x30 && code <= 0x39) ||
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x61 && code <= 0x7a) ||
  code === 0x2a ||
  code === 0x2d ||
  code === 0x2e ||
  code === 0x5f;

/**
 * How long one query component is once `URLSearchParams` writes it: the
 * `application/x-www-form-urlencoded` serializer keeps the unreserved set,
 * writes a space as `+`, and percent-encodes every other UTF-8 byte as three
 * characters. A lone surrogate encodes as U+FFFD, which is nine characters —
 * counted rather than encoded, so measuring an oversized query never throws and
 * never allocates a copy of it.
 */
export const formUrlencodedLength = (value: string): number => {
  let length = 0;
  for (let position = 0; position < value.length; position += 1) {
    const code = value.charCodeAt(position);
    if (code === 0x20) {
      length += 1;
    } else if (isFormUrlencodedSafe(code)) {
      length += 1;
    } else if (code < 0x80) {
      length += 3;
    } else if (code < 0x800) {
      length += 6;
    } else if (isHighSurrogate(code) && isLowSurrogate(value.charCodeAt(position + 1))) {
      length += 12;
      position += 1;
    } else {
      // Three UTF-8 bytes, and the same three for the replacement a lone
      // surrogate turns into.
      length += 9;
    }
  }
  return length;
};

interface Budget {
  bytes: number;
}

/**
 * How many own enumerable keys an object has, or one more than the ceiling —
 * which is all a breadth check needs to know. `Object.keys` on a million-key
 * object allocates a million-entry array on the way to refusing it, so nothing
 * here materializes the list, and it stops as soon as the answer is decided.
 */
const countKeys = (record: object, ceiling: number): number => {
  let count = 0;
  for (const key in record) {
    if (!Object.hasOwn(record, key)) continue;
    count += 1;
    if (count > ceiling) return count;
  }
  return count;
};

const NOT_A_JSON_CONTAINER =
  "A container must be a plain object or array, with no toJSON and no accessor property";

/**
 * Only a genuine JSON container is measurable. `JSON.stringify` asks `toJSON`
 * what to write and reads an accessor again when it writes, so an object
 * carrying either serializes to something this walk never measured — a Date, a
 * class instance, a typed array, or a plain-looking object with a
 * non-enumerable `toJSON` that returns a hundred megabytes. `in` decides that
 * without reading the property, so nothing here can invoke what it is refusing.
 */
const hasCustomJson = (value: object): boolean => {
  if (!("toJSON" in value)) return false;
  const own = Object.getOwnPropertyDescriptor(value, "toJSON");
  if (own === undefined) return true;
  return own.get !== undefined || own.set !== undefined || typeof own.value === "function";
};

const isPlainArray = (value: object): boolean => Object.getPrototypeOf(value) === Array.prototype;

const isPlainObject = (value: object): boolean => {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
};

const isAccessor = (descriptor: PropertyDescriptor | undefined): boolean =>
  descriptor !== undefined && (descriptor.get !== undefined || descriptor.set !== undefined);

const overBudget = (budget: Budget, path: (string | number)[]): Violation | null =>
  budget.bytes > MAX_JSON_SERIALIZED_BYTES
    ? { path, message: `A value may serialize to at most ${MAX_JSON_SERIALIZED_BYTES} bytes` }
    : null;

/**
 * One traversal that carries the encoded-byte total with it and stops at the
 * first violation, structural or budgetary. Serializing the input to measure it
 * would mean an oversized payload buys an attacker-sized allocation on its way
 * to being refused, so nothing here serializes anything.
 */
const measure = (
  value: unknown,
  depth: number,
  path: (string | number)[],
  budget: Budget,
): Violation | null => {
  if (value === null) {
    budget.bytes += 4;
    return overBudget(budget, path);
  }

  if (typeof value === "boolean") {
    budget.bytes += value ? 4 : 5;
    return overBudget(budget, path);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { path, message: "A number must be finite" };
    budget.bytes += String(value).length;
    return overBudget(budget, path);
  }

  if (typeof value === "string") {
    if (value.length > MAX_JSON_STRING_LENGTH) {
      return { path, message: `A string may hold at most ${MAX_JSON_STRING_LENGTH} characters` };
    }
    budget.bytes += jsonStringBytes(value);
    return overBudget(budget, path);
  }

  if (typeof value !== "object") {
    return { path, message: "A value must be JSON: a string, number, boolean, null, array, or object" };
  }

  if (depth > MAX_JSON_DEPTH) {
    return { path, message: `A value may nest at most ${MAX_JSON_DEPTH} levels deep` };
  }

  if (Array.isArray(value)) {
    if (!isPlainArray(value) || hasCustomJson(value)) return { path, message: NOT_A_JSON_CONTAINER };
    if (value.length > MAX_JSON_ARRAY_ITEMS) {
      return { path, message: `An array may hold at most ${MAX_JSON_ARRAY_ITEMS} items` };
    }
    budget.bytes += 2 + Math.max(0, value.length - 1);
    const structural = overBudget(budget, path);
    if (structural) return structural;
    for (let index = 0; index < value.length; index += 1) {
      const at = [...path, index];
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (isAccessor(descriptor)) return { path: at, message: NOT_A_JSON_CONTAINER };
      const violation = measure(descriptor?.value, depth + 1, at, budget);
      if (violation) return violation;
    }
    return null;
  }

  if (!isPlainObject(value) || hasCustomJson(value)) return { path, message: NOT_A_JSON_CONTAINER };

  const record = value as Record<string, unknown>;
  const keyCount = countKeys(record, MAX_JSON_OBJECT_KEYS);
  if (keyCount > MAX_JSON_OBJECT_KEYS) {
    return { path, message: `An object may hold at most ${MAX_JSON_OBJECT_KEYS} keys` };
  }
  budget.bytes += 2 + Math.max(0, keyCount - 1);
  const structural = overBudget(budget, path);
  if (structural) return structural;
  for (const key in record) {
    if (!Object.hasOwn(record, key)) continue;
    const at = [...path, key];
    if (key.length > MAX_JSON_KEY_LENGTH) {
      return { path: at, message: `A key may hold at most ${MAX_JSON_KEY_LENGTH} characters` };
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (isAccessor(descriptor)) return { path: at, message: NOT_A_JSON_CONTAINER };
    const entry: unknown = descriptor?.value;
    if (entry === undefined) return { path: at, message: "A key must carry a JSON value" };
    budget.bytes += jsonStringBytes(key) + 1;
    const keyBudget = overBudget(budget, at);
    if (keyBudget) return keyBudget;
    const violation = measure(entry, depth + 1, at, budget);
    if (violation) return violation;
  }
  return null;
};

const addViolation = (context: z.RefinementCtx, violation: Violation): void => {
  context.addIssue({ code: z.ZodIssueCode.custom, path: violation.path, message: violation.message });
};

/**
 * Breadth alone, cheaply, before a typed schema walks an object's children. A
 * schema that parses each value against a child schema and only then applies a
 * key ceiling has already paid for every key by the time it refuses the object,
 * so this runs first and aborts.
 */
const exceedsBreadth = (value: unknown, ceiling: number): boolean =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  countKeys(value, ceiling) > ceiling;

export const refineObjectBreadth = (value: unknown, context: z.RefinementCtx): void => {
  if (!exceedsBreadth(value, MAX_JSON_OBJECT_KEYS)) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path: [],
    fatal: true,
    message: `An object may hold at most ${MAX_JSON_OBJECT_KEYS} keys`,
  });
};

const NOT_A_PLAIN_MAP = "A map is a plain JSON object carrying its own data properties only";

/**
 * Shape, breadth, and property kind for a bounded map, settled before a typed
 * schema reads an entry, and settled by descriptor rather than by reading. A
 * getter is a caller's code: reading one to find out whether the map is
 * acceptable hands an attacker an exception out of a validation function, or an
 * entry whose second read is a different value than the one that passed. An
 * enumerable property on `Object.prototype` is the same problem from the other
 * side — an own-key count never sees it, and a parser that walks it goes on to
 * read a key the map never carried.
 *
 * What comes back is a null-prototype copy of the own data properties, which is
 * what the rest of a pipeline reads: nothing downstream can reach a getter or an
 * inherited key, because neither survived this pass.
 */
export const readBoundedMap = (
  value: unknown,
  ceiling: number,
): { ok: true; map: Record<string, unknown> } | { ok: false; failure: "not_a_plain_map" | "too_many_entries" } => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || !isPlainObject(value)) {
    return { ok: false, failure: "not_a_plain_map" };
  }
  const map = Object.create(null) as Record<string, unknown>;
  let count = 0;
  for (const key in value) {
    // An inherited enumerable property has no own descriptor, and an accessor
    // has one that names a function rather than a value. Neither is read.
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || isAccessor(descriptor)) return { ok: false, failure: "not_a_plain_map" };
    count += 1;
    if (count > ceiling) return { ok: false, failure: "too_many_entries" };
    map[key] = descriptor.value;
  }
  return { ok: true, map };
};

/**
 * The pre-pipe stage every bounded map goes through. Its issues are fatal so the
 * pipeline stops here: `z.record` parses and clones every entry before a
 * refinement on the record could count them, which hands a hundred-thousand
 * entry map a full traversal on its way to being refused.
 */
export const boundedMapSchema = (ceiling: number, message: string) =>
  z.any().transform((value: unknown, context: z.RefinementCtx) => {
    const read = readBoundedMap(value, ceiling);
    if (read.ok) return read.map;
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [],
      fatal: true,
      message: read.failure === "too_many_entries" ? message : NOT_A_PLAIN_MAP,
    });
    return z.NEVER;
  });

/** The bounds, applied to a value the caller already knows should be an object. */
export const refineBoundedJsonRecord = (value: unknown, context: z.RefinementCtx): void => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    addViolation(context, { path: [], message: "A record must be a JSON object" });
    return;
  }
  const violation = measure(value, 1, [], { bytes: 0 });
  if (violation) addViolation(context, violation);
};

/** Any JSON value, bounded in depth, breadth, string length, and serialized size. */
export const boundedJsonValueSchema: z.ZodType<BoundedJsonValue> = z
  .custom<BoundedJsonValue>()
  .superRefine((value, context) => {
    if (value === undefined) {
      addViolation(context, { path: [], message: "A value is required" });
      return;
    }
    if (exceedsBreadth(value, MAX_JSON_OBJECT_KEYS)) {
      addViolation(context, { path: [], message: `An object may hold at most ${MAX_JSON_OBJECT_KEYS} keys` });
      return;
    }
    const violation = measure(value, 1, [], { bytes: 0 });
    if (violation) addViolation(context, violation);
  });

/** The same bounds, for the places the protocol requires an object: checkpoints, storage records. */
export const boundedJsonRecordSchema: z.ZodType<BoundedJsonRecord> = z
  .custom<BoundedJsonRecord>()
  .superRefine(refineBoundedJsonRecord);

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

/**
 * What an HTTP field value may hold: HTAB, SP, VCHAR, and obs-text. CR, LF,
 * NUL, DEL, and anything above one byte are not field-value characters, and a
 * transport that carries one either rejects the request — Node's own `Headers`
 * does — or splices it into the message. Refusing them here means the boundary
 * decides that rather than whichever client is met first.
 */
const isHttpFieldValueCode = (code: number): boolean =>
  code === 0x09 || (code >= 0x20 && code <= 0x7e) || (code >= 0x80 && code <= 0xff);

const HEADER_VALUE_CHARACTERS =
  "A header value holds tab, space, visible ASCII, and obs-text, and no carriage return, line feed, NUL, or DEL";

/**
 * Length first, and nothing after it. A `.max()` beside a refinement leaves the
 * refinement to run anyway — a length failure is dirty, not fatal — so a single
 * hundred-megabyte value would still be read character by character on its way
 * to being refused, which is the work its size was written to buy.
 */
const httpFieldValueSchema = z.string().superRefine((value, context) => {
  if (value.length > MAX_HEADER_VALUE_LENGTH) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [],
      message: `A header value holds at most ${MAX_HEADER_VALUE_LENGTH} characters`,
    });
    return;
  }
  for (let position = 0; position < value.length; position += 1) {
    if (isHttpFieldValueCode(value.charCodeAt(position))) continue;
    context.addIssue({ code: z.ZodIssueCode.custom, path: [], message: HEADER_VALUE_CHARACTERS });
    return;
  }
});

/**
 * A header map: a plain own-property object, bounded names, bounded field
 * values, a bounded number of entries, and no lone surrogate in a name. Shape
 * and breadth are settled before `z.record` reads an entry, and a name or value
 * already past its own length is never scanned: an oversized input has failed by
 * then, and scanning it anyway is the work its size was meant to buy.
 */
export const boundedHeaderRecordSchema = (keySchema: z.ZodType<string, z.ZodTypeDef, string>) =>
  boundedMapSchema(MAX_HEADER_ENTRIES, `At most ${MAX_HEADER_ENTRIES} headers`).pipe(
      z.record(keySchema, httpFieldValueSchema).superRefine((headers, context) => {
        for (const key in headers) {
          if (!Object.hasOwn(headers, key)) continue;
          if (key.length > MAX_HEADER_NAME_LENGTH || (headers[key] ?? "").length > MAX_HEADER_VALUE_LENGTH) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: [],
              message: `A header name holds at most ${MAX_HEADER_NAME_LENGTH} characters and a value at most ${MAX_HEADER_VALUE_LENGTH}`,
            });
            return;
          }
          if (!containsLoneSurrogate(key)) continue;
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: "A header name must be encodable text",
          });
          return;
        }
      }),
    );
