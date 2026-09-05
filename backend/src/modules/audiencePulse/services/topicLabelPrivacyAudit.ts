import type { TelemetryService } from "../../../shared/observability/telemetry/telemetryService.js";
import type {
  ModelCallIssuedReporter,
  TopicLabel,
  TopicLabelPrivacyAuditPort,
  TopicNamingExemplars,
  TopicNamingPort,
} from "../contracts/topicLabel.js";

export interface ResolveAuditedTopicLabelInput {
  workspaceId: string;
  /** The cluster/topic identifier the label is for -- an id, never label text. */
  topicId: string;
  /** The label a naming call already produced for this cluster. */
  candidate: TopicLabel;
  /** The same exemplars the candidate was named from, reused if it must be regenerated. */
  exemplars: TopicNamingExemplars;
  namingPort: TopicNamingPort;
  privacyAuditPort: TopicLabelPrivacyAuditPort;
  telemetryService?: Pick<TelemetryService, "emit">;
  signal?: AbortSignal;
  onModelCallIssued?: ModelCallIssuedReporter;
}

/**
 * The privacy audit pass (T021a): Clio runs this as a distinct fourth layer, after
 * summarizing, thresholding, and naming, and this design lacked it until now. The
 * facet prompt already strips identifying detail from one question; this guards a
 * different failure surface -- a label synthesized from a sample of facets across a
 * whole cluster, which can recombine detail that no single source facet carried.
 *
 * A flagged label is regenerated once from the same exemplars. If the regeneration
 * is also flagged, the topic renders with a neutral fallback that carries no
 * cluster-specific content, and the rejection is counted in observability -- never
 * logged with the rejected text, which would defeat the point of rejecting it.
 */
export const resolveAuditedTopicLabel = async (
  input: ResolveAuditedTopicLabelInput,
): Promise<TopicLabel> => {
  const firstReview = await input.privacyAuditPort.review(
    input.candidate,
    input.signal,
    input.onModelCallIssued,
  );
  if (!firstReview.flagged) {
    return input.candidate;
  }

  const regenerated = await input.namingPort.name(input.exemplars, input.signal, input.onModelCallIssued);
  const secondReview = await input.privacyAuditPort.review(regenerated, input.signal, input.onModelCallIssued);
  if (!secondReview.flagged) {
    return regenerated;
  }

  await input.telemetryService?.emit({
    eventType: "audience_pulse.topic_label_privacy_rejected",
    severity: "warn",
    correlation: { workspaceId: input.workspaceId },
    tags: { topicId: input.topicId },
    metrics: { rejectionCount: 1 },
  }).catch(() => undefined);

  return input.namingPort.nameFallback(input.signal, input.onModelCallIssued);
};
