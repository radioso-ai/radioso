import type { ErrorEvent, ErrorSink } from "../radiosoModuleTypes.js";

interface PosthogErrorSinkOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  host: string;
}

interface PosthogStackFrame {
  platform: "custom";
  lang: "javascript";
  function: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
}

const normalizeHost = (host: string): string => host.replace(/\/+$/, "");

const toDistinctId = (event: ErrorEvent): string => {
  const requestId = event.correlation?.requestId;
  const traceId = event.correlation?.traceId;

  if (typeof requestId === "string" && requestId.length > 0) {
    return requestId;
  }

  if (typeof traceId === "string" && traceId.length > 0) {
    return traceId;
  }

  return `${event.environment}:${event.service}`;
};

const parseLocation = (location: string): Pick<PosthogStackFrame, "filename" | "lineno" | "colno"> => {
  const match = location.match(/^(?<filename>.*?)(?::(?<lineno>\d+))?(?::(?<colno>\d+))?$/);
  if (!match?.groups) {
    return { filename: location };
  }

  return {
    filename: match.groups.filename || location,
    lineno: match.groups.lineno ? Number(match.groups.lineno) : undefined,
    colno: match.groups.colno ? Number(match.groups.colno) : undefined,
  };
};

const parseStackLine = (line: string): PosthogStackFrame | null => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("at ")) {
    return null;
  }

  const withoutPrefix = trimmed.slice(3);
  const withFunction = withoutPrefix.match(/^(?<fn>.+?) \((?<location>.+)\)$/);
  const functionName = withFunction?.groups?.fn ?? "<anonymous>";
  const location = withFunction?.groups?.location ?? withoutPrefix;

  return {
    platform: "custom",
    lang: "javascript",
    function: functionName,
    ...parseLocation(location),
    in_app: !location.startsWith("node:") && !location.includes("node_modules"),
  };
};

const parseStackTrace = (stack: string | undefined): PosthogStackFrame[] =>
  (stack ?? "")
    .split("\n")
    .map(parseStackLine)
    .filter((frame): frame is PosthogStackFrame => frame !== null);

export class PosthogErrorSink implements ErrorSink {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: PosthogErrorSinkOptions) {
    this.endpoint = `${normalizeHost(options.host)}/i/v0/e/`;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async record(event: ErrorEvent): Promise<void> {
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        api_key: this.options.apiKey,
        event: "$exception",
        distinct_id: toDistinctId(event),
        timestamp: event.timestamp,
        properties: {
          distinct_id: toDistinctId(event),
          "$process_person_profile": false,
          "$exception_fingerprint": `${event.service}:${event.errorType}:${event.errorClass ?? "UnknownError"}`,
          "$exception_level": event.severity === "warn" ? "warning" : event.severity,
          "$exception_list": [
            {
              type: event.errorClass ?? event.errorType,
              value: event.message,
              mechanism: {
                handled: true,
                synthetic: false,
              },
              stacktrace: {
                type: "raw",
                frames: parseStackTrace(event.stack),
              },
            },
          ],
          errorType: event.errorType,
          service: event.service,
          environment: event.environment,
          version: event.version,
          correlation: event.correlation,
          requestContext: event.requestContext,
          metadata: event.metadata,
          tags: event.tags,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`PostHog exception capture failed with status ${response.status}`);
    }
  }
}
