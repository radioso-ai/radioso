import { z } from "zod";

import {
  collectionIdSchema,
  contributionIdSchema,
  connectionSlotIdSchema,
  descriptionSchema,
  destinationIdSchema,
  displayNameSchema,
  fieldKeySchema,
} from "./identifiers.js";

/** Host capabilities an App may hold a grant for. */
export const hostPermissions = [
  "documents.ingest",
  "documents.delete",
  "storage.read",
  "storage.write",
  "egress.fetch",
] as const;
export const hostPermissionSchema = z.enum(hostPermissions);

/** How the host budgets and schedules a run. */
export const executionClasses = ["external_webhook", "scheduled_task"] as const;
export const executionClassSchema = z.enum(executionClasses);

export const releaseAContributionKinds = [
  "document_source",
  "external_webhook_handler",
  "scheduled_task",
] as const;

/** Declared so a manifest that uses one reads clearly; admission still refuses it. */
export const reservedContributionKinds = [
  "tool",
  "context_provider",
  "event_subscription",
  "ui",
  "pack",
] as const;

export const contributionKinds = [...releaseAContributionKinds, ...reservedContributionKinds] as const;
export const contributionKindSchema = z.enum(contributionKinds);

const HTTP_HEADER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u;
const MAX_WEBHOOK_BODY_BYTES = 8 * 1024 * 1024;

const contributionHeader = {
  id: contributionIdSchema,
  displayName: displayNameSchema,
  description: descriptionSchema,
  permissions: z.array(hostPermissionSchema).max(hostPermissions.length).default([]),
  egressDestinations: z.array(destinationIdSchema).max(8).default([]),
  deadlineMs: z.number().int().min(1000).max(900_000),
  availability: z.enum(["optional", "required"]),
};

export const documentSourceContributionSchema = z.object({
  ...contributionHeader,
  kind: z.literal("document_source"),
  externalIdNamespace: fieldKeySchema,
  syncModes: z.array(z.enum(["push", "poll", "backfill"])).min(1).max(3),
  contentFormats: z.array(z.enum(["html", "markdown", "text"])).min(1).max(3),
  indexedFieldKeys: z.array(fieldKeySchema).max(32).default([]),
  backfill: z.object({ checkpointCollection: collectionIdSchema }).optional(),
});

export const externalWebhookHandlerContributionSchema = z.object({
  ...contributionHeader,
  kind: z.literal("external_webhook_handler"),
  authentication: z.object({
    kind: z.literal("hmac_sha256"),
    secretConnectionSlot: connectionSlotIdSchema,
    signatureHeader: z.string().regex(HTTP_HEADER_PATTERN),
    signaturePrefix: z.string().min(1).max(32).optional(),
  }),
  maxBodyBytes: z.number().int().min(1).max(MAX_WEBHOOK_BODY_BYTES),
  replayWindowSeconds: z.number().int().min(1).max(3600),
});

export const scheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("interval"), seconds: z.number().int().min(60).max(86_400) }),
  z.object({
    kind: z.literal("interval_from_configuration"),
    field: fieldKeySchema,
    minSeconds: z.number().int().min(60).max(86_400),
  }),
]);

export const scheduledTaskContributionSchema = z.object({
  ...contributionHeader,
  kind: z.literal("scheduled_task"),
  schedule: scheduleSchema,
  overlapPolicy: z.enum(["skip", "queue", "replace"]),
  maxDurationSeconds: z.number().int().min(1).max(3600),
  retry: z.object({
    maxAttempts: z.number().int().min(1).max(10),
    backoff: z
      .object({
        kind: z.literal("exponential"),
        baseSeconds: z.number().int().min(1).max(3600),
        maxSeconds: z.number().int().min(1).max(86_400),
      })
      .refine((backoff) => backoff.maxSeconds >= backoff.baseSeconds, {
        message: "Backoff ceiling must be at least the base delay",
        path: ["maxSeconds"],
      }),
  }),
  checkpointCollection: collectionIdSchema.optional(),
});

/**
 * A reserved kind parses down to its header. The rest of the declaration is not
 * interpreted, so a manifest written against a later release still reads here
 * and gets one clear admission failure instead of a wall of schema noise.
 */
const reservedContribution = <K extends (typeof reservedContributionKinds)[number]>(kind: K) =>
  z.object({ ...contributionHeader, kind: z.literal(kind) });

export const contributionSchema = z.discriminatedUnion("kind", [
  documentSourceContributionSchema,
  externalWebhookHandlerContributionSchema,
  scheduledTaskContributionSchema,
  reservedContribution("tool"),
  reservedContribution("context_provider"),
  reservedContribution("event_subscription"),
  reservedContribution("ui"),
  reservedContribution("pack"),
]);

const EXECUTION_CLASS_BY_KIND: Readonly<Partial<Record<ContributionKind, ExecutionClass>>> = {
  document_source: "scheduled_task",
  external_webhook_handler: "external_webhook",
  scheduled_task: "scheduled_task",
};

/** Reserved kinds have no execution class until the release that defines them. */
export const executionClassForContributionKind = (kind: ContributionKind): ExecutionClass | null =>
  EXECUTION_CLASS_BY_KIND[kind] ?? null;

export type HostPermission = z.infer<typeof hostPermissionSchema>;
export type ExecutionClass = z.infer<typeof executionClassSchema>;
export type ContributionKind = z.infer<typeof contributionKindSchema>;
export type Contribution = z.infer<typeof contributionSchema>;
export type DocumentSourceContribution = z.infer<typeof documentSourceContributionSchema>;
export type ExternalWebhookHandlerContribution = z.infer<typeof externalWebhookHandlerContributionSchema>;
export type ScheduledTaskContribution = z.infer<typeof scheduledTaskContributionSchema>;
