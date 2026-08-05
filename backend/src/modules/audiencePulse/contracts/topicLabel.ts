/**
 * Ports for turning one cluster's exemplar facets into an operator-visible label, and
 * for reviewing that label for identifying detail before it is stored. Implementations
 * (an LLM-backed adapter for naming, a second for the privacy audit) live outside this
 * module; `services/topicLabelPrivacyAudit.ts` orchestrates both against these ports
 * without knowing which provider or model answers them.
 */

import type { TopicLabel } from "../domain/topicLabel.js";
import type { TopicLabelPrivacyAuditResult } from "../domain/topicLabelPrivacyAudit.js";

export type { TopicLabel } from "../domain/topicLabel.js";
export type { TopicLabelPrivacyAuditResult } from "../domain/topicLabelPrivacyAudit.js";

/**
 * Exemplar facet texts for one cluster, drawn from two places: `prototypical` sits
 * nearest the cluster centroid and shows what the topic is about; `peripheral` sits
 * toward the cluster's edge and shows how wide the topic is. Selecting which facets
 * fall into each group is the caller's job -- a distance computation over a cluster
 * `@radioso/census` already produced -- so this port only ever names what it is handed.
 */
export interface TopicNamingExemplars {
  readonly prototypical: readonly string[];
  readonly peripheral: readonly string[];
}

/**
 * Names one cluster. `name` never partitions or reassigns membership: the caller
 * decides cluster contents before calling this port, and the response shape it
 * returns (`TopicLabel`) has no field that could express a membership change.
 * `nameFallback` produces a neutral, non-identifying label with no cluster-specific
 * input, used only when a label fails privacy review twice.
 */
export interface TopicNamingPort {
  name(exemplars: TopicNamingExemplars, signal?: AbortSignal): Promise<TopicLabel>;
  nameFallback(signal?: AbortSignal): Promise<TopicLabel>;
}

/**
 * Reviews a generated topic label for identifying detail before it reaches an
 * operator: a private individual named as the subject of a personal situation, an
 * email, a phone number, an address, or an order or booking reference. This guards a
 * different failure surface than facet extraction does -- a label is synthesized from
 * several facets at once and can recombine detail that no single source facet
 * carried.
 */
export interface TopicLabelPrivacyAuditPort {
  review(label: TopicLabel, signal?: AbortSignal): Promise<TopicLabelPrivacyAuditResult>;
}
