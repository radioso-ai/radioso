import { createHash } from "node:crypto";

import type { SkillOutcomeMedia } from "@radioso/conversation-contract";

import { CHAT_BEHAVIOR } from "../../../../shared/domain/behaviorConfig.js";
import { estimateTextGenerationInputTokens } from "../../../../shared/infra/llm/modelInferencePipeline.js";

/** How much of a skill's result the model is shown as records (#1763, D8). */
export const TOOL_RECORD_LIMITS = {
  /** Records offered on one turn, under handles r1..r20. */
  records: 20,
  /** The deepest an array of records may sit in the outputs, counting the outputs as 0. */
  arrayDepth: 4,
  /** How many levels of containers below a record its view expands. */
  recordDepth: 3,
  recordKeys: 12,
  arrayItems: 3,
  stringLength: 120,
  urlLength: 80,
  /** An item key longer than this is hashed. */
  keyLength: 128,
} as const;

/** One record offered to the model this turn. */
export interface ToolRecord {
  handle: string;
  /** The item key a card built from it carries: the record's JSON Pointer in the outputs. */
  key: string;
  /** The full, untruncated record; pointers resolve against this, never against the view. */
  value: unknown;
}

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** RFC 6901: `~` is written `~0` and `/` is written `~1`. */
const escapePointerToken = (token: string): string => token.replace(/~/g, "~0").replace(/\//g, "~1");

const unescapePointerToken = (token: string): string => token.replace(/~1/g, "/").replace(/~0/g, "~");

/** Structural: an array index as RFC 6901 writes one, with no leading zero and never `-`. */
const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;

/**
 * Resolves a JSON Pointer (RFC 6901) against a value. A pointer the model writes without its
 * leading slash is read as if it had one. Anything that does not resolve is undefined, never an
 * error.
 */
export const resolveJsonPointer = (root: unknown, pointer: string): unknown => {
  const trimmed = pointer.trim();
  if (trimmed === "" || trimmed === "/") {
    return trimmed === "" ? root : isObject(root) ? root[""] : undefined;
  }
  const path = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  let current: unknown = root;
  for (const token of path.split("/").map(unescapePointerToken)) {
    if (Array.isArray(current)) {
      if (!ARRAY_INDEX.test(token)) return undefined;
      current = current[Number(token)];
    } else if (isObject(current) && Object.hasOwn(current, token)) {
      current = current[token];
    } else {
      return undefined;
    }
  }
  return current;
};

/** A record's key: its pointer, or a digest of it when it is too long to carry. */
const itemKey = (pointer: string): string => {
  const key = pointer === "" ? "/" : pointer;
  return key.length <= TOOL_RECORD_LIMITS.keyLength
    ? key
    : `sha256:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
};

interface FoundRecord {
  pointer: string;
  value: unknown;
}

/**
 * Every array whose items are all objects, at most `arrayDepth` deep, in document order. Its items
 * are records, and the walk does not go inside them, so a listing's own `photos` never become
 * records beside it.
 */
const collectRecordArrays = (value: unknown, pointer: string, depth: number, found: FoundRecord[]): void => {
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(isObject)) {
      value.forEach((item, index) => found.push({ pointer: `${pointer}/${index}`, value: item }));
      return;
    }
    if (depth < TOOL_RECORD_LIMITS.arrayDepth) {
      value.forEach((item, index) => collectRecordArrays(item, `${pointer}/${index}`, depth + 1, found));
    }
    return;
  }
  if (isObject(value) && depth < TOOL_RECORD_LIMITS.arrayDepth) {
    for (const [key, child] of Object.entries(value)) {
      collectRecordArrays(child, `${pointer}/${escapePointerToken(key)}`, depth + 1, found);
    }
  }
};

/** The token an image the skill returned as bytes stands under in its record, `tool-image:2`. */
const MEDIA_TOKEN_PREFIX = "tool-image:";

const mediaToken = (index: number): string => `${MEDIA_TOKEN_PREFIX}${index + 1}`;

const ellipsis = (value: string, maxLength: number): string => {
  const characters = Array.from(value);
  return characters.length <= maxLength ? value : `${characters.slice(0, maxLength - 1).join("")}…`;
};

/** Structural: a string that is an http(s) address. */
const HTTP_URL = /^https?:\/\//i;

/**
 * An address as the model sees it. A short one with no query is shown whole, so a reply can link
 * to it. A long one, or one with a query, such as a signed link whose query is its credential, is
 * cut to its origin and last path segment: enough to tell a photo from a page, and never the
 * secret. The card itself reads the whole address from the record.
 */
const compactUrl = (value: string): string => {
  try {
    const url = new URL(value);
    if (!url.search && !url.hash && !url.username && !url.password && value.length <= TOOL_RECORD_LIMITS.urlLength) {
      return value;
    }
    const last = url.pathname.split("/").filter(Boolean).pop();
    return ellipsis(last ? `${url.origin}/…/${last}` : url.origin, TOOL_RECORD_LIMITS.urlLength);
  } catch {
    return ellipsis(value, TOOL_RECORD_LIMITS.stringLength);
  }
};

/** A record as the model reads it: bounded in depth, keys, items and characters, its structure intact. */
const compactValue = (value: unknown, depth: number): unknown => {
  if (typeof value === "string") {
    return HTTP_URL.test(value) ? compactUrl(value) : ellipsis(value, TOOL_RECORD_LIMITS.stringLength);
  }
  if (Array.isArray(value)) {
    if (depth > TOOL_RECORD_LIMITS.recordDepth) return `[${value.length} items]`;
    const shown = value.slice(0, TOOL_RECORD_LIMITS.arrayItems).map((item) => compactValue(item, depth + 1));
    return value.length > shown.length ? [...shown, `+${value.length - shown.length}`] : shown;
  }
  if (isObject(value)) {
    if (depth > TOOL_RECORD_LIMITS.recordDepth) return "{…}";
    const entries = Object.entries(value);
    const shown: JsonObject = Object.fromEntries(entries
      .slice(0, TOOL_RECORD_LIMITS.recordKeys)
      .map(([key, child]) => [ellipsis(key, TOOL_RECORD_LIMITS.stringLength), compactValue(child, depth + 1)]));
    if (entries.length > TOOL_RECORD_LIMITS.recordKeys) {
      shown["…"] = `+${entries.length - TOOL_RECORD_LIMITS.recordKeys} keys`;
    }
    return shown;
  }
  return value;
};

const recordLine = (record: ToolRecord): string => `[${record.handle}] ${JSON.stringify(compactValue(record.value, 0))}`;

const SECTION_HEADING = "Records the tool returned, each under a handle such as [r1]. An address shortened with … is incomplete: never write one in the reply.";

const sectionText = (lines: readonly string[], hidden: number): string => [
  SECTION_HEADING,
  ...lines,
  ...(hidden > 0 ? [`(${hidden} more records not shown)`] : []),
].join("\n");

const fitsBudget = (text: string): boolean =>
  estimateTextGenerationInputTokens({ prompt: text }) <= CHAT_BEHAVIOR.skillResult.maxRecordInputTokens;

/**
 * The records a skill's result holds, each under a handle (`r1`, `r2`, …) the reply prompt shows
 * and the model points at. Found structurally: every array of objects in the outputs, or the
 * outputs themselves when they hold none, then each picture the skill returned as bytes. Only the
 * records whose view fits the prompt budget are offered; the rest are counted, never shown. The
 * ledger lives for one turn and is never stored.
 */
export class ToolRecordLedger {
  private readonly byHandle: ReadonlyMap<string, ToolRecord>;

  private constructor(
    private readonly records: readonly ToolRecord[],
    private readonly media: readonly SkillOutcomeMedia[],
    private readonly section: string,
    /** Records found but not offered: past the count or the prompt budget. */
    readonly hidden: number,
  ) {
    this.byHandle = new Map(records.map((record) => [record.handle, record]));
  }

  static fromOutcome(outputs: JsonObject | undefined, media: readonly SkillOutcomeMedia[] | undefined): ToolRecordLedger {
    const found: FoundRecord[] = [];
    if (outputs) {
      collectRecordArrays(outputs, "", 0, found);
      if (found.length === 0 && Object.keys(outputs).length > 0) {
        found.push({ pointer: "", value: outputs });
      }
    }
    const images = (media ?? []).filter((item) => item.kind === "image");
    const candidates: Array<{ key: string; value: unknown }> = [
      ...found.map(({ pointer, value }) => ({ key: itemKey(pointer), value })),
      ...images.map((_image, index) => ({ key: `media/${index + 1}`, value: { image: mediaToken(index) } })),
    ];
    const offered: ToolRecord[] = candidates
      .slice(0, TOOL_RECORD_LIMITS.records)
      .map((candidate, index) => ({ handle: `r${index + 1}`, ...candidate }));
    // Trimmed from the end: the first records are the ones a tool ranks first.
    const lines = offered.map(recordLine);
    while (lines.length > 0 && !fitsBudget(sectionText(lines, candidates.length - lines.length))) {
      lines.pop();
    }
    const shown = offered.slice(0, lines.length);
    return new ToolRecordLedger(
      shown,
      images,
      shown.length > 0 ? sectionText(lines, candidates.length - shown.length) : "",
      candidates.length - shown.length,
    );
  }

  get size(): number {
    return this.records.length;
  }

  record(handle: string): ToolRecord | undefined {
    return this.byHandle.get(handle);
  }

  /** The records as the model reads them, within the prompt budget; empty when there are none. */
  promptSection(): string {
    return this.section;
  }

  /** The stored image a record's value names by this turn's token, or undefined for any other value. */
  mediaImageId(value: unknown): string | undefined {
    if (typeof value !== "string" || !value.startsWith(MEDIA_TOKEN_PREFIX)) return undefined;
    const position = Number(value.slice(MEDIA_TOKEN_PREFIX.length));
    return Number.isInteger(position) && position >= 1 ? this.media[position - 1]?.imageId : undefined;
  }
}
