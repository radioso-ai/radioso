import type { VoiceTransport } from "../../domain.js";

/** Where one value travels on a request: a header, or a path into the JSON body. */
type CompletionsFieldSource = { header: string } | { bodyPath: readonly string[] };

/**
 * What tells one vendor's chat-completions requests apart from another's. Data only: the wire is
 * the same OpenAI protocol for every dialect. Sources are tried in order; the first usable value
 * wins. A source must identify one call: a value that spans calls, such as a user id, would join
 * separate calls into one conversation.
 */
export interface CompletionsDialect {
  id: string;
  sessionKeyFrom: readonly CompletionsFieldSource[];
  transportDefault: VoiceTransport;
}

const COMPLETIONS_DIALECTS = new Map<string, CompletionsDialect>([
  ["elevenlabs", {
    id: "elevenlabs",
    sessionKeyFrom: [{ bodyPath: ["elevenlabs_extra_body", "conversation_id"] }],
    transportDefault: "web",
  }],
  ["generic", {
    id: "generic",
    sessionKeyFrom: [{ header: "x-radioso-voice-session" }, { bodyPath: ["metadata", "session_key"] }],
    transportDefault: "web",
  }],
]);

export const findCompletionsDialect = (id: string): CompletionsDialect | null => COMPLETIONS_DIALECTS.get(id) ?? null;

interface CompletionsRequestParts {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readBodyPath = (body: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>((value, segment) => (isRecord(value) && Object.hasOwn(value, segment) ? value[segment] : undefined), body);

const readSource = (source: CompletionsFieldSource, request: CompletionsRequestParts): unknown => {
  if ("header" in source) {
    const value = request.headers[source.header.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  }
  return readBodyPath(request.body, source.bodyPath);
};

const firstValue = (
  sources: readonly CompletionsFieldSource[],
  request: CompletionsRequestParts,
): string | undefined => {
  for (const source of sources) {
    const value = readSource(source, request);
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
};

export const sessionKeyFor = (dialect: CompletionsDialect, request: CompletionsRequestParts): string | null =>
  firstValue(dialect.sessionKeyFrom, request) ?? null;
