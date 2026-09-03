import type { Env } from "../../../app/config/env.js";
import type { ProductAnalyticsSink } from "../../analytics/productAnalyticsSink.js";
import type { ProductAnalyticsEventName } from "../../analytics/productAnalyticsTypes.js";
import type { ErrorSink } from "../../errors/errorSink.js";
import { FetchWebhookHttpClient } from "../../infra/http/signedWebhook.js";
import { parseConfiguredSinks } from "../configuredSinks.js";
import { OpsEventDispatcher, type OpsEventDispatcherLogger } from "./opsEventDispatcher.js";
import { OpsWebhookAnalyticsSink, OpsWebhookErrorSink } from "./opsEventWebhookSinks.js";
import { SignedWebhookOpsEventTransport } from "./opsEventWebhookTransport.js";

export type OpsEventEnv = Pick<
  Env,
  | "OPS_EVENT_WEBHOOK_URL"
  | "OPS_EVENT_WEBHOOK_SECRET"
  | "OPS_EVENT_WEBHOOK_EVENTS"
  | "OPS_EVENT_WEBHOOK_MIN_ERROR_SEVERITY"
  | "OPS_EVENT_WEBHOOK_QUEUE_LIMIT"
>;

export interface OpsEventSinks {
  analytics: ProductAnalyticsSink | null;
  error: ErrorSink | null;
  dispatcher: OpsEventDispatcher | null;
}

const emptySinks: OpsEventSinks = { analytics: null, error: null, dispatcher: null };

export const buildOpsEventSinks = (input: {
  env: OpsEventEnv;
  logger: OpsEventDispatcherLogger;
}): OpsEventSinks => {
  const { OPS_EVENT_WEBHOOK_URL: url, OPS_EVENT_WEBHOOK_SECRET: secret } = input.env;

  if (!url || !secret) {
    return emptySinks;
  }

  // The destination is operator-configured infrastructure, not visitor input. The
  // public-URL guard that protects user-supplied webhook URLs would only block a
  // collector running inside the operator's own network, so it does not apply here.
  const httpClient = new FetchWebhookHttpClient(async () => {}, { fetchImpl: fetch });

  const dispatcher = new OpsEventDispatcher({
    transport: new SignedWebhookOpsEventTransport(httpClient, { url, secret }),
    logger: input.logger,
    queueLimit: input.env.OPS_EVENT_WEBHOOK_QUEUE_LIMIT,
  });

  const configuredEventNames = parseConfiguredSinks(input.env.OPS_EVENT_WEBHOOK_EVENTS);

  return {
    analytics: new OpsWebhookAnalyticsSink(dispatcher, {
      eventNames: configuredEventNames.length > 0
        ? new Set(configuredEventNames as ProductAnalyticsEventName[])
        : undefined,
    }),
    error: new OpsWebhookErrorSink(dispatcher, {
      minSeverity: input.env.OPS_EVENT_WEBHOOK_MIN_ERROR_SEVERITY,
    }),
    dispatcher,
  };
};
