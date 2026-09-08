import { executionClassForContributionKind, type AdmittedManifest } from "@radioso/app-contract";

/**
 * What one contribution is, resolved against the configuration that will run it.
 *
 * A contribution id alone is not enough for anything outside this module to act on: a
 * poll-interval change leaves the id untouched, so a staging implementation handed only
 * ids cannot tell the new projection from the old one, and an invocation gateway handed
 * only ids has to re-read the manifest to learn which slot signs a webhook. This is the
 * whole answer, taken from the admitted manifest and the effective configuration at the
 * same moment, so no consumer reconstructs it from Apps persistence — including the
 * fields an invocation needs: which input and output shapes the handler speaks, which
 * document sources its effects belong to, how a schedule retries, and which keys a
 * document source may index.
 */
export interface AppContributionDescriptor {
  readonly id: string;
  readonly kind: string;
  readonly displayName: string;
  readonly description: string;
  readonly availability: "optional" | "required";
  /** How the host budgets and schedules a run, or `null` for a kind this release cannot run. */
  readonly executionClass: string | null;
  readonly deadlineMs: number;
  /** Which invocation input shape this contribution reads and which output shape it writes. */
  readonly inputSchemaVersion: number;
  readonly outputSchemaVersion: number;
  readonly permissions: readonly string[];
  readonly egressDestinations: readonly string[];
  readonly requiredConnectionSlots: readonly string[];
  /**
   * The document-source contributions whose external-id namespace, indexed-field
   * vocabulary, and provenance a write from this handler belongs to. Empty for a
   * contribution that writes no documents, and always empty for a document source itself.
   */
  readonly documentSources: readonly string[];
  readonly schedule: AppScheduleDescriptor | null;
  readonly webhook: AppWebhookDescriptor | null;
  readonly documentSource: AppDocumentSourceDescriptor | null;
}

interface AppScheduleRetryDescriptor {
  readonly maxAttempts: number;
  readonly backoff: {
    readonly kind: string;
    readonly baseSeconds: number;
    readonly maxSeconds: number;
  };
}

export interface AppScheduleDescriptor {
  /**
   * The interval this configuration actually resolves to, or `null` when the operator set
   * the schedule's disabled value. A caller never re-derives it from raw configuration.
   */
  readonly intervalSeconds: number | null;
  readonly overlapPolicy: string;
  readonly maxDurationSeconds: number;
  readonly retry: AppScheduleRetryDescriptor;
  /** Where a run keeps its resumption cursor, or `null` when it keeps none. */
  readonly checkpointCollection: string | null;
}

/**
 * How a delivery is authenticated. The slot and field *name* the signing key; neither the
 * key nor any part of it appears here, because this descriptor crosses a port.
 */
export interface AppWebhookDescriptor {
  readonly authenticationKind: string;
  readonly secretConnectionSlot: string;
  /** `null` when the slot holds one value, which names the key by naming the slot. */
  readonly secretField: string | null;
  readonly signatureHeader: string;
  readonly signaturePrefix: string | null;
  readonly maxBodyBytes: number;
  readonly replayWindowSeconds: number;
}

/** Who owns the keys a source indexes, said as the manifest declared it. */
type AppIndexedFieldsDescriptor =
  | { readonly policy: "declared"; readonly keys: readonly string[] }
  | { readonly policy: "dynamic"; readonly maxFields: number };

export interface AppDocumentSourceDescriptor {
  readonly externalIdNamespace: string;
  readonly syncModes: readonly string[];
  readonly contentFormats: readonly string[];
  readonly indexedFields: AppIndexedFieldsDescriptor;
  /** Where a backfill keeps its cursor, or `null` when this source declares no backfill. */
  readonly backfill: { readonly checkpointCollection: string } | null;
}

type Contribution = AdmittedManifest["contributions"][number];

const scheduleOf = (
  contribution: Contribution,
  configuration: Readonly<Record<string, unknown>>,
): AppScheduleDescriptor | null => {
  if (contribution.kind !== "scheduled_task") return null;
  const { schedule } = contribution;
  const value = schedule.kind === "interval"
    ? schedule.seconds
    : configuration[schedule.field];
  const disabled = schedule.kind === "interval_from_configuration"
    && schedule.disabledValue !== undefined
    && value === schedule.disabledValue;
  return {
    intervalSeconds: disabled || typeof value !== "number" ? null : value,
    overlapPolicy: contribution.overlapPolicy,
    maxDurationSeconds: contribution.maxDurationSeconds,
    retry: {
      maxAttempts: contribution.retry.maxAttempts,
      backoff: {
        kind: contribution.retry.backoff.kind,
        baseSeconds: contribution.retry.backoff.baseSeconds,
        maxSeconds: contribution.retry.backoff.maxSeconds,
      },
    },
    checkpointCollection: contribution.checkpointCollection ?? null,
  };
};

const webhookOf = (contribution: Contribution): AppWebhookDescriptor | null => {
  if (contribution.kind !== "external_webhook_handler") return null;
  return {
    authenticationKind: contribution.authentication.kind,
    secretConnectionSlot: contribution.authentication.secretConnectionSlot,
    secretField: contribution.authentication.secretField ?? null,
    signatureHeader: contribution.authentication.signatureHeader,
    signaturePrefix: contribution.authentication.signaturePrefix ?? null,
    maxBodyBytes: contribution.maxBodyBytes,
    replayWindowSeconds: contribution.replayWindowSeconds,
  };
};

const documentSourceOf = (contribution: Contribution): AppDocumentSourceDescriptor | null => {
  if (contribution.kind !== "document_source") return null;
  return {
    externalIdNamespace: contribution.externalIdNamespace,
    syncModes: [...contribution.syncModes],
    contentFormats: [...contribution.contentFormats],
    indexedFields: contribution.indexedFields.policy === "declared"
      ? { policy: "declared", keys: [...contribution.indexedFields.keys] }
      : { policy: "dynamic", maxFields: contribution.indexedFields.maxFields },
    backfill: contribution.backfill ? { checkpointCollection: contribution.backfill.checkpointCollection } : null,
  };
};

const documentSourcesOf = (contribution: Contribution): readonly string[] =>
  contribution.kind === "external_webhook_handler" || contribution.kind === "scheduled_task"
    ? [...contribution.documentSources]
    : [];

const appContributionDescriptor = (
  contribution: Contribution,
  configuration: Readonly<Record<string, unknown>>,
): AppContributionDescriptor => ({
  id: contribution.id,
  kind: contribution.kind,
  displayName: contribution.displayName,
  description: contribution.description,
  availability: contribution.availability,
  executionClass: executionClassForContributionKind(contribution.kind),
  deadlineMs: contribution.deadlineMs,
  inputSchemaVersion: contribution.inputSchemaVersion,
  outputSchemaVersion: contribution.outputSchemaVersion,
  permissions: [...contribution.permissions],
  egressDestinations: [...contribution.egressDestinations],
  requiredConnectionSlots: [...contribution.requiredConnectionSlots],
  documentSources: documentSourcesOf(contribution),
  schedule: scheduleOf(contribution, configuration),
  webhook: webhookOf(contribution),
  documentSource: documentSourceOf(contribution),
});

/** The descriptors for the named contributions, in the manifest's own order. */
export const appContributionDescriptors = (
  manifest: AdmittedManifest,
  configuration: Readonly<Record<string, unknown>>,
  contributionIds: readonly string[],
): readonly AppContributionDescriptor[] => {
  const wanted = new Set(contributionIds);
  return manifest.contributions
    .filter((contribution) => wanted.has(contribution.id))
    .map((contribution) => appContributionDescriptor(contribution, configuration));
};

export const findAppContributionDescriptor = (
  manifest: AdmittedManifest,
  configuration: Readonly<Record<string, unknown>>,
  contributionId: string,
): AppContributionDescriptor | null => {
  const contribution = manifest.contributions.find((candidate) => candidate.id === contributionId);
  return contribution ? appContributionDescriptor(contribution, configuration) : null;
};
