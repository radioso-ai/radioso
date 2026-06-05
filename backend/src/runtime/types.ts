import type { Server } from "node:http";

import type { ErrorReporter } from "../shared/errors/errorReporter.js";
import type { AppLogger } from "../shared/observability/logger.js";

export interface RuntimeHandle {
  server?: Server;
  /** Reporter for process-level fatal errors; consumed by `installProcessErrorHandlers`. */
  errorReporter?: ErrorReporter;
  /** The runtime's logger, exposed so entrypoints can wire process handlers without rebuilding one. */
  logger?: AppLogger;
  shutdown(signal: string): Promise<void>;
}
