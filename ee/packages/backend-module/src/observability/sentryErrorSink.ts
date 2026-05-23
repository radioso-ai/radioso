import { randomUUID } from "node:crypto";

import type { ErrorEvent, ErrorSink } from "../radiosoModuleTypes.js";

interface SentryErrorSinkOptions {
  clientName?: string;
  dsn: string;
  fetchImpl?: typeof fetch;
}

interface ParsedSentryDsn {
  dsn: string;
  envelopeUrl: string;
  publicKey: string;
  secretKey?: string;
}

const parseDsn = (dsn: string): ParsedSentryDsn => {
  const url = new URL(dsn);
  const projectId = url.pathname.split("/").filter((segment) => segment.length > 0).pop();

  if (!projectId) {
    throw new Error("SENTRY_DSN must include a project id");
  }

  const basePath = url.pathname.slice(0, url.pathname.lastIndexOf(`/${projectId}`));
  return {
    dsn: url.toString(),
    envelopeUrl: `${url.protocol}//${url.host}${basePath}/api/${projectId}/envelope/`,
    publicKey: decodeURIComponent(url.username),
    secretKey: url.password ? decodeURIComponent(url.password) : undefined,
  };
};

const toLevel = (severity: ErrorEvent["severity"]): "info" | "warning" | "error" => {
  if (severity === "warn") {
    return "warning";
  }
  return severity;
};

export class SentryErrorSink implements ErrorSink {
  private readonly clientName: string;
  private readonly fetchImpl: typeof fetch;
  private readonly parsedDsn: ParsedSentryDsn;

  constructor(options: SentryErrorSinkOptions) {
    this.clientName = options.clientName ?? "radioso-observability";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.parsedDsn = parseDsn(options.dsn);
  }

  async record(event: ErrorEvent): Promise<void> {
    const eventId = randomUUID().replace(/-/g, "");
    const envelopeHeaders = JSON.stringify({
      dsn: this.parsedDsn.dsn,
      event_id: eventId,
      sent_at: new Date().toISOString(),
    });
    const itemHeaders = JSON.stringify({
      type: "event",
    });
    const payload = JSON.stringify({
      event_id: eventId,
      timestamp: event.timestamp,
      platform: "node",
      environment: event.environment,
      release: event.version,
      level: toLevel(event.severity),
      logger: event.service,
      message: {
        formatted: event.message,
      },
      tags: {
        ...event.tags,
        errorType: event.errorType,
        service: event.service,
      },
      request: event.requestContext
        ? {
            method: event.requestContext.method,
            url: event.requestContext.route,
          }
        : undefined,
      extra: {
        correlation: event.correlation,
        metadata: event.metadata,
        stack: event.stack,
        errorClass: event.errorClass,
      },
    });
    const body = `${envelopeHeaders}\n${itemHeaders}\n${payload}`;
    const authParts = [
      "sentry_version=7",
      `sentry_key=${this.parsedDsn.publicKey}`,
      `sentry_client=${this.clientName}`,
    ];

    if (this.parsedDsn.secretKey) {
      authParts.push(`sentry_secret=${this.parsedDsn.secretKey}`);
    }

    const response = await this.fetchImpl(this.parsedDsn.envelopeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry ${authParts.join(", ")}`,
      },
      body,
    });

    if (!response.ok) {
      throw new Error(`Sentry envelope delivery failed with status ${response.status}`);
    }
  }
}
