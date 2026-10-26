import { randomUUID } from "node:crypto";
import type { z } from "zod";

import type { ModelCallUsageContext } from "../domain/modelCallUsageContext.js";
import type { ModelInferencePipeline } from "../infra/llm/modelInferencePipeline.js";
import { createReusableInputBoundary } from "../infra/llm/inputTokenCaching.js";
import {
  AGENT_STEP_MAX_INPUT_TOKENS,
  type ModelToolCall,
  type ModelToolCallRequest,
  type ModelToolCallResponse,
  type ModelToolCallingGateway,
  type ModelTranscriptEntry,
  type ToolSchema,
} from "./types.js";

const PROTOCOL_INSTRUCTIONS = `Respond with EXACTLY one JSON object — no prose, no markdown fences:
{"text": "...", "tool_calls": [{"id": "...", "name": "...", "arguments": {...}}]}

When tool_calls is non-empty, "text" MUST be empty. When tool_calls is empty, "text" is your final message.`;

const KEEP_RECENT_STEPS_FULL = 2;

/**
 * Provider-agnostic `ModelToolCallingGateway` that routes through the shared
 * inference pipeline. The model is asked to respond with a single JSON
 * object describing the assistant message and optional tool calls; the gateway
 * parses that response into the runtime's structured format.
 *
 * This is the default gateway because it works across every provider Radioso
 * configures (OpenAI, Claude, Gemini, openai-compatible local models) without
 * a per-provider adapter. Native tool-calling adapters can be added later as
 * optional optimizations for specific providers where quality or cost differ
 * enough to justify the maintenance overhead.
 */
export class TextRoutedToolCallingGateway implements ModelToolCallingGateway {
  constructor(
    private readonly client: ModelInferencePipeline,
    private readonly options: { readonly temperature?: number; readonly maxOutputTokens?: number } = {},
  ) {}

  async request(input: ModelToolCallRequest): Promise<ModelToolCallResponse> {
    const systemPrompt = buildSystemPrompt(input);
    const prompt = buildPrompt(input);
    const result = await this.client.complete({
      operation: {
        ...(input.usageContext ?? fallbackUsageContext()),
        operation: "agent_step",
        attemptKey: `agent_step:${input.stepIndex}`,
      },
      prompt,
      systemPrompt,
      reusableInputBoundary: createReusableInputBoundary({ stableSystemPrefix: systemPrompt }),
      temperature: this.options.temperature,
      maxOutputTokens: this.options.maxOutputTokens,
      // Agent steps accumulate uncompacted recent tool results (bounded by the
      // tool-result ceiling) plus fixed prompt overhead, which can exceed the
      // pipeline's protective 32k global default. Use the larger explicit
      // agent-step budget so a legitimate deep-retrieval turn is not aborted
      // mid-run with payloadTooLarge(413).
      maxInputTokens: AGENT_STEP_MAX_INPUT_TOKENS,
    });
    return parseModelResponse(result.text);
  }
}

const fallbackUsageContext = (): Omit<ModelCallUsageContext, "operation"> => ({
  workspaceId: "unknown",
  requestId: randomUUID(),
  surface: "agent_runtime",
  attemptKey: "agent_step",
});

const buildSystemPrompt = (input: ModelToolCallRequest): string => {
  const toolCatalog = input.toolSchemas.map(formatToolForCatalog).join("\n");
  return `${input.systemPrompt}\n\n${PROTOCOL_INSTRUCTIONS}\n\nTools:\n${toolCatalog}`;
};

const formatToolForCatalog = (schema: ToolSchema): string =>
  `- ${schema.name}${formatToolSignature(schema.inputSchema)} — ${schema.description}`;

/** Zod's own discriminated view of a schema's definition, so each case below reads typed fields. */
const definitionOf = (schema: z.core.$ZodType): z.core.$ZodTypes["_zod"]["def"] =>
  (schema as z.core.$ZodTypes)._zod.def;

const formatToolSignature = (schema: z.core.$ZodType): string => {
  const unwrapped = unwrapSchema(schema);
  const def = definitionOf(unwrapped);
  if (def.type !== "object") {
    return "(unknown)";
  }
  return `(${formatObjectFields(def.shape, 0).join(", ")})`;
};

const formatObjectFields = (shape: z.core.$ZodShape, depth: number): string[] => {
  const fields: string[] = [];
  for (const [name, child] of Object.entries(shape)) {
    const optional = isOptional(child);
    fields.push(`${name}${optional ? "?" : ""}: ${formatZodType(unwrapSchema(child), depth)}`);
  }
  return fields;
};

/**
 * The schema a pipe carries its shape in. `.transform()` pipes a schema into a transform and
 * `z.preprocess()` pipes a transform into a schema; either way the transform says nothing about
 * what to send. A pipe between two schemas (`.pipe()`) has no shape-free side, so it stays whole.
 */
const shapedSideOfPipe = (def: z.core.$ZodPipeDef): z.core.$ZodType | null => {
  if (definitionOf(def.out).type === "transform") return def.in;
  if (definitionOf(def.in).type === "transform") return def.out;
  return null;
};

/**
 * Sees through the wrappers that carry no shape of their own — `.optional()`, `.nullable()`,
 * `.default()`, and the pipe a `.transform()` or `z.preprocess()` produces. A transformed object
 * rendered as its wrapper tells a model nothing about what to send.
 */
const unwrapSchema = (schema: z.core.$ZodType): z.core.$ZodType => {
  const def = definitionOf(schema);
  switch (def.type) {
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
      return unwrapSchema(def.innerType);
    case "pipe": {
      const shaped = shapedSideOfPipe(def);
      return shaped ? unwrapSchema(shaped) : schema;
    }
    default:
      return schema;
  }
};

const isOptional = (schema: z.core.$ZodType): boolean => {
  const def = definitionOf(schema);
  if (def.type === "optional" || def.type === "default" || def.type === "prefault") return true;
  if (def.type === "pipe") {
    const shaped = shapedSideOfPipe(def);
    return shaped ? isOptional(shaped) : false;
  }
  return false;
};

/** The first explicit bound of each kind, as written — not the safe-integer range `.int()` implies. */
const explicitNumberBound = (def: z.core.$ZodNumberDef, check: "greater_than" | "less_than"): number | undefined => {
  for (const candidate of def.checks ?? []) {
    const checkDef = candidate._zod.def as { check: string; value?: unknown };
    if (checkDef.check === check && typeof checkDef.value === "number") return checkDef.value;
  }
  return undefined;
};

const arrayLengthBound = (def: z.core.$ZodArrayDef, check: "min_length" | "max_length"): number | undefined => {
  for (const candidate of def.checks ?? []) {
    const checkDef = candidate._zod.def as { check: string; minimum?: unknown; maximum?: unknown };
    if (checkDef.check !== check) continue;
    const bound = check === "min_length" ? checkDef.minimum : checkDef.maximum;
    if (typeof bound === "number") return bound;
  }
  return undefined;
};

// One level of nesting is spelled out, deeper structure collapses to `object`. A tool whose input
// shape renders as the bare word "object" cannot be called correctly: the model has nothing to go
// on and invents a shape, which is a rejected call rather than a wrong answer.
const MAX_SHAPE_DEPTH = 2;

const formatZodType = (schema: z.core.$ZodType, depth = 0): string => {
  const def = definitionOf(schema);
  switch (def.type) {
    case "string":
      return "string";
    case "number": {
      const isInt = (schema as z.ZodNumber).isInt;
      const min = explicitNumberBound(def, "greater_than");
      const max = explicitNumberBound(def, "less_than");
      const base = isInt ? "integer" : "number";
      if (min !== undefined && max !== undefined) return `${base} ${min}..${max}`;
      return base;
    }
    case "boolean":
      return "boolean";
    case "array": {
      const minLength = arrayLengthBound(def, "min_length");
      const maxLength = arrayLengthBound(def, "max_length");
      const constraints =
        minLength !== undefined || maxLength !== undefined ? `[${minLength ?? 0}..${maxLength ?? "∞"}]` : "";
      return `array of ${formatZodType(unwrapSchema(def.element), depth)}${constraints}`;
    }
    case "object": {
      if (depth >= MAX_SHAPE_DEPTH) return "object";
      return `{${formatObjectFields(def.shape, depth + 1).join(", ")}}`;
    }
    case "record":
      return "object";
    case "union":
      // The catalog has always named a discriminated union apart from a plain one.
      return "discriminator" in def ? "discriminatedunion" : "union";
    case "literal":
      return def.values.map((value) => JSON.stringify(value)).join("|");
    case "enum":
      return `enum<${Object.values(def.entries).join("|")}>`;
    case "unknown":
    case "any":
    case "custom":
      return "any";
    case "pipe":
      return "pipeline";
    default:
      return def.type;
  }
};

const buildPrompt = (input: ModelToolCallRequest): string => {
  const compacted = compactTranscript(input.transcript);
  const lines: string[] = ["Conversation so far:"];
  for (const entry of compacted) {
    lines.push("");
    if (entry.role === "user") {
      lines.push(`USER:\n${entry.content}`);
      continue;
    }
    if (entry.role === "assistant") {
      const payload = {
        text: entry.content,
        tool_calls: entry.toolCalls.map((call) => ({
          id: call.callId,
          name: call.toolName,
          arguments: tryParseArgs(call.rawArguments),
        })),
      };
      lines.push(`ASSISTANT:\n${JSON.stringify(payload)}`);
      continue;
    }
    const marker = entry.isError ? " [ERROR]" : "";
    lines.push(`TOOL RESULT (call ${entry.callId}, tool ${entry.toolName})${marker}:\n${entry.content}`);
  }
  lines.push("");
  lines.push("Respond now with the next JSON object only.");
  return lines.join("\n");
};

/**
 * Keep the most recent assistant turns and their following tool results full;
 * compact older tool results to a one-line summary. Search/list results are
 * compacted to `[N chunks elided: id1, id2, …]` so the agent can still
 * reference chunk ids for rerank/fetch/finalize via the registry. Other
 * results collapse to `[N chars elided]`. Tool errors are truncated rather
 * than collapsed so the agent can still see what went wrong.
 *
 * Without this the transcript carries every prior search result for the full
 * run, which dominates token cost on long-running agents.
 */
export const compactTranscript = (
  entries: ReadonlyArray<ModelTranscriptEntry>,
): ModelTranscriptEntry[] => {
  const assistantIndices: number[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    if (entries[i].role === "assistant") {
      assistantIndices.push(i);
    }
  }
  if (assistantIndices.length <= KEEP_RECENT_STEPS_FULL) {
    return [...entries];
  }
  // Start of the kept window = the (length - KEEP)th assistant's index.
  // Everything strictly before this index is "old" and gets compacted.
  const keptStart = assistantIndices[assistantIndices.length - KEEP_RECENT_STEPS_FULL];
  return entries.map((entry, i) => {
    if (i >= keptStart || entry.role !== "tool") {
      return entry;
    }
    return { ...entry, content: compactToolResultContent(entry.content, entry.isError) };
  });
};

const compactToolResultContent = (content: string, isError: boolean): string => {
  if (isError) {
    return content.length > 200 ? `${content.slice(0, 200)}…` : content;
  }
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === "object") {
      const results = (parsed as { results?: Array<{ chunkId?: unknown }> }).results;
      if (Array.isArray(results)) {
        const ids = results
          .map((r) => (typeof r?.chunkId === "string" ? r.chunkId : null))
          .filter((id): id is string => id !== null);
        return `[${ids.length} chunks elided: ${ids.slice(0, 5).join(", ")}${ids.length > 5 ? ", …" : ""}]`;
      }
    }
  } catch {
    // not JSON, fall through
  }
  return `[${content.length} chars elided]`;
};

const tryParseArgs = (raw: string): unknown => {
  if (!raw || raw.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

export const parseModelResponse = (raw: string): ModelToolCallResponse => {
  const block = extractJsonBlock(raw);
  if (!block) {
    return { assistantMessage: raw.trim(), toolCalls: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return { assistantMessage: raw.trim(), toolCalls: [] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { assistantMessage: raw.trim(), toolCalls: [] };
  }
  const obj = parsed as { text?: unknown; tool_calls?: unknown };
  const text = typeof obj.text === "string" ? obj.text : "";
  const toolCalls = parseToolCalls(obj.tool_calls);
  return { assistantMessage: text, toolCalls };
};

export const extractJsonBlock = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenced) {
    return fenced[1].trim();
  }
  const firstBrace = trimmed.indexOf("{");
  if (firstBrace === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = firstBrace; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return trimmed.slice(firstBrace, i + 1);
      }
    }
  }
  return null;
};

const parseToolCalls = (raw: unknown): ModelToolCall[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  const calls: ModelToolCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const candidate = item as { id?: unknown; name?: unknown; arguments?: unknown };
    const toolName = typeof candidate.name === "string" && candidate.name.length > 0 ? candidate.name : null;
    if (!toolName) {
      continue;
    }
    const callId =
      typeof candidate.id === "string" && candidate.id.length > 0
        ? candidate.id
        : `call_${calls.length + 1}`;
    const rawArguments = serializeArguments(candidate.arguments);
    calls.push({ callId, toolName, rawArguments });
  }
  return calls;
};

const serializeArguments = (raw: unknown): string => {
  if (raw === undefined || raw === null) {
    return "{}";
  }
  if (typeof raw === "string") {
    return raw;
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return "{}";
  }
};
