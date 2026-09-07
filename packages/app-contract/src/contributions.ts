import { z } from "zod";

import { MAX_BASE64_DECODED_BYTES } from "./bounds.js";

import {
  collectionIdSchema,
  contributionIdSchema,
  connectionSlotIdSchema,
  descriptionSchema,
  destinationIdSchema,
  displayNameSchema,
  fieldKeySchema,
  httpHeaderNameSchema,
  indexedFieldKeySchema,
  schemaVersionSchema,
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

/**
 * A delivery reaches the App base64-encoded inside the invocation input, so the
 * largest body a handler may declare is the largest body the protocol carries.
 * Declaring more would admit a manifest whose deliveries the wire then refuses.
 */
const MAX_WEBHOOK_BODY_BYTES = MAX_BASE64_DECODED_BYTES;
export const MAX_INDEXED_FIELDS = 64;

const requiredConnectionSlotsField = z
  .array(connectionSlotIdSchema)
  .max(16)
  .refine(
    (slots) => new Set(slots).size === slots.length,
    "A contribution names a connection slot at most once",
  )
  .default([]);

const contributionHeader = {
  id: contributionIdSchema,
  displayName: displayNameSchema,
  description: descriptionSchema,
  permissions: z.array(hostPermissionSchema).max(hostPermissions.length).default([]),
  egressDestinations: z.array(destinationIdSchema).max(8).default([]),
  deadlineMs: z.number().int().min(1000).max(900_000),
  availability: z.enum(["optional", "required"]),
  /** Which input shape this contribution reads and which output shape it writes. */
  inputSchemaVersion: schemaVersionSchema,
  outputSchemaVersion: schemaVersionSchema,
  /**
   * Slots this contribution cannot run without. A connection is required for an
   * installation only when a contribution that names it is active, which is what
   * separates "this App can poll" from "this operator has to enter credentials
   * to install it at all". Field-level `required` still means mandatory once the
   * slot is bound.
   */
  requiredConnectionSlots: requiredConnectionSlotsField,
};

/**
 * Who owns the keys a source indexes. `declared` names them, so the host can
 * refuse anything else. `dynamic` says the synced system owns the vocabulary —
 * a WooCommerce catalogue, a CRM's custom fields — and bounds how many keys one
 * document may carry. An empty `declared` list means none, and it means that
 * only because the policy says so.
 */
export const indexedFieldsPolicySchema = z.discriminatedUnion("policy", [
  z
    .object({
      policy: z.literal("declared"),
      keys: z.array(indexedFieldKeySchema).max(MAX_INDEXED_FIELDS),
    })
    .strict(),
  z
    .object({
      policy: z.literal("dynamic"),
      maxFields: z.number().int().min(1).max(MAX_INDEXED_FIELDS),
    })
    .strict(),
]);

export const documentSourceContributionSchema = z
  .object({
    ...contributionHeader,
    kind: z.literal("document_source"),
    externalIdNamespace: fieldKeySchema,
    syncModes: z.array(z.enum(["push", "poll", "backfill"])).min(1).max(3),
    contentFormats: z.array(z.enum(["html", "markdown", "text"])).min(1).max(3),
    indexedFields: indexedFieldsPolicySchema,
    backfill: z.object({ checkpointCollection: collectionIdSchema }).strict().optional(),
  })
  .strict();

/**
 * A handler that writes documents names the sources it writes through, so the
 * host knows whose external-id namespace, indexed-field vocabulary, and
 * provenance an effect belongs to before it lands.
 */
const documentSourcesField = z.array(contributionIdSchema).max(8).default([]);

export const externalWebhookHandlerContributionSchema = z
  .object({
    ...contributionHeader,
    kind: z.literal("external_webhook_handler"),
    documentSources: documentSourcesField,
    /**
     * A `generated_secret` slot holds one value, so naming the slot names the
     * key. A `secret_fields` slot holds several, and a gateway that had to pick
     * one would be reading an App's field naming as a convention — so the
     * manifest says which field carries the signing key.
     */
    authentication: z
      .object({
        kind: z.literal("hmac_sha256"),
        secretConnectionSlot: connectionSlotIdSchema,
        secretField: fieldKeySchema.optional(),
        signatureHeader: httpHeaderNameSchema,
        signaturePrefix: z.string().min(1).max(32).optional(),
      })
      .strict(),
    maxBodyBytes: z.number().int().min(1).max(MAX_WEBHOOK_BODY_BYTES),
    replayWindowSeconds: z.number().int().min(1).max(3600),
  })
  .strict();

/** The longest interval a configuration-driven schedule may declare: 30 days. */
export const MAX_SCHEDULE_INTERVAL_SECONDS = 2_592_000;

export const scheduleSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("interval"), seconds: z.number().int().min(60).max(86_400) }).strict(),
    z
      .object({
        kind: z.literal("interval_from_configuration"),
        field: fieldKeySchema,
        /**
         * The interval an operator may pick is a closed range, not a floor with
         * nothing above it. Without a ceiling the schedule's value space is
         * "any number at all", and a host cannot say whether a stored value
         * runs this task, disables it, or means nothing.
         */
        minSeconds: z.number().int().min(60).max(MAX_SCHEDULE_INTERVAL_SECONDS),
        maxSeconds: z.number().int().min(60).max(MAX_SCHEDULE_INTERVAL_SECONDS),
        /**
         * The value that means "do not run this at all". It sits below the
         * interval floor — 0 is not a one-second poll — so an operator who
         * leaves a push-only installation alone never starts a schedule, and an
         * operator who picks a valid interval never silently stops one.
         */
        disabledValue: z.number().int().min(0).max(MAX_SCHEDULE_INTERVAL_SECONDS).optional(),
      })
      .strict(),
  ])
  .superRefine((schedule, context) => {
    if (schedule.kind !== "interval_from_configuration") return;
    if (schedule.maxSeconds < schedule.minSeconds) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxSeconds"],
        message: "An interval ceiling must be at least its floor",
      });
    }
    if (schedule.disabledValue === undefined || schedule.disabledValue < schedule.minSeconds) return;
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["disabledValue"],
      message: "A disabled value must sit below the interval floor, or it would disable a valid interval",
    });
  });

export const scheduledTaskContributionSchema = z
  .object({
    ...contributionHeader,
    kind: z.literal("scheduled_task"),
    documentSources: documentSourcesField,
    schedule: scheduleSchema,
    overlapPolicy: z.enum(["skip", "queue", "replace"]),
    maxDurationSeconds: z.number().int().min(1).max(3600),
    retry: z
      .object({
        maxAttempts: z.number().int().min(1).max(10),
        backoff: z
          .object({
            kind: z.literal("exponential"),
            baseSeconds: z.number().int().min(1).max(3600),
            maxSeconds: z.number().int().min(1).max(86_400),
          })
          .strict()
          .refine((backoff) => backoff.maxSeconds >= backoff.baseSeconds, {
            message: "Backoff ceiling must be at least the base delay",
            path: ["maxSeconds"],
          }),
      })
      .strict(),
    checkpointCollection: collectionIdSchema.optional(),
  })
  .strict();

/**
 * A reserved kind parses down to its header and keeps the rest of its keys
 * unread. Passthrough rather than strict is the point: a manifest written
 * against a later release still reads here and gets one clear
 * `unsupported_contribution_kind` from admission instead of a wall of unknown-key
 * noise about a declaration this host was never going to run.
 */
const reservedContribution = <K extends (typeof reservedContributionKinds)[number]>(kind: K) =>
  z.object({ ...contributionHeader, kind: z.literal(kind) }).passthrough();

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
export type IndexedFieldsPolicy = z.infer<typeof indexedFieldsPolicySchema>;
export type DocumentSourceContribution = z.infer<typeof documentSourceContributionSchema>;
export type ExternalWebhookHandlerContribution = z.infer<typeof externalWebhookHandlerContributionSchema>;
export type ScheduledTaskContribution = z.infer<typeof scheduledTaskContributionSchema>;
/** The schedule arm whose interval an operator supplies through configuration. */
export type ConfigurationSchedule = Extract<
  ScheduledTaskContribution["schedule"],
  { kind: "interval_from_configuration" }
>;

/**
 * The whole value space a configuration-driven schedule has: the sentinel that
 * turns it off, or a whole number of seconds inside the declared range. One
 * predicate, because admission asks it of a manifest's default and resolution
 * asks it of an operator's stored value — and a manifest whose default the host
 * would then refuse is a manifest that never should have been admitted.
 */
export const satisfiesSchedule = (schedule: ConfigurationSchedule, value: number): boolean => {
  if (schedule.disabledValue !== undefined && value === schedule.disabledValue) return true;
  return Number.isInteger(value) && value >= schedule.minSeconds && value <= schedule.maxSeconds;
};
