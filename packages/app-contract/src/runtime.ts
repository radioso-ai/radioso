import { z } from "zod";

import {
  base64BodySchema,
  boundedHeaderRecordSchema,
  boundedJsonRecordSchema,
  boundedJsonValueSchema,
  containsLoneSurrogate,
  formUrlencodedLength,
  refineBoundedJsonRecord,
  refineObjectBreadth,
} from "./bounds.js";
import { configurationValuesSchema } from "./configuration.js";
import { executionClassSchema } from "./contributions.js";
import {
  appliedHeaderNameSchema,
  contributionIdSchema,
  destinationIdSchema,
  digestSchema,
  httpHeaderNameSchema,
  indexedFieldKeySchema,
  schemaVersionSchema,
  timestampSchema,
} from "./identifiers.js";
import {
  storageDeleteRequestSchema,
  storageGetRequestSchema,
  storagePutRequestSchema,
  storageQueryRequestSchema,
  storageQueryResultSchema,
  storageRecordSchema,
  storageScalarValueSchema,
  storageVersionSchema,
} from "./storage.js";

export const RUNTIME_PROTOCOL_VERSION = 1;

/**
 * Errors travel as a code plus a short sentence. The bound is the point: an App
 * cannot use an error to smuggle a payload back through the host's logs.
 */
export const MAX_ERROR_MESSAGE_LENGTH = 512;

/** Keys one ingest call may carry, matching the indexed-field policy ceiling. */
export const MAX_DOCUMENT_METADATA_KEYS = 64;

export const appErrorCodes = [
  "denied",
  "not_found",
  "invalid_input",
  "quota_exceeded",
  "version_conflict",
  "destination_denied",
  "deadline_exceeded",
  "unavailable",
  "internal",
] as const;
export const appErrorCodeSchema = z.enum(appErrorCodes);

export const appErrorSchema = z
  .object({
    code: appErrorCodeSchema,
    message: z.string().min(1).max(MAX_ERROR_MESSAGE_LENGTH),
  })
  .strict();

export const webhookInvocationInputSchema = z
  .object({
    kind: z.literal("webhook"),
    deliveryId: z.string().min(1).max(200),
    receivedAt: timestampSchema,
    headers: boundedHeaderRecordSchema(httpHeaderNameSchema),
    body: base64BodySchema,
  })
  .strict();

export const scheduledInvocationInputSchema = z
  .object({
    kind: z.literal("scheduled"),
    occurrenceId: z.string().min(1).max(200),
    scheduledFor: timestampSchema,
    checkpoint: boundedJsonRecordSchema.optional(),
  })
  .strict();

export const backfillInvocationInputSchema = z
  .object({
    kind: z.literal("backfill"),
    requestId: z.string().min(1).max(200),
    checkpoint: boundedJsonRecordSchema.optional(),
  })
  .strict();

export const invocationInputSchema = z.discriminatedUnion("kind", [
  webhookInvocationInputSchema,
  scheduledInvocationInputSchema,
  backfillInvocationInputSchema,
]);

export type InvocationInputKind = z.infer<typeof invocationInputSchema>["kind"];

/**
 * Which input kinds an execution class may carry. The host supplies both, so a
 * request that pairs them wrongly is a host defect the boundary catches rather
 * than a precedence rule every reader has to invent.
 */
const INPUT_KINDS_BY_EXECUTION_CLASS: Readonly<Record<string, readonly InvocationInputKind[]>> = {
  external_webhook: ["webhook"],
  scheduled_task: ["scheduled", "backfill"],
};

/**
 * Invocation-scoped handle for host operations: managed storage, approved
 * egress, declared UI commands. It is minted per invocation, bound to this
 * installation, contribution, and execution class, and it expires.
 */
export const capabilitySessionSchema = z
  .object({
    token: z.string().min(1).max(4096),
    expiresAt: timestampSchema,
  })
  .strict();

/**
 * What the operator configured, as the App reads it. The host validates these
 * values against the manifest before it mints an invocation, so a handler never
 * has to guess which post types, which folder, or which locale an installation
 * meant — and never receives a secret, because no configuration field can hold
 * one.
 */
export const installationContextSchema = z
  .object({ configuration: configurationValuesSchema })
  .strict();

export const invocationRequestSchema = z
  .object({
    protocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
    invocationId: z.string().uuid(),
    installationId: z.string().uuid(),
    releaseDigest: digestSchema,
    contributionId: contributionIdSchema,
    executionClass: executionClassSchema,
    inputSchemaVersion: schemaVersionSchema,
    attempt: z.number().int().min(1).max(100),
    idempotencyKey: z.string().min(1).max(200),
    deadlineAt: timestampSchema,
    capabilitySession: capabilitySessionSchema,
    context: installationContextSchema,
    input: invocationInputSchema,
  })
  .strict()
  .superRefine((request, context) => {
    const allowed = INPUT_KINDS_BY_EXECUTION_CLASS[request.executionClass] ?? [];
    if (allowed.includes(request.input.kind)) return;
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["input", "kind"],
      message: `Execution class ${request.executionClass} does not carry a ${request.input.kind} input`,
    });
  });

/** What an artifact answers before the host sends it any work. */
export const healthResponseSchema = z
  .object({
    protocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
    ready: z.boolean(),
    implementedContributionIds: z.array(contributionIdSchema).max(32),
  })
  .strict();

/**
 * A closed catalog: success, a request the App could not read, a denial, an
 * unavailable dependency, a rate limit, a failure worth retrying, a failure that
 * is not, a timeout, and a cancellation. Nothing collapses two of those into one.
 */
export const invocationOutcomes = [
  "succeeded",
  "invalid_request",
  "denied",
  "unavailable",
  "rate_limited",
  "retryable_failure",
  "terminal_failure",
  "timed_out",
  "cancelled",
] as const;
export const invocationOutcomeSchema = z.enum(invocationOutcomes);

export const invocationCountsSchema = z
  .object({
    ingested: z.number().int().min(0),
    deleted: z.number().int().min(0),
    skipped: z.number().int().min(0),
  })
  .strict();

/**
 * The App's declared output for its `outputSchemaVersion`. `counts` is the one
 * key the host reads for the installation's health view; everything else is
 * App-shaped and bounded rather than interpreted.
 */
export const invocationOutputSchema = z
  .any()
  .superRefine(refineObjectBreadth)
  .pipe(
    z
      .object({ counts: invocationCountsSchema.optional() })
      .catchall(boundedJsonValueSchema)
      .superRefine(refineBoundedJsonRecord),
  );

const responseHeader = {
  protocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
  invocationId: z.string().uuid(),
};

const succeededResponse = z
  .object({
    ...responseHeader,
    outcome: z.literal("succeeded"),
    outputSchemaVersion: schemaVersionSchema,
    output: invocationOutputSchema,
    checkpoint: boundedJsonRecordSchema.optional(),
  })
  .strict();

type Outcome = (typeof invocationOutcomes)[number];

/** Worth another attempt, so it may report progress and ask the host to wait. */
type ResumableOutcome = Extract<Outcome, "retryable_failure" | "rate_limited" | "unavailable">;

const resumableResponse = <O extends ResumableOutcome>(outcome: O) =>
  z
    .object({
      ...responseHeader,
      outcome: z.literal(outcome),
      error: appErrorSchema,
      retryAfterSeconds: z.number().int().min(0).max(86_400).optional(),
      checkpoint: boundedJsonRecordSchema.optional(),
    })
    .strict();

/** Over for this unit of work: no output, no checkpoint, no retry hint. */
type TerminalOutcome = Extract<
  Outcome,
  "invalid_request" | "denied" | "terminal_failure" | "timed_out" | "cancelled"
>;

const terminalResponse = <O extends TerminalOutcome>(outcome: O) =>
  z
    .object({
      ...responseHeader,
      outcome: z.literal(outcome),
      error: appErrorSchema,
    })
    .strict();

/**
 * Discriminated on `outcome`, so the arms are mutually exclusive by
 * construction: a success cannot carry an error, and a terminal failure cannot
 * carry a checkpoint or a retry hint that nothing would ever read.
 */
export const invocationResponseSchema = z.discriminatedUnion("outcome", [
  succeededResponse,
  resumableResponse("retryable_failure"),
  resumableResponse("rate_limited"),
  resumableResponse("unavailable"),
  terminalResponse("invalid_request"),
  terminalResponse("denied"),
  terminalResponse("terminal_failure"),
  terminalResponse("timed_out"),
  terminalResponse("cancelled"),
]);

export const documentContentFormatSchema = z.enum(["html", "markdown", "text"]);

/** A metadata value is comparable by a rule: one scalar per key. */
const documentMetadataValueSchema = z.union([
  z.string().max(1024),
  z.number().finite(),
  z.boolean(),
]);

const boundedFieldRecord = <V extends z.ZodTypeAny>(value: V) =>
  z
    .record(indexedFieldKeySchema, value)
    .refine(
      (fields) => Object.keys(fields).length <= MAX_DOCUMENT_METADATA_KEYS,
      `At most ${MAX_DOCUMENT_METADATA_KEYS} keys`,
    );

/**
 * What an App writes into the workspace. Provenance — which App, which release,
 * which source contribution — is the host's to attach, so it is not expressible
 * here; the request only says which declared source the write belongs to.
 */
export const documentIngestInputSchema = z
  .object({
    externalDocumentId: z.string().min(1).max(256),
    title: z.string().min(1).max(512),
    content: z
      .object({
        format: documentContentFormatSchema,
        value: z.string().max(4_000_000),
      })
      .strict(),
    sourceUrl: z.string().url().max(2048).optional(),
    indexedFields: boundedFieldRecord(storageScalarValueSchema).optional(),
    metadata: boundedFieldRecord(documentMetadataValueSchema).optional(),
    publishedAt: timestampSchema.optional(),
    modifiedAt: timestampSchema.optional(),
    author: z.string().min(1).max(256).optional(),
  })
  .strict();

/**
 * Origin-relative only. `new URL(path, approvedBase)` replaces the host for an
 * absolute or authority-form path, so a broker that resolves one would leave the
 * approved destination behind while every later check still says it is inside it.
 */
const ORIGIN_RELATIVE_PATH_PATTERN = /^\/(?!\/)[^\\#]*$/u;

/** Entries in one egress query string, and its total URL-encoded size. */
export const MAX_EGRESS_QUERY_ENTRIES = 64;
export const MAX_EGRESS_QUERY_BYTES = 8 * 1024;

/**
 * The broker builds the query as `application/x-www-form-urlencoded`, exactly as
 * `URLSearchParams` serializes it, so the ceiling is measured in that encoding
 * and not in a looser one — `encodeURIComponent` leaves `!` and `'` alone where
 * `URLSearchParams` escapes them, which would let a query pass here and exceed
 * the ceiling once the broker built it.
 *
 * The count is checked before anything is measured, so a query with a hundred
 * thousand individually-valid pairs is refused without the host sizing each one,
 * and a lone surrogate is refused as an ordinary issue rather than throwing out
 * of the encoder.
 */
const egressQuerySchema = z
  .record(z.string().max(128), z.string().max(2048))
  .superRefine((query, context) => {
    let entries = 0;
    for (const key in query) {
      if (!Object.hasOwn(query, key)) continue;
      entries += 1;
      if (entries <= MAX_EGRESS_QUERY_ENTRIES) continue;
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: `A query may hold at most ${MAX_EGRESS_QUERY_ENTRIES} entries`,
      });
      return;
    }
    let bytes = 0;
    for (const key in query) {
      if (!Object.hasOwn(query, key)) continue;
      const value = query[key] ?? "";
      if (containsLoneSurrogate(key) || containsLoneSurrogate(value)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: "A query name and value must be encodable text",
        });
        return;
      }
      bytes += formUrlencodedLength(key) + formUrlencodedLength(value) + 2;
      if (bytes <= MAX_EGRESS_QUERY_BYTES) continue;
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: `A query may encode to at most ${MAX_EGRESS_QUERY_BYTES} bytes`,
      });
      return;
    }
  });

export const egressFetchRequestSchema = z
  .object({
    capability: z.literal("egress.fetch"),
    destination: destinationIdSchema,
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]),
    path: z
      .string()
      .min(1)
      .max(2048)
      .regex(
        ORIGIN_RELATIVE_PATH_PATTERN,
        "Path must be origin-relative: one leading slash, no scheme, authority, backslash, or fragment",
      ),
    query: egressQuerySchema.optional(),
    /**
     * The broker owns routing, framing, hop-by-hop, and authorization headers,
     * so an App cannot set one. It also refuses a header equal to the
     * destination's declared credential header and injects exactly one
     * host-owned value in its place.
     */
    headers: boundedHeaderRecordSchema(appliedHeaderNameSchema).optional(),
    body: base64BodySchema.optional(),
    timeoutMs: z.number().int().min(100).max(120_000).optional(),
  })
  .strict();

export const egressFetchResultSchema = z
  .object({
    status: z.number().int().min(100).max(599),
    headers: boundedHeaderRecordSchema(z.string().max(128)),
    body: base64BodySchema,
  })
  .strict();

export const documentIngestOutcomeSchema = z.enum(["created", "updated", "unchanged"]);

export const documentIngestResultSchema = z
  .object({
    externalDocumentId: z.string().min(1).max(256),
    outcome: documentIngestOutcomeSchema,
  })
  .strict();

export const documentDeleteResultSchema = z.object({ deleted: z.boolean() }).strict();
export const storageGetResultSchema = z.object({ record: storageRecordSchema.nullable() }).strict();
export const storagePutResultSchema = z.object({ version: storageVersionSchema }).strict();
export const storageDeleteResultSchema = z.object({ deleted: z.boolean() }).strict();

/** The `document_source` contribution a write belongs to, by id. */
const sourceContributionIdField = contributionIdSchema;

export const hostCapabilityRequestSchema = z.discriminatedUnion("capability", [
  z
    .object({
      capability: z.literal("documents.ingest"),
      sourceContributionId: sourceContributionIdField,
      document: documentIngestInputSchema,
    })
    .strict(),
  z
    .object({
      capability: z.literal("documents.delete"),
      sourceContributionId: sourceContributionIdField,
      externalDocumentId: z.string().min(1).max(256),
    })
    .strict(),
  z.object({ capability: z.literal("storage.get"), request: storageGetRequestSchema }).strict(),
  z.object({ capability: z.literal("storage.put"), request: storagePutRequestSchema }).strict(),
  z.object({ capability: z.literal("storage.delete"), request: storageDeleteRequestSchema }).strict(),
  z.object({ capability: z.literal("storage.query"), request: storageQueryRequestSchema }).strict(),
  egressFetchRequestSchema,
]);

/**
 * The envelope every host operation arrives in. It carries the protocol
 * version, the invocation it belongs to, the capability session that authorizes
 * it, and an App-chosen `requestId` that stays the same across retries of one
 * logical effect — which is what lets a deduplicating capability recognise the
 * second delivery as the first.
 */
export const hostCapabilityCallSchema = z
  .object({
    protocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
    invocationId: z.string().uuid(),
    capabilitySession: z.string().min(1).max(4096),
    requestId: z.string().min(1).max(200),
    request: hostCapabilityRequestSchema,
  })
  .strict();

const capabilityResult = <C extends string, R extends z.ZodTypeAny>(capability: C, result: R) =>
  z.object({ ok: z.literal(true), capability: z.literal(capability), result }).strict();

/** A success names its capability, and the capability fixes the result's shape. */
export const hostCapabilitySuccessSchema = z.discriminatedUnion("capability", [
  capabilityResult("documents.ingest", documentIngestResultSchema),
  capabilityResult("documents.delete", documentDeleteResultSchema),
  capabilityResult("storage.get", storageGetResultSchema),
  capabilityResult("storage.put", storagePutResultSchema),
  capabilityResult("storage.delete", storageDeleteResultSchema),
  capabilityResult("storage.query", storageQueryResultSchema),
  capabilityResult("egress.fetch", egressFetchResultSchema),
]);

export const hostCapabilityFailureSchema = z
  .object({ ok: z.literal(false), error: appErrorSchema })
  .strict();

export const hostCapabilityResponseSchema = z.union([
  hostCapabilitySuccessSchema,
  hostCapabilityFailureSchema,
]);

export type AppErrorCode = z.infer<typeof appErrorCodeSchema>;
export type AppError = z.infer<typeof appErrorSchema>;
export type CapabilitySession = z.infer<typeof capabilitySessionSchema>;
export type InstallationContext = z.infer<typeof installationContextSchema>;
export type InvocationInput = z.infer<typeof invocationInputSchema>;
export type InvocationRequest = z.infer<typeof invocationRequestSchema>;
export type InvocationOutcome = z.infer<typeof invocationOutcomeSchema>;
export type InvocationResponse = z.infer<typeof invocationResponseSchema>;
export type InvocationOutput = z.infer<typeof invocationOutputSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type DocumentIngestInput = z.infer<typeof documentIngestInputSchema>;
export type DocumentIngestResult = z.infer<typeof documentIngestResultSchema>;
export type EgressFetchRequest = z.infer<typeof egressFetchRequestSchema>;
export type EgressFetchResult = z.infer<typeof egressFetchResultSchema>;
export type HostCapabilityCall = z.infer<typeof hostCapabilityCallSchema>;
export type HostCapabilityRequest = z.infer<typeof hostCapabilityRequestSchema>;
export type HostCapabilityResponse = z.infer<typeof hostCapabilityResponseSchema>;
