import { z } from "zod";

export const protocolVersion = 1 as const;
export const TRANSPORT_ENVELOPE_MAX_BYTES = 8 * 1024;
export const BROWSER_FRAME_MAX_BYTES = 4 * 1024;

export const INVALIDATION_KINDS = [
  "document.status_changed", "crawl.status_changed", "crawl.progress",
  "conversation.created", "conversation.turn_committed", "conversation.contact_delivery_changed",
  "conversation.ownership_changed", "search.created", "hitl.decision_created", "hitl.decision_resolved",
  "quality.feedback_changed", "quality.triage_changed",
] as const;

export type WorkspaceInvalidationKind = typeof INVALIDATION_KINDS[number];

const uniqueKinds = <T extends z.ZodTypeAny>(schema: T) =>
  schema.refine((kinds) => new Set(kinds as string[]).size === (kinds as string[]).length, "changeKinds must be unique");

export const workspaceInvalidationKindSchema = z.enum(INVALIDATION_KINDS);
export const workspaceInvalidationEnvelopeSchema = z.object({
  protocolVersion: z.literal(protocolVersion),
  workspaceId: z.string().uuid(),
  changeKinds: uniqueKinds(z.array(workspaceInvalidationKindSchema).min(1).max(INVALIDATION_KINDS.length)),
}).strict();

export type WorkspaceInvalidationEnvelope = z.infer<typeof workspaceInvalidationEnvelopeSchema>;

export const browserEventFrameSchema = z.discriminatedUnion("type", [
  z.object({ protocolVersion: z.literal(protocolVersion), type: z.literal("ready") }).strict(),
  z.object({ protocolVersion: z.literal(protocolVersion), type: z.literal("resync") }).strict(),
  z.object({
    protocolVersion: z.literal(protocolVersion), type: z.literal("invalidate"),
    changeKinds: uniqueKinds(z.array(workspaceInvalidationKindSchema).min(1).max(INVALIDATION_KINDS.length)),
  }).strict(),
]);

export type BrowserEventFrame = z.infer<typeof browserEventFrameSchema>;

export const workspaceChannel = (prefix: string, workspaceId: string): string => {
  const parsedId = z.string().uuid().parse(workspaceId);
  const parsedPrefix = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9:_-]+$/u).parse(prefix);
  return `${parsedPrefix}:workspace:{${parsedId}}`;
};

const encoder = new TextEncoder();
const decodeUtf8 = (input: Uint8Array): string => new TextDecoder("utf-8", { fatal: true }).decode(input);

export const parseTransportEnvelope = (input: Uint8Array | string, byteCap = TRANSPORT_ENVELOPE_MAX_BYTES): WorkspaceInvalidationEnvelope => {
  if (typeof input === "string" && input.length > byteCap) {
    throw new Error(`Workspace invalidation transport envelope exceeds byte cap of ${byteCap}`);
  }
  const byteLength = typeof input === "string" ? encoder.encode(input).byteLength : input.byteLength;
  if (byteLength > byteCap) {
    throw new Error(`Workspace invalidation transport envelope exceeds byte cap of ${byteCap}`);
  }
  const decoded = typeof input === "string" ? input : decodeUtf8(input);
  return workspaceInvalidationEnvelopeSchema.parse(JSON.parse(decoded) as unknown);
};

/** Receiver-only parser: future/malformed frames are silently ignored while emitters stay strict. */
export const decodeBrowserEventFrame = (input: Uint8Array | string): BrowserEventFrame | undefined => {
  try {
    if (typeof input === "string" && input.length > BROWSER_FRAME_MAX_BYTES) return undefined;
    const byteLength = typeof input === "string" ? encoder.encode(input).byteLength : input.byteLength;
    if (byteLength > BROWSER_FRAME_MAX_BYTES) return undefined;
    const value: unknown = JSON.parse(typeof input === "string" ? input : decodeUtf8(input));
    if (!value || typeof value !== "object" || (value as { protocolVersion?: unknown }).protocolVersion !== protocolVersion) return undefined;
    const record = value as { type?: unknown; changeKinds?: unknown };
    if (record.type === "ready" || record.type === "resync") return browserEventFrameSchema.safeParse(value).data;
    if (record.type !== "invalidate" || !Array.isArray(record.changeKinds)) return undefined;
    if (Object.keys(record).some((key) => !["protocolVersion", "type", "changeKinds"].includes(key))) return undefined;
    const changeKinds = record.changeKinds.filter((kind): kind is WorkspaceInvalidationKind => typeof kind === "string" && INVALIDATION_KINDS.includes(kind as WorkspaceInvalidationKind));
    return changeKinds.length === 0 ? undefined : { protocolVersion, type: "invalidate", changeKinds: [...new Set(changeKinds)].slice(0, INVALIDATION_KINDS.length) };
  } catch {
    return undefined;
  }
};

export type EnqueueResult =
  | { accepted: true; coalesced: boolean }
  | { accepted: false; reason: "capacity" | "disabled" | "shutdown" | "invalid" };

/** Deliberately synchronous: domain mutations must never await transient transport work. */
export interface WorkspaceInvalidationPublisher {
  enqueue(workspaceId: string, changeKinds: readonly WorkspaceInvalidationKind[]): EnqueueResult;
}

export const createNoopWorkspaceInvalidationPublisher = (): WorkspaceInvalidationPublisher => ({
  enqueue: () => ({ accepted: false, reason: "disabled" }),
});
