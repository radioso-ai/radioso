import { randomUUID } from "node:crypto";

import { AppError } from "../../shared/domain/errors.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import type { AgentBundleAgentWriterPort, AgentBundleImportRepositoryPort } from "./ports.js";

export const AGENT_BUNDLE_IMPORT_ORPHAN_AGE_MS_DEFAULT = 15 * 60 * 1_000;
export const AGENT_BUNDLE_IMPORT_CLEANUP_LEASE_MS_DEFAULT = 5 * 60 * 1_000;
const SWEEP_INTERVAL_MS_DEFAULT = 5 * 60 * 1_000;
const SWEEP_BATCH_SIZE_DEFAULT = 20;

export interface AgentBundleImportCleanupAuditPort {
  record(event: {
    workspaceId: string;
    accountId?: string | null;
    eventType: string;
    eventStatus: "success" | "failure";
    metadata: Record<string, unknown>;
  }): Promise<unknown>;
}

export interface AgentBundleImportCleanupLoggerPort {
  info(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
}

export interface AgentBundleImportCleanupWorkerOptions {
  imports: AgentBundleImportRepositoryPort;
  agents: AgentBundleAgentWriterPort;
  audit: AgentBundleImportCleanupAuditPort;
  logger: AgentBundleImportCleanupLoggerPort;
  orphanAgeMs: number;
  cleanupLeaseMs?: number;
  batchSize?: number;
  intervalMs?: number;
  metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
}

export class AgentBundleImportCleanupWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(private readonly options: AgentBundleImportCleanupWorkerOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sweep(); }, this.options.intervalMs ?? SWEEP_INTERVAL_MS_DEFAULT);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(): Promise<{ status: "swept" | "skipped" | "failed"; compensated: number; failed: number }> {
    if (this.sweeping) return { status: "skipped", compensated: 0, failed: 0 };
    this.sweeping = true;
    try {
      const leaseToken = randomUUID();
      const jobs = await this.options.imports.claimStaleApplying({
        ageSeconds: Math.ceil(this.options.orphanAgeMs / 1_000),
        leaseSeconds: Math.ceil((this.options.cleanupLeaseMs ?? AGENT_BUNDLE_IMPORT_CLEANUP_LEASE_MS_DEFAULT) / 1_000),
        leaseToken,
        limit: this.options.batchSize ?? SWEEP_BATCH_SIZE_DEFAULT,
      });
      let compensated = 0;
      let failed = 0;
      for (const job of jobs) {
        if (!job.agentId) {
          await this.options.imports.markFailed(job.id, "apply_failed", { terminal: true, leaseToken });
          this.options.metrics?.incrementCounter("agent_bundle_import_compensations_total", {
            help: "Agent bundle import orphans compensated by the cleanup sweep",
            labels: { outcome: "abandoned" },
          });
          this.options.logger.info({ workspaceId: job.workspaceId, importId: job.id }, "agent bundle import abandoned before agent creation");
          continue;
        }
        try {
          await this.options.agents.delete(job.workspaceId, job.agentId);
          const compensatedNow = await this.options.imports.markCompensated(job.id, leaseToken);
          if (!compensatedNow) continue;
          compensated += 1;
          this.options.metrics?.incrementCounter("agent_bundle_import_compensations_total", {
            help: "Agent bundle import orphans compensated by the cleanup sweep",
            labels: { outcome: "compensated" },
          });
          this.options.logger.info({ workspaceId: job.workspaceId, importId: job.id, agentId: job.agentId }, "agent bundle import orphan compensated");
          await this.options.audit.record({
            workspaceId: job.workspaceId,
            accountId: job.actorAccountId,
            eventType: "agent.bundle.import.compensated",
            eventStatus: "success",
            metadata: { importId: job.id, agentId: job.agentId, principalType: "system" },
          });
        } catch (error) {
          if (isNotFound(error)) {
            const compensatedNow = await this.options.imports.markCompensated(job.id, leaseToken);
            if (compensatedNow) compensated += 1;
            continue;
          }
          failed += 1;
          this.options.metrics?.incrementCounter("agent_bundle_import_compensations_total", {
            help: "Agent bundle import orphans compensated by the cleanup sweep",
            labels: { outcome: "failed" },
          });
          this.options.logger.error({ workspaceId: job.workspaceId, importId: job.id, agentId: job.agentId }, "agent bundle import orphan cleanup failed");
        }
      }
      return { status: "swept", compensated, failed };
    } catch (error) {
      this.options.logger.error({ reason: errorReason(error) }, "agent bundle import cleanup sweep failed");
      this.options.metrics?.incrementCounter("agent_bundle_import_compensations_total", {
        help: "Agent bundle import orphans compensated by the cleanup sweep",
        labels: { outcome: "sweep_failed" },
      });
      return { status: "failed", compensated: 0, failed: 0 };
    } finally {
      this.sweeping = false;
    }
  }
}

const isNotFound = (error: unknown): boolean =>
  error instanceof AppError && error.code === "not_found";

const errorReason = (error: unknown): string =>
  error instanceof AppError
    ? error.code
    : error instanceof Error
      ? error.message
      : "unknown";
