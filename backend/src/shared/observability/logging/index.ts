import { context } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import type { Logger as OpenTelemetryLogger } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import type { LogRecordExporter } from "@opentelemetry/sdk-logs";
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

import type { AppLogger } from "../logger.js";
import { safeTraceAttributes } from "../tracing/attributePolicy.js";
import type { RuntimeRole } from "../runtimeRole.js";

export type LogLevelName = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

interface LoggingLogger {
  error: AppLogger["error"];
  info?: AppLogger["info"];
}

interface OpenTelemetryLoggingConfig {
  authBearerToken?: string;
  enabled: boolean;
  environment: string;
  headers?: Record<string, string>;
  logger?: LoggingLogger;
  logExporter?: LogRecordExporter;
  minimumLevel?: LogLevelName;
  otlpEndpoint?: string;
  runtimeRole: RuntimeRole;
  serviceName: string;
  version?: string;
}

interface ActiveOpenTelemetryLogging {
  enabled: true;
  logger?: LoggingLogger;
  otelLogger: OpenTelemetryLogger;
  provider: LoggerProvider;
  serviceName: string;
}

interface DisabledOpenTelemetryLogging {
  enabled: false;
}

type OpenTelemetryLoggingState = ActiveOpenTelemetryLogging | DisabledOpenTelemetryLogging;

const disabledLogging: DisabledOpenTelemetryLogging = { enabled: false };
let activeLogging: OpenTelemetryLoggingState = disabledLogging;
const SHUTDOWN_TIMEOUT_MS = 5_000;

const levelToSeverityNumber: Record<LogLevelName, SeverityNumber> = {
  trace: SeverityNumber.TRACE,
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
  fatal: SeverityNumber.FATAL,
};

const pinoLevelToName = (level: number): LogLevelName => {
  if (level >= 60) {
    return "fatal";
  }
  if (level >= 50) {
    return "error";
  }
  if (level >= 40) {
    return "warn";
  }
  if (level >= 30) {
    return "info";
  }
  if (level >= 20) {
    return "debug";
  }
  return "trace";
};

const shouldSkipMessage = (message: string | undefined): boolean =>
  message === "otel_log_export_failed" ||
  message === "otel_logging_shutdown_failed" ||
  message === "otel_logging_shutdown_timeout";

const errorFields = (error: unknown): Record<string, string> => {
  if (error instanceof Error) {
    return { err: error.message };
  }
  return { err: String(error) };
};

class LoggingLogRecordExporter implements LogRecordExporter {
  constructor(
    private readonly exporter: LogRecordExporter,
    private readonly logger: LoggingLogger | undefined,
  ) {}

  export(records: Parameters<LogRecordExporter["export"]>[0], callback: Parameters<LogRecordExporter["export"]>[1]): void {
    this.exporter.export(records, (result) => {
      // result.code is @opentelemetry/core's ExportResultCode (SUCCESS = 0, FAILED = 1); comparing
      // to the literal avoids adding a direct dependency on that package for one enum value.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison -- see comment above
      if (result.code !== 0) {
        this.logger?.error(
          {
            err: result.error instanceof Error ? result.error.message : "log export failed",
            logCount: records.length,
          },
          "otel_log_export_failed",
        );
      }
      callback(result);
    });
  }

  forceFlush(): Promise<void> {
    return this.exporter.forceFlush?.() ?? Promise.resolve();
  }

  shutdown(): Promise<void> {
    return this.exporter.shutdown();
  }
}

const buildExporterHeaders = (config: OpenTelemetryLoggingConfig): Record<string, string> | undefined => {
  const headers = { ...(config.headers ?? {}) };
  if (config.authBearerToken && !headers.Authorization && !headers.authorization) {
    headers.Authorization = `Bearer ${config.authBearerToken}`;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
};

export const initializeOpenTelemetryLogging = (config: OpenTelemetryLoggingConfig): void => {
  logs.disable();
  activeLogging = disabledLogging;

  if (!config.enabled) {
    return;
  }

  try {
    const exporter = new LoggingLogRecordExporter(
      config.logExporter ?? new OTLPLogExporter({
        url: config.otlpEndpoint,
        headers: buildExporterHeaders(config),
      }),
      config.logger,
    );
    const processor = config.logExporter
      ? new SimpleLogRecordProcessor({ exporter })
      : new BatchLogRecordProcessor({ exporter });
    const minimumLevel = config.minimumLevel ?? "info";
    const provider = new LoggerProvider({
      resource: resourceFromAttributes(safeTraceAttributes({
        [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.environment,
        [ATTR_SERVICE_NAME]: config.serviceName,
        [ATTR_SERVICE_VERSION]: config.version,
        "radioso.runtime_role": config.runtimeRole,
      })),
      logRecordLimits: {
        attributeCountLimit: 64,
        attributeValueLengthLimit: 512,
      },
      loggerConfigurator: () => ({
        disabled: false,
        minimumSeverity: levelToSeverityNumber[minimumLevel],
        traceBased: false,
      }),
      processors: [processor],
    });

    logs.setGlobalLoggerProvider(provider);
    activeLogging = {
      enabled: true,
      logger: config.logger,
      otelLogger: logs.getLogger("radioso-pino", config.version),
      provider,
      serviceName: config.serviceName,
    };
    config.logger?.info?.(
      {
        environment: config.environment,
        minimumLevel,
        runtimeRole: config.runtimeRole,
        serviceName: config.serviceName,
      },
      "otel_logging_initialized",
    );
  } catch (error) {
    config.logger?.error(errorFields(error), "otel_logging_init_failed");
    logs.disable();
    activeLogging = disabledLogging;
    throw error;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const messageFromArgs = (args: unknown[]): string | undefined => {
  for (const arg of args) {
    if (typeof arg === "string") {
      return arg;
    }
  }
  return undefined;
};

const errorAttributesFromField = (key: string, error: Error): Record<string, string> => {
  if (key === "err") {
    return {
      err: error.message,
      errorClass: error.name,
    };
  }

  if (key === "error") {
    return {
      errorClass: error.name,
      errorMessage: error.message,
    };
  }

  return {
    [`${key}Class`]: error.name,
    [`${key}Message`]: error.message,
  };
};

const attributesFromRecord = (record: Record<string, unknown>): Record<string, unknown> => {
  const attributes: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    if (value instanceof Error) {
      Object.assign(attributes, errorAttributesFromField(key, value));
      continue;
    }

    attributes[key] = value;
  }

  return attributes;
};

const attributesFromArgs = (args: unknown[]): Record<string, unknown> => {
  const [firstArg] = args;
  if (firstArg instanceof Error) {
    return {
      errorClass: firstArg.name,
      errorMessage: firstArg.message,
    };
  }
  if (!isRecord(firstArg)) {
    return {};
  }
  return attributesFromRecord(firstArg);
};

export const emitPinoLogRecordForOpenTelemetry = (level: number, args: unknown[]): void => {
  if (!activeLogging.enabled) {
    return;
  }

  const message = messageFromArgs(args);
  if (shouldSkipMessage(message)) {
    return;
  }

  const levelName = pinoLevelToName(level);
  activeLogging.otelLogger.emit({
    body: message,
    context: context.active(),
    severityNumber: levelToSeverityNumber[levelName],
    severityText: levelName.toUpperCase(),
    attributes: safeTraceAttributes({
      ...attributesFromArgs(args),
      "log.logger": activeLogging.serviceName,
      "log.pino_level": level,
    }),
  });
};

export const shutdownOpenTelemetryLogging = async (): Promise<void> => {
  if (!activeLogging.enabled) {
    return;
  }

  const logging = activeLogging;
  activeLogging = disabledLogging;
  logs.disable();

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timeoutHandle = setTimeout(() => resolve("timeout"), SHUTDOWN_TIMEOUT_MS);
    timeoutHandle.unref?.();
  });

  try {
    const result = await Promise.race([logging.provider.shutdown(), timeout]);
    if (result === "timeout") {
      logging.logger?.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, "otel_logging_shutdown_timeout");
    }
  } catch (error) {
    logging.logger?.error(errorFields(error), "otel_logging_shutdown_failed");
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
};
