import { AppError, tooManyRequests, serviceUnavailable } from "../../../shared/domain/errors.js";
import type {
  AbuseControlBatchConsumption,
  AbuseControlConsumption,
  AbuseControlConsumptionInput,
  AbuseControlEntry,
  AbuseControlRepositoryPort,
} from "../contracts/abuseControl.js";
import type { AbuseControlBatchPort, AbuseControlPolicy, AbuseControlPort } from "../contracts/abuseControl.js";

export interface AbuseControlResult {
  enforced: boolean;
  retryAfterSeconds?: number;
  entry: AbuseControlEntry;
}

export class AbuseControlService implements AbuseControlPort, AbuseControlBatchPort {
  constructor(private readonly repository: AbuseControlRepositoryPort) {}

  async enforce(policy: AbuseControlPolicy): Promise<AbuseControlResult> {
    try {
      const input = this.toConsumptionInput(policy, policy.now ?? new Date());
      const result = await this.repository.consume(input);
      void this.repository.deleteExpired(input.now).catch(() => undefined);
      return this.presentConsumption(result, input.now);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw serviceUnavailable("Abuse control enforcement is unavailable");
    }
  }

  async enforceBatch(policies: readonly AbuseControlPolicy[]): Promise<AbuseControlResult[]> {
    if (policies.length === 0) {
      return [];
    }

    const now = new Date();
    const inputs = policies.map((policy) => this.toConsumptionInput(policy, policy.now ?? now));
    try {
      const batch = await this.repository.consumeBatch(inputs);
      this.throwIfRejected(batch, inputs);
      void this.repository.deleteExpired(now).catch(() => undefined);
      return batch.entries.map((entry, index) => this.presentConsumption(entry, inputs[index].now));
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
    const rejectedInput = inputs.find((input) =>
      input.scope === batch.rejected!.entry.scope && input.subjectKey === batch.rejected!.entry.subjectKey,
    );
    this.presentConsumption(batch.rejected, rejectedInput?.now ?? new Date());
  }

  private presentConsumption(consumption: AbuseControlConsumption, now: Date): AbuseControlResult {
    if (consumption.blocked && consumption.entry.blockedUntil) {
      throw tooManyRequests("Rate limit exceeded. Please wait before trying again.", {
        retryAfterSeconds: this.retryAfterSeconds(consumption.entry.blockedUntil, now),
      });
    }
    return { enforced: false, entry: consumption.entry };
  }

  private retryAfterSeconds(blockedUntil: Date, now: Date): number {
    return Math.max(1, Math.ceil((blockedUntil.getTime() - now.getTime()) / 1000));
  }
}
