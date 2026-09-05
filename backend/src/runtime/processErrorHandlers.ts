import type { AppLogger } from "../shared/observability/logger.js";
import type { ErrorReporter } from "../shared/errors/errorReporter.js";
import { asError } from "../shared/errors/asError.js";

type ListenerTarget = Pick<NodeJS.EventEmitter, "on" | "off">;

export interface InstallProcessErrorHandlersOptions {
  /** Where fatal process errors are sent (typically the {@link ErrorReportingService}). */
  reporter: ErrorReporter;
  logger: Pick<AppLogger, "error">;
  /** Process role, attached to logs/telemetry so an operator can tell which service crashed. */
  role: string;
  /** Overridable for tests; defaults to `process.exit`. */
  exit?: (code: number) => void;
  /** Overridable for tests; defaults to the global `process`. */
  target?: ListenerTarget;
  /**
   * Upper bound on how long we wait for the report to flush before exiting. A crashed
   * process must not hang on a slow or unreachable sink.
   */
  flushTimeoutMs?: number;
}

const DEFAULT_FLUSH_TIMEOUT_MS = 2_000;

const describeError = (error: unknown): { message: string; stack?: string } => {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { message: typeof error === "string" ? error : String(error) };
};

/**
 * Races a flush against a timeout. Resolves when the flush settles or the timeout
 * elapses; rejects only when the flush itself rejects (so the caller can log a sink
 * failure distinctly). A timeout is treated as "good enough" — we still exit.
 */
const flushWithTimeout = (flush: Promise<unknown>, timeoutMs: number): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (run: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      run();
    };
    const timer = setTimeout(() => finish(resolve), timeoutMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    Promise.resolve(flush).then(
      () => finish(resolve),
      (error) => finish(() => reject(asError(error))),
    );
  });

/**
 * Installs top-level handlers for `uncaughtException` and `unhandledRejection` so that
 * process-fatal errors — the ones that bypass the per-request and per-job paths — are
 * reported (e.g. to PostHog) before the process exits. Without this, a crash or a
 * floating promise rejection terminates the process with no error-sink record.
 *
 * The handler always exits with code 1 (matching Node's default crash behavior), but
 * only after best-effort flushing the report, bounded by `flushTimeoutMs`. Returns a
 * dispose function that removes the listeners.
 */
export const installProcessErrorHandlers = (
  options: InstallProcessErrorHandlersOptions,
): (() => void) => {
  const { reporter, logger, role } = options;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const target: ListenerTarget = options.target ?? process;
  const flushTimeoutMs = options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;

  // The process is in an undefined state once a fatal error fires; handle exactly one.
  let handling = false;

  const handleFatal = (errorType: string, error: unknown): void => {
    if (handling) {
      return;
    }
    handling = true;

    const described = describeError(error);
    logger.error({ role, errorType, err: described.message, stack: described.stack }, "process_fatal_error");

    void (async () => {
      try {
        await flushWithTimeout(
          reporter.report({ errorType, error, severity: "error", tags: { role } }),
          flushTimeoutMs,
        );
      } catch (reportError) {
        logger.error(
          { role, errorType, err: reportError instanceof Error ? reportError.message : String(reportError) },
          "process_error_report_failed",
        );
      } finally {
        exit(1);
      }
    })();
  };

  const onUncaughtException = (error: unknown): void => handleFatal("process.uncaughtException", error);
  const onUnhandledRejection = (reason: unknown): void => handleFatal("process.unhandledRejection", reason);

  target.on("uncaughtException", onUncaughtException);
  target.on("unhandledRejection", onUnhandledRejection);

  return () => {
    target.off("uncaughtException", onUncaughtException);
    target.off("unhandledRejection", onUnhandledRejection);
  };
};

/**
 * Convenience for entrypoints: installs process-level handlers from a started runtime's
 * exposed reporter and logger. Returns the dispose function, or `null` when the runtime
 * did not expose a reporter/logger (nothing to wire).
 */
export const installRuntimeProcessErrorHandlers = (
  runtime: { errorReporter?: ErrorReporter; logger?: AppLogger },
  role: string,
): (() => void) | null => {
  if (!runtime.errorReporter || !runtime.logger) {
    return null;
  }
  return installProcessErrorHandlers({
    reporter: runtime.errorReporter,
    logger: runtime.logger,
    role,
  });
};
