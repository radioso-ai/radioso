import type { ErrorEvent } from "./errorTypes.js";

export interface ErrorSink {
  record(event: ErrorEvent): Promise<void>;
}

export class NoopErrorSink implements ErrorSink {
  async record(_event: ErrorEvent): Promise<void> {}
}
