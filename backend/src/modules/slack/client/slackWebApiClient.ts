export type SlackFetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export type SlackUrlGuard = (url: string) => Promise<void> | void;

export interface SlackWebApiClientOptions {
  botToken: string;
  fetchImpl?: SlackFetchLike;
  assertPublicUrl?: SlackUrlGuard;
  timeoutMs?: number;
}

export interface SlackPostMessageInput {
  channel: string;
  text: string;
  threadTs?: string;
}

export interface SlackPostMessageResult {
  channel: string;
  ts: string;
}

export interface SlackConversationSummary {
  id: string;
  name?: string;
  isChannel?: boolean;
  isIm?: boolean;
}

export interface SlackUserInfo {
  id: string;
  name?: string;
  realName?: string;
  isBot?: boolean;
}

export interface SlackAuthTestResult {
  teamId: string;
  userId: string;
  botId?: string;
}

export class SlackWebApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "SlackWebApiError";
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const SLACK_API_BASE_URL = "https://slack.com/api/";

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const readString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const isRetryableHttpStatus = (status: number): boolean => status === 429 || status >= 500;

const isRetryableSlackError = (code: string): boolean =>
  new Set(["rate_limited", "fatal_error", "internal_error", "service_unavailable", "temporarily_unavailable"]).has(code);

export class SlackWebApiClient {
  private readonly fetchImpl: SlackFetchLike;

  constructor(private readonly options: SlackWebApiClientOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async postMessage(input: SlackPostMessageInput): Promise<SlackPostMessageResult> {
    const payload = await this.call("chat.postMessage", {
      method: "POST",
      body: {
        channel: input.channel,
        text: input.text,
        ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      },
    });
    const channel = readString(payload.channel);
    const ts = readString(payload.ts);
    if (!channel || !ts) {
      throw new SlackWebApiError("invalid_response", "Slack chat.postMessage response was missing channel or timestamp");
    }
    return { channel, ts };
  }

  async conversationsList(input: { cursor?: string; limit?: number; types?: string[] } = {}): Promise<{
    channels: SlackConversationSummary[];
    nextCursor: string | null;
  }> {
    const params = new URLSearchParams();
    if (input.cursor) params.set("cursor", input.cursor);
    if (input.limit) params.set("limit", String(input.limit));
    if (input.types?.length) params.set("types", input.types.join(","));
    const payload = await this.call(`conversations.list${params.size > 0 ? `?${params.toString()}` : ""}`, {
      method: "GET",
    });
    const channels = Array.isArray(payload.channels) ? payload.channels : [];
    const responseMetadata = isObject(payload.response_metadata) ? payload.response_metadata : {};
    return {
      channels: channels.filter(isObject).map((channel) => ({
        id: readString(channel.id) ?? "",
        ...(readString(channel.name) ? { name: readString(channel.name) } : {}),
        ...(typeof channel.is_channel === "boolean" ? { isChannel: channel.is_channel } : {}),
        ...(typeof channel.is_im === "boolean" ? { isIm: channel.is_im } : {}),
      })).filter((channel) => channel.id.length > 0),
      nextCursor: readString(responseMetadata.next_cursor) ?? null,
    };
  }

  async usersInfo(user: string): Promise<SlackUserInfo> {
    const params = new URLSearchParams({ user });
    const payload = await this.call(`users.info?${params.toString()}`, { method: "GET" });
    const slackUser = isObject(payload.user) ? payload.user : {};
    const id = readString(slackUser.id);
    if (!id) {
      throw new SlackWebApiError("invalid_response", "Slack users.info response was missing user id");
    }
    return {
      id,
      ...(readString(slackUser.name) ? { name: readString(slackUser.name) } : {}),
      ...(readString(slackUser.real_name) ? { realName: readString(slackUser.real_name) } : {}),
      ...(typeof slackUser.is_bot === "boolean" ? { isBot: slackUser.is_bot } : {}),
    };
  }

  async authTest(): Promise<SlackAuthTestResult> {
    const payload = await this.call("auth.test", { method: "POST", body: {} });
    const teamId = readString(payload.team_id);
    const userId = readString(payload.user_id);
    if (!teamId || !userId) {
      throw new SlackWebApiError("invalid_response", "Slack auth.test response was missing team or user id");
    }
    return {
      teamId,
      userId,
      ...(readString(payload.bot_id) ? { botId: readString(payload.bot_id) } : {}),
    };
  }

  private async call(path: string, input: { method: "GET" | "POST"; body?: Record<string, unknown> }): Promise<Record<string, unknown>> {
    const url = new URL(path, SLACK_API_BASE_URL).toString();
    await this.options.assertPublicUrl?.(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, {
        method: input.method,
        headers: {
          Authorization: `Bearer ${this.options.botToken}`,
          Accept: "application/json",
          ...(input.body ? { "Content-Type": "application/json" } : {}),
        },
        ...(input.body ? { body: JSON.stringify(input.body) } : {}),
        signal: controller.signal,
      });
      const payload = await response.json();
      if (!response.ok) {
        const code = isObject(payload) ? readString(payload.error) : undefined;
        throw new SlackWebApiError(
          code ?? `http_${response.status}`,
          `Slack Web API request failed with status ${response.status}`,
          isRetryableHttpStatus(response.status),
        );
      }
      if (!isObject(payload)) {
        throw new SlackWebApiError("invalid_response", "Slack Web API response was not an object");
      }
      if (payload.ok !== true) {
        const code = readString(payload.error) ?? "not_ok";
        throw new SlackWebApiError(code, `Slack Web API returned ok:false: ${code}`, isRetryableSlackError(code));
      }
      return payload;
    } catch (error) {
      if (error instanceof SlackWebApiError) {
        throw error;
      }
      throw new SlackWebApiError("network_error", "Slack Web API request failed", true);
    } finally {
      clearTimeout(timer);
    }
  }
}
