import { appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export type AuditOutcome = "denied" | "error" | "success";

export interface AuditEvent {
  approvalId?: string;
  eventId: string;
  eventType: string;
  metadata?: Record<string, unknown>;
  outcome: AuditOutcome;
  sessionId?: string;
  statusCode?: number;
  timestamp: string;
  toolName?: string;
}

export interface AuditSink {
  write(event: AuditEvent): void | Promise<void>;
}

export interface AuditLogger {
  emit(event: Omit<AuditEvent, "eventId" | "timestamp"> & { eventId?: string; timestamp?: string }): Promise<void>;
}

const REDACTED = "[redacted]";
const SENSITIVE_KEY_PATTERN = /(token|secret|password|authorization|api[-_]?key)/i;

const sanitizeValue = (key: string, value: unknown): unknown => {
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return REDACTED;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(key, item));
  }

  if (value && typeof value === "object") {
    return sanitizeObject(value as Record<string, unknown>);
  }

  return value;
};

const sanitizeObject = (value: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeValue(key, entry)]));

export const sanitizeAuditEvent = (event: AuditEvent): AuditEvent => ({
  ...event,
  metadata: event.metadata ? sanitizeObject(event.metadata) : undefined,
});

export const createAuditLogger = (sinks: AuditSink[], now: () => Date = () => new Date()): AuditLogger => ({
  async emit(event) {
    const sanitizedEvent: AuditEvent = sanitizeAuditEvent({
      ...event,
      eventId: event.eventId ?? randomUUID(),
      timestamp: event.timestamp ?? now().toISOString(),
    });

    await Promise.allSettled(sinks.map(async (sink) => sink.write(sanitizedEvent)));
  },
});

export const createInMemoryAuditSink = (): { events: AuditEvent[]; sink: AuditSink } => {
  const events: AuditEvent[] = [];
  return {
    events,
    sink: {
      write(event) {
        events.push(event);
      },
    },
  };
};

export const createConsoleAuditSink = (): AuditSink => ({
  write(event) {
    console.info(JSON.stringify(event));
  },
});

export const createJsonlFileAuditSink = (filePath: string): AuditSink => ({
  async write(event) {
    await appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
  },
});
