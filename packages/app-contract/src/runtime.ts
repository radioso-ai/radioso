import { z } from "zod";

import { executionClassSchema } from "./contributions.js";
import {
  contributionIdSchema,
  destinationIdSchema,
  fieldKeySchema,
  timestampSchema,
} from "./identifiers.js";
import {
  jsonRecordSchema,
  storageDeleteRequestSchema,
  storageGetRequestSchema,
  storagePutRequestSchema,
  storageQueryRequestSchema,
  storageScalarValueSchema,
} from "./storage.js";

export const RUNTIME_PROTOCOL_VERSION = 1;

/**
 * Errors travel as a code plus a short sentence. The bound is the point: an App
 * cannot use an error to smuggle a payload back through the host's logs.
 */
export const MAX_ERROR_MESSAGE_LENGTH = 512;

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

export const appErrorSchema = z.object({
  code: appErrorCodeSchema,
  message: z.string().min(1).max(MAX_ERROR_MESSAGE_LENGTH),
});

const HTTP_HEADER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u;

export const base64BodySchema = z.object({
  encoding: z.literal("base64"),
  data: z.string().max(12_000_000),
});

export const webhookInvocationInputSchema = z.object({
  kind: z.literal("webhook"),
  deliveryId: z.string().min(1).max(200),
  receivedAt: timestampSchema,
  headers: z.record(z.string().regex(HTTP_HEADER_PATTERN), z.string().max(8192)),
  body: base64BodySchema,
});

export const scheduledInvocationInputSchema = z.object({
  kind: z.literal("scheduled"),
  occurrenceId: z.string().min(1).max(200),
  scheduledFor: timestampSchema,
  checkpoint: jsonRecordSchema.optional(),
});

export const backfillInvocationInputSchema = z.object({
  kind: z.literal("backfill"),
  requestId: z.string().min(1).max(200),
  checkpoint: jsonRecordSchema.optional(),
});

export const invocationInputSchema = z.discriminatedUnion("kind", [
  webhookInvocationInputSchema,
  scheduledInvocationInputSchema,
  backfillInvocationInputSchema,
]);

/** Short-lived proof of who is calling, minted per invocation by the host. */
export const invocationIdentitySchema = z.object({
  token: z.string().min(1).max(4096),
  expiresAt: timestampSchema,
});

export const invocationRequestSchema = z.object({
  protocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
  invocationId: z.string().uuid(),
  installationId: z.string().uuid(),
  contributionId: contributionIdSchema,
  executionClass: executionClassSchema,
  attempt: z.number().int().min(1).max(100),
  idempotencyKey: z.string().min(1).max(200),
  deadlineAt: timestampSchema,
  identity: invocationIdentitySchema,
  input: invocationInputSchema,
});

export const invocationOutcomes = ["completed", "failed", "retry"] as const;
export const invocationOutcomeSchema = z.enum(invocationOutcomes);

export const invocationOutputSchema = z.object({
  checkpoint: jsonRecordSchema.optional(),
  counts: z
    .object({
      ingested: z.number().int().min(0),
      deleted: z.number().int().min(0),
      skipped: z.number().int().min(0),
    })
    .optional(),
});

export const invocationResponseSchema = z
  .object({
    protocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
    invocationId: z.string().uuid(),
    outcome: invocationOutcomeSchema,
    output: invocationOutputSchema.optional(),
    error: appErrorSchema.optional(),
    retryAfterSeconds: z.number().int().min(0).max(86_400).optional(),
  })
  .superRefine((response, context) => {
    if (response.outcome !== "completed" && !response.error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "A response that did not complete must say why",
      });
    }
  });

export const documentContentFormatSchema = z.enum(["html", "markdown", "text"]);

export const documentIngestInputSchema = z.object({
  externalDocumentId: z.string().min(1).max(256),
  title: z.string().min(1).max(512),
  content: z.object({
    format: documentContentFormatSchema,
    value: z.string().max(4_000_000),
  }),
  sourceUrl: z.string().url().max(2048).optional(),
  indexedFields: z.record(fieldKeySchema, storageScalarValueSchema).optional(),
});

export const egressFetchRequestSchema = z.object({
  capability: z.literal("egress.fetch"),
  destination: destinationIdSchema,
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]),
  path: z.string().min(1).max(2048),
  query: z.record(z.string().max(128), z.string().max(2048)).optional(),
  headers: z.record(z.string().regex(HTTP_HEADER_PATTERN), z.string().max(8192)).optional(),
  body: base64BodySchema.optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
});

export const egressFetchResultSchema = z.object({
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string().max(128), z.string().max(8192)),
  body: base64BodySchema,
});

export const hostCapabilityRequestSchema = z.discriminatedUnion("capability", [
  z.object({ capability: z.literal("documents.ingest"), document: documentIngestInputSchema }),
  z.object({ capability: z.literal("documents.delete"), externalDocumentId: z.string().min(1).max(256) }),
  z.object({ capability: z.literal("storage.get"), request: storageGetRequestSchema }),
  z.object({ capability: z.literal("storage.put"), request: storagePutRequestSchema }),
  z.object({ capability: z.literal("storage.delete"), request: storageDeleteRequestSchema }),
  z.object({ capability: z.literal("storage.query"), request: storageQueryRequestSchema }),
  egressFetchRequestSchema,
]);

export const hostCapabilityResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: appErrorSchema }),
]);

export type AppErrorCode = z.infer<typeof appErrorCodeSchema>;
export type AppError = z.infer<typeof appErrorSchema>;
export type InvocationInput = z.infer<typeof invocationInputSchema>;
export type InvocationRequest = z.infer<typeof invocationRequestSchema>;
export type InvocationOutcome = z.infer<typeof invocationOutcomeSchema>;
export type InvocationResponse = z.infer<typeof invocationResponseSchema>;
export type DocumentIngestInput = z.infer<typeof documentIngestInputSchema>;
export type EgressFetchRequest = z.infer<typeof egressFetchRequestSchema>;
export type EgressFetchResult = z.infer<typeof egressFetchResultSchema>;
export type HostCapabilityRequest = z.infer<typeof hostCapabilityRequestSchema>;
export type HostCapabilityResponse = z.infer<typeof hostCapabilityResponseSchema>;
