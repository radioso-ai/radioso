import type { ErrorEvent } from "./errorTypes.js";

export interface ErrorSink {
  /** A coded name for this destination, for the `error_sink_failed` log line to name it by. */
  readonly name: string;
  record(event: ErrorEvent): Promise<void>;
}
