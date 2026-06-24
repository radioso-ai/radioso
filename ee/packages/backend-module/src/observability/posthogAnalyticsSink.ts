import type { ProductAnalyticsEvent, ProductAnalyticsSink } from "../radiosoModuleTypes.js";

interface PosthogAnalyticsSinkOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  host: string;
}

const normalizeHost = (host: string): string => host.replace(/\/+$/, "");

const toDistinctId = (event: ProductAnalyticsEvent): string =>
  event.subjectId ?? event.workspaceId ?? event.accountId ?? "radioso-anonymous";

export class PosthogAnalyticsSink implements ProductAnalyticsSink {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: PosthogAnalyticsSinkOptions) {
    this.endpoint = `${normalizeHost(options.host)}/i/v0/e/`;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async emit(event: ProductAnalyticsEvent): Promise<void> {
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        api_key: this.options.apiKey,
        event: event.eventName,
        distinct_id: toDistinctId(event),
        timestamp: event.timestamp,
        properties: {
          ...event.properties,
          workspaceId: event.workspaceId,
          accountId: event.accountId,
          actorType: event.actorType,
          subjectType: event.subjectType,
          subjectId: event.subjectId,
          source: event.source,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`PostHog capture failed with status ${response.status}`);
    }
  }
}
