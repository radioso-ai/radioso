import type {
  AbuseControlBatchConsumption,
  AbuseControlConsumption,
  AbuseControlConsumptionInput,
  AbuseControlEntry,
  AbuseControlRepositoryPort,
} from "../contracts/abuseControl.js";

type FallbackOperation = "consume" | "consume_batch" | "find" | "save";

interface FallbackObservability {
  logger: {
    warn(fields: Record<string, string>, message: string): void;
  };
  metrics?: {
    incrementCounter(name: string, options: { help: string; labels: Record<string, string> }): void;
  } | null;
}

interface FallbackCircuitOptions {
  clock?: () => number;
  failureThreshold?: number;
  initialOpenMs?: number;
  jitter?: () => number;
  maxOpenMs?: number;
  warningIntervalMs?: number;
}

const DEFAULT_CIRCUIT_OPTIONS: Required<FallbackCircuitOptions> = {
  clock: Date.now,
  failureThreshold: 2,
  initialOpenMs: 500,
  jitter: Math.random,
  maxOpenMs: 60_000,
  warningIntervalMs: 60_000,
};
const FALLBACK_CLEANUP_INTERVAL_MS = 5 * 60_000;

export class FallbackAbuseControlRepository implements AbuseControlRepositoryPort {
  private readonly circuit: Required<FallbackCircuitOptions>;
  private consecutiveFailures = 0;
  private halfOpenProbeInFlight = false;
  private lastWarningAtMs: number | undefined;
  private openUntilMs: number | undefined;
  private fallbackWriteGeneration = 0;
  private cleanedFallbackWriteGeneration = 0;
  private fallbackCleanupInFlight: Promise<void> | undefined;
  private nextFallbackCleanupAtMs = 0;

  constructor(
    private readonly primary: AbuseControlRepositoryPort,
    private readonly fallback: AbuseControlRepositoryPort,
    private readonly observability: FallbackObservability,
    circuitOptions: FallbackCircuitOptions = {},
  ) {
    this.circuit = { ...DEFAULT_CIRCUIT_OPTIONS, ...circuitOptions };
  }

  find(scope: string, subjectKey: string): Promise<AbuseControlEntry | null> {
    return this.withFallback(
      "find",
      () => this.primary.find(scope, subjectKey),
      () => this.fallback.find(scope, subjectKey),
    );
  }

  save(input: {
    scope: string;
    subjectKey: string;
    attemptCount: number;
    windowStartedAt: Date;
    blockedUntil: Date | null;
  }): Promise<AbuseControlEntry> {
    return this.withFallback("save", () => this.primary.save(input), () => this.fallback.save(input));
  }

  consume(input: AbuseControlConsumptionInput): Promise<AbuseControlConsumption> {
    return this.withFallback("consume", () => this.primary.consume(input), () => this.fallback.consume(input));
  }

  consumeBatch(inputs: readonly AbuseControlConsumptionInput[]): Promise<AbuseControlBatchConsumption> {
    return this.withFallback(
      "consume_batch",
      () => this.primary.consumeBatch(inputs),
      () => this.fallback.consumeBatch(inputs),
    );
  }

  async deleteExpired(_now: Date): Promise<void> {
    const nowMs = this.circuit.clock();
    if (
      this.fallbackCleanupInFlight
      || this.cleanedFallbackWriteGeneration === this.fallbackWriteGeneration
      || nowMs < this.nextFallbackCleanupAtMs
    ) {
      return;
    }

    const generation = this.fallbackWriteGeneration;
    this.nextFallbackCleanupAtMs = nowMs + FALLBACK_CLEANUP_INTERVAL_MS;
    const cleanup = this.fallback.deleteExpired(new Date(nowMs));
    this.fallbackCleanupInFlight = cleanup;
    try {
      await cleanup;
      this.cleanedFallbackWriteGeneration = generation;
    } finally {
      if (this.fallbackCleanupInFlight === cleanup) this.fallbackCleanupInFlight = undefined;
    }
  }

  private async withFallback<T>(
    operation: FallbackOperation,
    usePrimary: () => Promise<T>,
    useFallback: () => Promise<T>,
  ): Promise<T> {
    const nowMs = this.circuit.clock();
    if (this.isCircuitOpen(nowMs) || this.halfOpenProbeInFlight) {
      this.recordFallback(operation, nowMs);
      return this.useFallback(operation, useFallback);
    }

    const isHalfOpenProbe = this.openUntilMs !== undefined;
    if (isHalfOpenProbe) this.halfOpenProbeInFlight = true;
    try {
      const result = await usePrimary();
      this.resetCircuit();
      return result;
    } catch {
      const failedAtMs = this.circuit.clock();
      this.recordFailure(failedAtMs);
      this.recordFallback(operation, failedAtMs);
      return this.useFallback(operation, useFallback);
    } finally {
      if (isHalfOpenProbe) this.halfOpenProbeInFlight = false;
    }
  }

  private isCircuitOpen(nowMs: number): boolean {
    return this.openUntilMs !== undefined && nowMs < this.openUntilMs;
  }

  private recordFailure(nowMs: number): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures < this.circuit.failureThreshold) return;
    const exponent = this.consecutiveFailures - this.circuit.failureThreshold;
    const baseIntervalMs = Math.min(this.circuit.maxOpenMs, this.circuit.initialOpenMs * 2 ** exponent);
    const jitterMultiplier = 0.5 + this.circuit.jitter();
    const intervalMs = Math.min(this.circuit.maxOpenMs, Math.max(1, Math.round(baseIntervalMs * jitterMultiplier)));
    this.openUntilMs = nowMs + intervalMs;
  }

  private resetCircuit(): void {
    this.consecutiveFailures = 0;
    this.openUntilMs = undefined;
  }

  private isFallbackWrite(operation: FallbackOperation): boolean {
    return operation === "consume" || operation === "consume_batch" || operation === "save";
  }

  private async useFallback<T>(operation: FallbackOperation, useFallback: () => Promise<T>): Promise<T> {
    const result = await useFallback();
    if (this.isFallbackWrite(operation)) this.fallbackWriteGeneration += 1;
    return result;
  }

  private recordFallback(operation: FallbackOperation, nowMs: number): void {
    if (this.lastWarningAtMs === undefined || nowMs - this.lastWarningAtMs >= this.circuit.warningIntervalMs) {
      this.observability.logger.warn(
        {
          component: "abuse-control",
          operation,
          primaryStore: "redis",
          fallbackStore: "postgres",
        },
        "abuse_control_store_fallback",
      );
      this.lastWarningAtMs = nowMs;
    }
    this.observability.metrics?.incrementCounter("abuse_control_store_fallback_total", {
      help: "Abuse-control checks that fell back from Redis to Postgres",
      labels: { operation },
    });
  }
}
