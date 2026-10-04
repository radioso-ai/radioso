import { AppError, tooManyRequests, serviceUnavailable } from "../../../shared/domain/errors.js";
import type {
  AbuseControlBatchConsumption,
  AbuseControlConsumption,
  AbuseControlConsumptionInput,
  AbuseControlDecision,
  AbuseControlRepositoryPort,
} from "../contracts/abuseControl.js";
import type { AbuseControlBatchPort, AbuseControlPolicy, AbuseControlPort } from "../contracts/abuseControl.js";

export class AbuseControlService implements AbuseControlPort, AbuseControlBatchPort {
  constructor(private readonly repository: AbuseControlRepositoryPort) {}

  async enforce(policy: AbuseControlPolicy): Promise<AbuseControlDecision> {
    try {
      const input = this.toConsumptionInput(policy, policy.now ?? new Date());
      const result = await this.repository.consume(input);
      void this.repository.deleteExpired(input.now).catch(() => undefined);
      return this.decide(result, input);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw serviceUnavailable("Abuse control enforcement is unavailable");
    }
  }

  async enforceBatch(policies: readonly AbuseControlPolicy[]): Promise<AbuseControlDecision[]> {
    if (policies.length === 0) {
      return [];
    }

    const now = new Date();
    const inputs = policies.map((policy) => this.toConsumptionInput(policy, policy.now ?? now));
    try {
      const batch = await this.repository.consumeBatch(inputs);
      this.throwIfRejected(batch, inputs);
      void this.repository.deleteExpired(now).catch(() => undefined);
      return batch.entries.map((entry, index) => this.decide(entry, inputs[index]));
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw serviceUnavailable("Abuse control enforcement is unavailable");
    }
  }

  private toConsumptionInput(policy: AbuseControlPolicy, now: Date): AbuseControlConsumptionInput {
    return {
      scope: policy.scope,
      subjectKey: policy.subjectKey,
      limit: policy.limit,
      windowMs: policy.windowMs,
      blockMs: policy.blockMs ?? policy.windowMs,
      now,
    };
  }

  private throwIfRejected(batch: AbuseControlBatchConsumption, inputs: readonly AbuseControlConsumptionInput[]): void {
    if (!batch.rejected) {
      return;
    }
    const rejected = batch.rejected;
    const rejectedInput = inputs.find((input) =>
      input.scope === rejected.entry.scope && input.subjectKey === rejected.entry.subjectKey,
    );
    this.decide(rejected, rejectedInput ?? inputs[0]);
  }

  /**
   * The same decision on both paths, so an admitted caller learns what is left and a rejected one
   * learns when to return. The rejected decision rides in the 429 body, which is where the HTTP
   * layer picks it up again.
   */
  private decide(consumption: AbuseControlConsumption, input: AbuseControlConsumptionInput): AbuseControlDecision {
    const { blockedUntil, windowStartedAt } = consumption.entry;
    if (consumption.blocked && blockedUntil) {
      throw tooManyRequests("Rate limit exceeded. Please wait before trying again.", {
        limit: input.limit,
        remaining: 0,
        resetAtMs: blockedUntil.getTime(),
        retryAfterSeconds: this.retryAfterSeconds(blockedUntil, input.now),
      } satisfies AbuseControlDecision);
    }
    return {
      limit: input.limit,
      remaining: Math.max(0, Math.floor(input.limit - consumption.weightedAttemptCount)),
      resetAtMs: windowStartedAt.getTime() + input.windowMs,
    };
  }

  private retryAfterSeconds(blockedUntil: Date, now: Date): number {
    return Math.max(1, Math.ceil((blockedUntil.getTime() - now.getTime()) / 1000));
  }
}
