import type { ConnectorLogger } from "@radioso/connector-api";
import { Router, type Request, type Response } from "express";

import {
  requestDrainBestEffort,
  type EmailChannelDrainDispatcherPort,
  type EmailInboundRepository,
} from "../../../emailChannel/public.js";
import type { InboundEmailReceiver, InboundVerification, VerifiedInboundEvent } from "../../../mail/public.js";
import type { MetricsRegistry } from "../../../../shared/observability/metrics/metricsRegistry.js";
import { traceOperation } from "../../../../shared/observability/tracing/operations.js";

/**
 * The inbound provider webhook (FR-007). Inline it only verifies the signature over the raw
 * body, persists the event (the processing obligation) in one idempotent insert, and pushes a
 * best-effort drain. Fetching, routing and ingest belong to the worker's job. Bodies, addresses
 * and subjects are never logged.
 */

export interface EmailWebhookRouterOptions {
  receiver: Pick<InboundEmailReceiver, "provider" | "verify">;
  events: Pick<EmailInboundRepository, "insertEvent">;
  drains: EmailChannelDrainDispatcherPort;
  metrics?: Pick<MetricsRegistry, "incrementCounter" | "observeHistogram"> | null;
  logger: ConnectorLogger;
  clock?: () => Date;
}

type WebhookResult = "persisted" | "duplicate" | "bad_signature" | "stale_timestamp" | "malformed" | "db_unavailable";

interface WebhookRequest extends Request {
  rawBody?: Buffer;
}

/** Events one webhook's drain push asks the worker to claim. */
const DRAIN_BATCH = 5;
const ACK_SECONDS_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5];

const REJECTION: Readonly<Record<Exclude<InboundVerification, { ok: true }>["reason"], { status: number; result: WebhookResult }>> = {
  missing_signature: { status: 401, result: "bad_signature" },
  bad_signature: { status: 401, result: "bad_signature" },
  stale_timestamp: { status: 401, result: "stale_timestamp" },
  malformed_payload: { status: 400, result: "malformed" },
};

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

const headersOf = (req: Request): Record<string, string | undefined> =>
  Object.fromEntries(Object.entries(req.headers).map(([name, value]) => [name, Array.isArray(value) ? value[0] : value]));

/** The row the webhook writes: ids and the verified metadata only, never the message content. */
const eventRowOf = (provider: string, event: VerifiedInboundEvent): Parameters<EmailInboundRepository["insertEvent"]>[0] => {
  switch (event.kind) {
    case "message_received":
      return { provider, providerEventId: event.providerEventId, eventKind: event.kind, providerObjectId: event.providerObjectId, envelope: event.envelope };
    case "delivery_status":
      return { provider, providerEventId: event.providerEventId, eventKind: event.kind, providerObjectId: event.providerObjectId, envelope: { status: event.status } };
    case "domain_status":
      return { provider, providerEventId: event.providerEventId, eventKind: event.kind, providerObjectId: event.providerObjectId, envelope: {} };
    case "unsupported":
      return { provider, providerEventId: event.providerEventId, eventKind: event.kind, providerObjectId: null, envelope: { providerType: event.providerType } };
  }
};

export const createEmailWebhookRouter = (options: EmailWebhookRouterOptions): Router => {
  const router = Router();
  const clock = options.clock ?? (() => new Date());
  const provider = options.receiver.provider;

  const respond = (res: Response, startedAt: number, outcome: { status: number; result: WebhookResult; kind: string }) => {
    options.metrics?.incrementCounter("email_webhook_requests_total", {
      help: "Email webhook requests by result and event kind.",
      labels: { result: outcome.result, kind: outcome.kind },
    });
    options.metrics?.observeHistogram("email_webhook_ack_seconds", {
      help: "Seconds the email webhook took to acknowledge.",
      labels: { result: outcome.result },
      value: (performance.now() - startedAt) / 1000,
      buckets: ACK_SECONDS_BUCKETS,
    });
    res.sendStatus(outcome.status);
  };

  router.post("/webhook", async (req: WebhookRequest, res) => {
    const startedAt = performance.now();
    const rawBody = req.rawBody;
    if (!rawBody) {
      respond(res, startedAt, { status: 400, result: "malformed", kind: "unknown" });
      return;
    }

    const verification = await traceOperation({
      name: "email.webhook.verify",
      attributes: { "radioso.email.provider": provider },
      run: () => options.receiver.verify({ rawBody, headers: headersOf(req), now: clock() }),
      resultAttributes: (verified) => ({ result: verified.ok ? "verified" : verified.reason }),
    });
    if (!verification.ok) {
      const rejection = REJECTION[verification.reason];
      options.logger.warn({ event: "email_webhook_rejected", provider, reason: verification.reason }, "Email webhook rejected");
      respond(res, startedAt, { ...rejection, kind: "unknown" });
      return;
    }

    const event = verification.event;
    let persisted: { eventId: string; duplicate: boolean };
    try {
      persisted = await traceOperation({
        name: "email.webhook.persist",
        attributes: { "radioso.email.event_kind": event.kind },
        run: () => options.events.insertEvent(eventRowOf(provider, event)),
        resultAttributes: (inserted) => ({ duplicate: inserted.duplicate }),
      });
    } catch (error) {
      options.logger.error(
        { event: "email_webhook_persist_failed", provider, kind: event.kind, errorName: errorName(error) },
        "Email webhook could not persist the event",
      );
      respond(res, startedAt, { status: 503, result: "db_unavailable", kind: event.kind });
      return;
    }

    if (!persisted.duplicate) {
      await requestDrainBestEffort(
        { drains: options.drains, metrics: options.metrics, logger: options.logger },
        { maxJobs: DRAIN_BATCH, stage: "inbound" },
      );
    }
    respond(res, startedAt, { status: 200, result: persisted.duplicate ? "duplicate" : "persisted", kind: event.kind });
  });

  return router;
};
