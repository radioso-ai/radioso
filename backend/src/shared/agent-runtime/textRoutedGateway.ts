import { randomUUID } from "node:crypto";
import { z, type ZodTypeAny } from "zod";

import type { ModelCallUsageContext } from "../domain/modelCallUsageContext.js";
import type { ModelInferencePipeline } from "../infra/llm/modelInferencePipeline.js";
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

export interface TextRoutedToolCallingGatewayOptions {
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
}

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
    private readonly options: TextRoutedToolCallingGatewayOptions = {},
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

const formatToolSignature = (schema: ZodTypeAny): string => {
  const unwrapped = unwrapSchema(schema);
  const def = unwrapped._def as { typeName: z.ZodFirstPartyTypeKind };
  if (def.typeName !== z.ZodFirstPartyTypeKind.ZodObject) {
    return "(unknown)";
  }
  return `(${formatObjectFields(unwrapped as z.ZodObject<z.ZodRawShape>, 0).join(", ")})`;
};

const formatObjectFields = (schema: z.ZodObject<z.ZodRawShape>, depth: number): string[] => {
  const fields: string[] = [];
  for (const [name, child] of Object.entries(schema.shape)) {
    const childSchema = child;
    const optional = isOptional(childSchema);
    fields.push(`${name}${optional ? "?" : ""}: ${formatZodType(unwrapSchema(childSchema), depth)}`);
  }
  return fields;
};

/**
 * Sees through the wrappers that carry no shape of their own — `.optional()`, `.nullable()`,
 * `.default()`, and the `ZodEffects` a `.refine()` produces. A refined object rendered as its
 * wrapper tells a model nothing about what to send.
 */
const unwrapSchema = (schema: ZodTypeAny): ZodTypeAny => {
  const def = schema._def as { typeName: z.ZodFirstPartyTypeKind; innerType?: ZodTypeAny; schema?: ZodTypeAny };
  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodOptional:
    case z.ZodFirstPartyTypeKind.ZodNullable:
    case z.ZodFirstPartyTypeKind.ZodDefault:
      return def.innerType ? unwrapSchema(def.innerType) : schema;
    case z.ZodFirstPartyTypeKind.ZodEffects:
      return def.schema ? unwrapSchema(def.schema) : schema;
    default:
      return schema;
  }
};

const isOptional = (schema: ZodTypeAny): boolean => {
  const typeName = (schema._def as { typeName: z.ZodFirstPartyTypeKind }).typeName;
  if (typeName === z.ZodFirstPartyTypeKind.ZodOptional || typeName === z.ZodFirstPartyTypeKind.ZodDefault) return true;
  if (typeName === z.ZodFirstPartyTypeKind.ZodEffects) {
    const inner = (schema._def as { schema?: ZodTypeAny }).schema;
    return inner ? isOptional(inner) : false;
  }
  return false;
};

// One level of nesting is spelled out, deeper structure collapses to `object`. A tool whose input
// shape renders as the bare word "object" cannot be called correctly: the model has nothing to go
// on and invents a shape, which is a rejected call rather than a wrong answer.
const MAX_SHAPE_DEPTH = 2;

const formatZodType = (schema: ZodTypeAny, depth = 0): string => {
  const def = schema._def as { typeName: z.ZodFirstPartyTypeKind; [key: string]: unknown };
  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodString:
      return "string";
    case z.ZodFirstPartyTypeKind.ZodNumber: {
      const checks = (def.checks as Array<{ kind: string; value?: number }> | undefined) ?? [];
      const isInt = checks.some((c) => c.kind === "int");
      const min = checks.find((c) => c.kind === "min")?.value;
      const max = checks.find((c) => c.kind === "max")?.value;
      const base = isInt ? "integer" : "number";
      if (min !== undefined && max !== undefined) return `${base} ${min}..${max}`;
      return base;
    }
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return "boolean";
    case z.ZodFirstPartyTypeKind.ZodArray: {
      const arrayDef = def as unknown as {
        type: ZodTypeAny;
        minLength?: { value: number } | null;
        maxLength?: { value: number } | null;
      };
      const minLength = arrayDef.minLength?.value;
      const maxLength = arrayDef.maxLength?.value;
      const constraints =
        minLength !== undefined || maxLength !== undefined ? `[${minLength ?? 0}..${maxLength ?? "∞"}]` : "";
      return `array of ${formatZodType(unwrapSchema(arrayDef.type), depth)}${constraints}`;
    }
    case z.ZodFirstPartyTypeKind.ZodObject: {
      if (depth >= MAX_SHAPE_DEPTH) return "object";
      return `{${formatObjectFields(schema as z.ZodObject<z.ZodRawShape>, depth + 1).join(", ")}}`;
    }
    case z.ZodFirstPartyTypeKind.ZodRecord:
      return "object";
    case z.ZodFirstPartyTypeKind.ZodUnion:
      return "union";
    case z.ZodFirstPartyTypeKind.ZodLiteral:
      return JSON.stringify((def as unknown as { value: unknown }).value);
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return `enum<${(def as unknown as { values: string[] }).values.join("|")}>`;
    case z.ZodFirstPartyTypeKind.ZodUnknown:
    case z.ZodFirstPartyTypeKind.ZodAny:
      return "any";
    default:
      return def.typeName.replace(/^Zod/, "").toLowerCase();
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
