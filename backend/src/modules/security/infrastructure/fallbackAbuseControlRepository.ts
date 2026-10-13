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

export class FallbackAbuseControlRepository implements AbuseControlRepositoryPort {
  constructor(
    private readonly primary: AbuseControlRepositoryPort,
    private readonly fallback: AbuseControlRepositoryPort,
    private readonly observability: FallbackObservability,
  ) {}

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

  deleteExpired(now: Date): Promise<void> {
    // Redis entries expire by TTL. Avoid touching Postgres after a successful Redis check.
    return this.primary.deleteExpired(now);
  }

  private async withFallback<T>(
    operation: FallbackOperation,
    usePrimary: () => Promise<T>,
    useFallback: () => Promise<T>,
  ): Promise<T> {
    try {
      return await usePrimary();
    } catch {
      this.observability.logger.warn(
        {
          component: "abuse-control",
          operation,
          primaryStore: "redis",
          fallbackStore: "postgres",
        },
        "abuse_control_store_fallback",
      );
      this.observability.metrics?.incrementCounter("abuse_control_store_fallback_total", {
        help: "Abuse-control checks that fell back from Redis to Postgres",
        labels: { operation },
      });
      return useFallback();
    }
  }
}
