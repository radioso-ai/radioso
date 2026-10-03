import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import type { EmailChannelLogger } from "./emailChannelAudit.js";

export type EmailChannelDrainStage = "inbound" | "review" | "reconcile" | "all";

/**
 * A hint that email-channel work is due (research B7): after the webhook commits, and at a retry
 * or review due time. Only a hint; the channel's tables stay authoritative, so a duplicate or a
 * lost one is harmless.
 */
export interface EmailChannelDrainRequest {
  maxJobs: number;
  stage: EmailChannelDrainStage;
  /** Deliver no earlier than this. */
  scheduleAt?: Date;
}

export interface EmailChannelDrainDispatcherPort {
  requestDrain(request: EmailChannelDrainRequest): Promise<void>;
}

/** Where no push transport is configured, the worker's interval loop finds due work by itself. */
export class NoopEmailChannelDrainDispatcher implements EmailChannelDrainDispatcherPort {
  async requestDrain(): Promise<void> {}
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

/**
 * Pushes a drain without failing the caller: the work it points at is already durable, and the
 * sweep recovers a hint that never arrives. Counted always, logged only when it fails.
 */
export const requestDrainBestEffort = async (
  deps: {
    drains: EmailChannelDrainDispatcherPort;
    metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
    logger: EmailChannelLogger;
  },
  request: EmailChannelDrainRequest,
): Promise<void> => {
  const labels = { stage: request.stage, scheduled: String(request.scheduleAt !== undefined) };
  try {
    await deps.drains.requestDrain(request);
    deps.metrics?.incrementCounter("email_drain_requests_total", {
      help: "Email channel drain pushes by stage, scheduling and result.",
      labels: { ...labels, result: "ok" },
    });
  } catch (error) {
    deps.metrics?.incrementCounter("email_drain_requests_total", {
      help: "Email channel drain pushes by stage, scheduling and result.",
      labels: { ...labels, result: "failed" },
    });
    deps.logger.warn({ ...labels, errorName: errorName(error) }, "email_channel_drain_push_failed");
  }
};
