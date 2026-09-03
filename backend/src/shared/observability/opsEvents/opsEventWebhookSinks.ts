import { randomUUID } from "node:crypto";

import type { ProductAnalyticsSink } from "../../analytics/productAnalyticsSink.js";
import type { ProductAnalyticsEvent, ProductAnalyticsEventName } from "../../analytics/productAnalyticsTypes.js";
import type { ErrorEvent } from "../../errors/errorTypes.js";
import type { ErrorSink } from "../../errors/errorSink.js";
import type { OpsEventDispatcher } from "./opsEventDispatcher.js";
import {
  opsEventSeverityOrder,
  toOpsEventFromAnalytics,
  toOpsEventFromError,
  type OpsEventSeverity,
} from "./opsEventEnvelope.js";

export interface OpsWebhookAnalyticsSinkOptions {
  /** Omit to forward every event; supply a set to narrow a busy stack down to what matters. */
  eventNames?: ReadonlySet<ProductAnalyticsEventName>;
}

export class OpsWebhookAnalyticsSink implements ProductAnalyticsSink {
  constructor(
    private readonly dispatcher: OpsEventDispatcher,
    private readonly options: OpsWebhookAnalyticsSinkOptions,
  ) {}

  async emit(event: ProductAnalyticsEvent): Promise<void> {
    if (this.options.eventNames && !this.options.eventNames.has(event.eventName)) {
      return;
    }

    this.dispatcher.enqueue(toOpsEventFromAnalytics(event, randomUUID()));
  }
}

export interface OpsWebhookErrorSinkOptions {
  minSeverity: OpsEventSeverity;
}

export class OpsWebhookErrorSink implements ErrorSink {
  constructor(
    private readonly dispatcher: OpsEventDispatcher,
    private readonly options: OpsWebhookErrorSinkOptions,
  ) {}

  async record(event: ErrorEvent): Promise<void> {
    if (opsEventSeverityOrder[event.severity] < opsEventSeverityOrder[this.options.minSeverity]) {
      return;
    }

    this.dispatcher.enqueue(toOpsEventFromError(event, randomUUID()));
  }
}
