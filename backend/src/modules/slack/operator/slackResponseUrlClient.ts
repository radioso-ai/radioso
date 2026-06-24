export interface SlackResponseUrlClient {
  postToResponseUrl(url: string, body: Record<string, unknown>): Promise<void>;
}

export type SlackResponseUrlFetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}) => Promise<{ ok: boolean; status: number }>;

const DEFAULT_TIMEOUT_MS = 10_000;

export class FetchSlackResponseUrlClient implements SlackResponseUrlClient {
  private readonly fetchImpl: SlackResponseUrlFetchLike;

  constructor(private readonly options: {
    fetchImpl?: SlackResponseUrlFetchLike;
    assertPublicUrl?: (url: string) => Promise<void> | void;
    timeoutMs?: number;
  } = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async postToResponseUrl(url: string, body: Record<string, unknown>): Promise<void> {
    await this.options.assertPublicUrl?.(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`slack_response_url_http_${response.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
