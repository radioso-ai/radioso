import { createHash } from "node:crypto";

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

/** A record's view as the model reads it: its shape kept, its size bounded. */
const recordView = (record: ToolRecord): string => JSON.stringify(compactValue(record.value, 0));

const SHORTENED_ADDRESS_NOTE = "An address shortened with … is incomplete: never write one in the reply.";

/**
 * The records as findings. With handles, for a reply offered cards, each record is `[r1] {…}`;
 * without, for a reply written as text alone, each is a plain list entry, so no handle can reach a
 * reply that shows no cards.
 */
const sectionText = (views: readonly string[], hidden: number, handles: boolean): string => [
  handles
    ? `Records the tool returned, each under a handle such as [r1]. ${SHORTENED_ADDRESS_NOTE}`
    : `Records the tool returned. ${SHORTENED_ADDRESS_NOTE}`,
  ...views.map((view, index) => (handles ? `[r${index + 1}] ${view}` : `- ${view}`)),
  ...(hidden > 0 ? [`(${hidden} more records not shown)`] : []),
].join("\n");

const fitsBudget = (text: string): boolean =>
  estimateTextGenerationInputTokens({ prompt: text }) <= CHAT_BEHAVIOR.skillResult.maxRecordInputTokens;

/**
 * Whether a skill's outputs hold at least one record: any non-empty outputs do, since an array of
 * objects in them yields records and, failing that, the outputs themselves are one. A check of the
 * shape alone, without walking or rendering anything.
 */
export const hasToolRecords = (outputs: JsonObject | undefined): boolean =>
  outputs !== undefined && Object.keys(outputs).length > 0;

/**
 * The records a skill's result holds, each under a handle (`r1`, `r2`, …) the reply prompt shows
 * and the model points at. Found structurally: every array of objects in the outputs, or the
 * outputs themselves when they hold none. Only the records whose view fits the prompt budget are
 * offered; the rest are counted, never shown. The ledger lives for one turn and is never stored,
 * and it is read only by a reply that offers cards, the one place its handles mean anything.
 */
export class ToolRecordLedger {
  private readonly byHandle: ReadonlyMap<string, ToolRecord>;

  private constructor(
    private readonly records: readonly ToolRecord[],
    private readonly views: readonly string[],
    /** Records found but not offered: past the count or the prompt budget. */
    readonly hidden: number,
  ) {
    this.byHandle = new Map(records.map((record) => [record.handle, record]));
  }

  static fromOutputs(outputs: JsonObject | undefined): ToolRecordLedger {
    const found: FoundRecord[] = [];
    if (outputs) {
      collectRecordArrays(outputs, "", 0, found);
      if (found.length === 0 && Object.keys(outputs).length > 0) {
        found.push({ pointer: "", value: outputs });
      }
    }
    const candidates = found.map(({ pointer, value }) => ({ key: itemKey(pointer), value }));
    const offered: ToolRecord[] = candidates
      .slice(0, TOOL_RECORD_LIMITS.records)
      .map((candidate, index) => ({ handle: `r${index + 1}`, ...candidate }));
    // Trimmed from the end: the first records are the ones a tool ranks first.
    const views = offered.map(recordView);
    while (views.length > 0 && !fitsBudget(sectionText(views, candidates.length - views.length, true))) {
      views.pop();
    }
    return new ToolRecordLedger(offered.slice(0, views.length), views, candidates.length - views.length);
  }

  get size(): number {
    return this.records.length;
  }

  record(handle: string): ToolRecord | undefined {
    return this.byHandle.get(handle);
  }

  /**
   * The records as the model reads them, within the prompt budget; empty when there are none.
   * Without handles for a reply that shows no cards.
   */
  promptSection(options: { handles: boolean } = { handles: true }): string {
    return this.views.length > 0 ? sectionText(this.views, this.hidden, options.handles) : "";
  }
}
