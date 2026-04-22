import type { AppLogger } from "../observability/logger.js";
import { redactRecord } from "../observability/telemetry/redactionPolicy.js";
import type { ProductAnalyticsEvent, ProductAnalyticsEventName } from "./productAnalyticsTypes.js";
import type { ProductAnalyticsSink } from "./productAnalyticsSink.js";

export interface ProductAnalyticsEventInput {
  eventName: ProductAnalyticsEventName;
  workspaceId?: string;
  accountId?: string;
  actorType?: ProductAnalyticsEvent["actorType"];
  subjectType?: ProductAnalyticsEvent["subjectType"];
  subjectId?: string;
  properties?: Record<string, unknown>;
  source?: ProductAnalyticsEvent["source"];
}

export interface ProductAnalyticsPort {
  track(input: ProductAnalyticsEventInput): Promise<ProductAnalyticsEvent | null>;
}

interface ProductAnalyticsServiceOptions {
  enabled?: boolean;
  logger: AppLogger;
  sinks?: ProductAnalyticsSink[];
}

export class ProductAnalyticsService implements ProductAnalyticsPort {
  constructor(private readonly options: ProductAnalyticsServiceOptions) {}

  async track(input: ProductAnalyticsEventInput): Promise<ProductAnalyticsEvent | null> {
    if (this.options.enabled === false) {
      return null;
    }

    const event: ProductAnalyticsEvent = {
      eventName: input.eventName,
      timestamp: new Date().toISOString(),
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      actorType: input.actorType,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      properties: redactRecord(input.properties),
      source: input.source ?? "backend",
    };

    this.options.logger.info(
      {
        analytics: {
          eventName: event.eventName,
          workspaceId: event.workspaceId,
          accountId: event.accountId,
          actorType: event.actorType,
          subjectType: event.subjectType,
          subjectId: event.subjectId,
          source: event.source,
        },
      },
      "product_analytics_event",
    );

    await Promise.all((this.options.sinks ?? []).map(async (sink) => {
      try {
        await sink.emit(event);
      } catch (error) {
        this.options.logger.error(
          {
            err: error instanceof Error ? error.message : String(error),
            eventName: event.eventName,
          },
          "product_analytics_sink_failed",
        );
      }
    }));

    return event;
  }
}

export class NoopProductAnalyticsService implements ProductAnalyticsPort {
  async track(_input: ProductAnalyticsEventInput): Promise<ProductAnalyticsEvent | null> {
    return null;
  }
}
