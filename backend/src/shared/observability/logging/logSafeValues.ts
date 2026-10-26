// Logs land in Cloud Logging, which conversation erasure cannot reach. A string from an event's
// own data reaches a log line only in one of these shapes, each of which rules out a person's words.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// A lowercase code such as `chat.turn` or `safe_test`: no spaces or capitals, so never a sentence.
const CODE_PATTERN = /^[a-z][a-z0-9_.:-]{0,63}$/u;

// A JavaScript class name such as `TypeError` or `DOMException`.
const CLASS_NAME_PATTERN = /^[A-Za-z_$][\w$.]{0,127}$/u;

// A route pattern or a page path a browser's own router produced: a leading slash, then
// URL-path-safe characters only — no space, `@`, comma, or quote, and no `%`, since a
// percent-encoded segment (`/my%20daughter%20has%20asthma`) can spell out any of those. A caller
// that only stripped a query string can still hand this a sentence or an email address; this is
// the shape check that catches what the strip alone does not.
const PATH_SHAPE_PATTERN = /^\/[\w\-./[\]:]*$/u;

export const isUuid = (value: string): boolean => UUID_PATTERN.test(value);

const isCode = (value: string): boolean => CODE_PATTERN.test(value);

export const isClassName = (value: string): boolean => CLASS_NAME_PATTERN.test(value);

export const isPathShape = (value: string): boolean => PATH_SHAPE_PATTERN.test(value);

// A class name followed by a code, such as `AppError [document_not_found]`: how a background job
// summarizes its error.
const ERROR_SUMMARY_PATTERN = /^[A-Za-z_$][\w$.]{0,127}(?: \[[a-z][a-z0-9_.:-]{0,63}\])?$/u;

const isErrorSummary = (value: string): boolean => ERROR_SUMMARY_PATTERN.test(value);

// One frame of a V8 stack, such as `    at #transformResult (file:///app/executor.js:12:5)` or
// `    at async Promise.all (index 0)`, or of a Firefox or Safari one, such as
// `async*render@/_next/static/chunks/app.js:3:4`. A frame names code and points at a file path with
// a line and column, or at a V8 placeholder, so a line of an error's message, which a person's words
// may fill, never passes. Lines past the length cap are dropped before any pattern runs.
const FRAME_MAX_LENGTH = 1024;
const FRAME_NAME = String.raw`(?:async |new )?(?:get |set )?[\p{L}\p{N}_$.<>#\[\]]+(?: \[as [\p{L}\p{N}_$.<>#]+\])?`;
// A path, or a `node:` core module, with no query string or fragment that could carry text.
const FRAME_FILE = String.raw`(?=[^\s()?#]*[/\\]|node:)[^\s()?#]+:\d+:\d+`;
const V8_FRAME_PATTERN = new RegExp(
  String.raw`^\s*at (?:${FRAME_NAME} \((?:${FRAME_FILE}|<anonymous>|native|index \d+)\)|(?:async )?${FRAME_FILE}|<anonymous>)$`,
  "u",
);
const BROWSER_FRAME_PATTERN = new RegExp(String.raw`^(?:async\*)?[\p{L}\p{N}_$.<>#/]*@${FRAME_FILE}$`, "u");

export const isStackFrame = (line: string): boolean =>
  line.length <= FRAME_MAX_LENGTH && (V8_FRAME_PATTERN.test(line) || BROWSER_FRAME_PATTERN.test(line));

export type LogSafeValue = string | number | boolean;

// An uppercase constant such as `ECONNREFUSED` or `UND_ERR_CONNECT_TIMEOUT` (Node and undici), or a
// five-character SQLSTATE such as `23505` or `42P01` (Postgres): no spaces or lowercase, so never a
// sentence.
const UPPERCASE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/u;
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/u;
// A numeric code (a gRPC status, an errno) fits a signed 32-bit integer; a phone number does not.
const MAX_NUMERIC_CODE = 2 ** 31;

type SafeErrorCode = string | number;

const isErrorCode = (value: unknown): value is SafeErrorCode =>
  typeof value === "number"
    ? Number.isInteger(value) && Math.abs(value) < MAX_NUMERIC_CODE
    : typeof value === "string" && (isCode(value) || UPPERCASE_CODE_PATTERN.test(value) || SQLSTATE_PATTERN.test(value));

const isHttpStatus = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;

interface SafeErrorCause {
  name: string;
  code?: SafeErrorCode;
  status?: number;
  cause?: SafeErrorCause;
}

interface SafeErrorFields extends SafeErrorCause {
  stack?: string;
}

// An undici `fetch failed` carries its socket error's code one level down; a wrapped database
// error can sit two or three down. Deeper chains add nothing a log reader acts on.
const MAX_CAUSE_DEPTH = 3;

// The error's own stack, minus its first line (always a restatement of the message, which is
// never safe to log) and any further line that is not a V8 or browser stack frame: a multi-line
// message indented to look like one must not survive this filter.
const safeStack = (stack: unknown): string | undefined => {
  if (typeof stack !== "string") {
    return undefined;
  }
  const frames = stack.split("\n").slice(1).filter(isStackFrame);
  return frames.length > 0 ? frames.join("\n") : undefined;
};

// A caught value's properties can be getters, and a getter can throw; a log call must not.
const readProperty = (value: object, key: string): unknown => {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
};

const statusOf = (value: object): number | undefined => {
  const status = readProperty(value, "status");
  const statusCode = readProperty(value, "statusCode");
  return isHttpStatus(status) ? status : isHttpStatus(statusCode) ? statusCode : undefined;
};

const errorClassOf = (error: Error): string => {
  const name = readProperty(error, "name");
  if (typeof name === "string" && isClassName(name)) {
    return name;
  }
  const constructorName = readProperty(readProperty(error, "constructor") ?? {}, "name");
  return typeof constructorName === "string" && isClassName(constructorName) ? constructorName : "Error";
};

const describeCaught = (value: unknown, depth: number, seen: Set<object>): SafeErrorCause => {
  if (value === null) {
    return { name: "null" };
  }
  if (typeof value !== "object") {
    return { name: typeof value };
  }

  seen.add(value);
  const code = readProperty(value, "code");
  const status = statusOf(value);
  const cause = readProperty(value, "cause");
  const followCause = depth < MAX_CAUSE_DEPTH && cause !== undefined && !(typeof cause === "object" && cause !== null && seen.has(cause));

  return {
    name: value instanceof Error ? errorClassOf(value) : "object",
    ...(isErrorCode(code) ? { code } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(followCause ? { cause: describeCaught(cause, depth + 1, seen) } : {}),
  };
};

/**
 * What a log line may keep of a caught value: the error's class; a code if it set one in a shape
 * that rules out free text (a lowercase code such as an `AppError`'s `not_found`, an uppercase
 * errno such as `ECONNREFUSED`, a SQLSTATE such as `23505`, or a small integer); an HTTP status;
 * the same three for each `cause`, a bounded number of levels down; and its shape-checked stack
 * frames. Never a message, at any level, nor the first stack line (which restates it), nor any
 * other property: a visitor's words, an email address or a provider's response text in any of
 * them can't reach a log line through this path. A thrown value that is not an `Error` is named
 * by its JS type. The pino `err`/`error` serializer (`logger.ts`) and the OpenTelemetry log bridge
 * (`logging/index.ts`) both call this so a caught error reads the same safe way everywhere it is
 * logged.
 */
export const safeErrorFields = (error: unknown): SafeErrorFields => {
  const stack = error instanceof Error ? safeStack(readProperty(error, "stack")) : undefined;
  return {
    ...describeCaught(error, 0, new Set()),
    ...(stack ? { stack } : {}),
  };
};

interface LogSafeMetadataKeys {
  /** Keys whose values the reporting code picks from a closed set of codes. */
  coded: ReadonlySet<string>;
  /** Keys whose values summarize an error as its class and code. */
  errorSummary?: ReadonlySet<string>;
}

// pino-http's request counter, which reaches correlation and metadata as a `requestId`.
export const isRequestCounter = (value: string): boolean => /^\d{1,20}$/u.test(value);

// Keys whose values name a class, or a class and its code (`AppError [document_not_found]`).
const CLASS_NAME_KEYS = new Set(["errorType", "errorName", "errorClass", "causeType"]);

// Keys whose values are an error code: an errno, a SQLSTATE, a lowercase code (`isErrorCode`).
const ERROR_CODE_KEYS = new Set(["code", "sqlState"]);

// Keys whose values are a provider's opaque id: a WhatsApp message id, a Stripe or Slack event id,
// a Slack team or channel id. The only correlation a line has with the provider's own records.
const PROVIDER_ID_KEYS = new Set(["wamid", "localWamid", "providerWamid", "outboundWamid", "eventId", "teamId", "channelId"]);

// An opaque id: at least one letter (so never a bare phone number), then letters, digits and the
// punctuation provider ids use, no spaces or `@`, at most 128 characters.
const PROVIDER_ID_PATTERN = /^(?=[^A-Za-z]*[A-Za-z])[A-Za-z0-9][\w.:=+/-]{0,127}$/u;

const HTTP_METHOD_PATTERN = /^[A-Z]{1,16}$/u;

const isShapeSafeScalar = (key: string, value: unknown): value is LogSafeValue => {
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string") return false;
  return (
    isUuid(value) ||
    isCode(value) ||
    (key === "requestId" && isRequestCounter(value)) ||
    (key === "method" && HTTP_METHOD_PATTERN.test(value)) ||
    (CLASS_NAME_KEYS.has(key) && (isClassName(value) || isErrorSummary(value))) ||
    (ERROR_CODE_KEYS.has(key) && isErrorCode(value)) ||
    (PROVIDER_ID_KEYS.has(key) && PROVIDER_ID_PATTERN.test(value))
  );
};

/**
 * The entries of a record whose value's shape alone rules out a person's words: under any key, a
 * flag, a finite number, an id or a lowercase code; under the keys named for them, a request
 * counter, an HTTP method, a class name or error summary, an error code, or a provider's opaque
 * id; or an array of those. Everything else is dropped, never redacted in place, so a key nobody
 * anticipated (a phone number under `waId`, a query under `rerankQuery`) can't carry a sentence,
 * an email address or a phone number out. A single lowercase word or a bare number does pass. For
 * records a log call site builds from server values; metadata that can hold a visitor's own words
 * under a code-shaped value (an audit event's) uses `logSafeMetadata`.
 */
export const shapeSafeFields = (record: Record<string, unknown>): Record<string, LogSafeValue | LogSafeValue[]> =>
  Object.fromEntries(
    Object.entries(record).filter(([key, value]) =>
      Array.isArray(value)
        ? value.length > 0 && value.every((entry) => isShapeSafeScalar(key, entry))
        : isShapeSafeScalar(key, value),
    ),
  ) as Record<string, LogSafeValue | LogSafeValue[]>;

const isLogSafe = (key: string, value: unknown, keys: LogSafeMetadataKeys): value is LogSafeValue => {
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string") return false;
  return (
    isUuid(value) ||
    (key === "requestId" && isRequestCounter(value)) ||
    (keys.coded.has(key) && isCode(value)) ||
    (keys.errorSummary?.has(key) === true && isErrorSummary(value))
  );
};

/**
 * The entries of an event's metadata whose shape rules out a person's words: flags, numbers, ids,
 * and codes or error summaries under the keys named for them. Nested values never pass.
 */
export const logSafeMetadata = (
  metadata: Record<string, unknown> | undefined,
  keys: LogSafeMetadataKeys,
): Record<string, LogSafeValue> | undefined => {
  const entries = Object.entries(metadata ?? {}).filter((entry): entry is [string, LogSafeValue] => isLogSafe(entry[0], entry[1], keys));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};
