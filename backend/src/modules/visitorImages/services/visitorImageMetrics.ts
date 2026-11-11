import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import type { VisitorImageRejection } from "../domain.js";

export type VisitorImageMetricsSink = Pick<MetricsRegistry, "incrementCounter">;

/** How an upload ended. Closed: no workspace, agent, owner or file name ever becomes a label. */
type VisitorImageUploadOutcome =
  | "accepted"
  | "rejected_type"
  | "rejected_size"
  | "rejected_pixels"
  | "rate_limited"
  | "busy"
  | "disabled";

const REJECTION_OUTCOME: Readonly<Record<VisitorImageRejection, VisitorImageUploadOutcome>> = {
  unsupported_type: "rejected_type",
  too_large: "rejected_size",
  too_many_pixels: "rejected_pixels",
  busy: "busy",
};

export const uploadOutcomeForRejection = (reason: VisitorImageRejection): VisitorImageUploadOutcome => REJECTION_OUTCOME[reason];

export const recordVisitorImageUpload = (metrics: VisitorImageMetricsSink | null | undefined, outcome: VisitorImageUploadOutcome): void => {
  metrics?.incrementCounter("visitor_image_uploads_total", {
    help: "Photo uploads to a chat, by outcome: accepted, rejected for type, raw size or pixels, rate limited, refused while the process decodes its limit of photos, or refused because the agent takes no photos",
    labels: { outcome },
  });
};

export const recordVisitorImageReading = (metrics: VisitorImageMetricsSink | null | undefined, outcome: "read" | "unread"): void => {
  metrics?.incrementCounter("visitor_image_readings_total", {
    help: "Readings of uploaded photos by the agent's chat model, by outcome; unread photos reach the turn marked as unread",
    labels: { outcome },
  });
};
