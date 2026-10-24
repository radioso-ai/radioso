import type { Kysely } from "kysely";

import { AuditEventRetention } from "../../db/repositories/auditEventRepository.js";
import { ConversationSummaryRetention } from "../../db/repositories/conversationSummaryRepository.js";
import { RoutineStateRetention } from "../../db/repositories/routineStateRepository.js";
import { WorkspacePrivacySettingsRepository } from "../../db/repositories/workspacePrivacySettingsRepository.js";
import { EmailRawMimeRetention } from "../../modules/emailChannel/public.js";
import {
  ConversationRetentionSweep,
  type ConversationRetentionBudget,
  type InactiveConversationErasure,
} from "../../modules/privacy/public.js";
import type { ConversationDataRetentionRule } from "../../shared/domain/conversationDataRetention.js";
import type { DB } from "../../shared/infra/kysely/types.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import type { ApplicationPeriodicTaskHandle } from "./applicationModule.js";

type ConversationDataRetentionRuleBinding = (db: Kysely<DB>) => ConversationDataRetentionRule;

/**
 * Every module's fixed retention window over conversation-derived rows that outlive their
 * conversation's own window. A module that keeps a copy of conversation content with a shorter life
 * than the conversation registers its rule here.
 */
const defaultConversationDataRetentionRules: readonly ConversationDataRetentionRuleBinding[] = [
  (db) => new ConversationSummaryRetention(db),
  (db) => new RoutineStateRetention(db),
  (db) => new EmailRawMimeRetention(db),
  (db) => new AuditEventRetention(db),
];

/** The registration id the worker task route runs it by, and the Cloud Scheduler job names. */
const CONVERSATION_RETENTION_TASK_ID = "conversation-retention";
/** The poll worker's cadence; the Cloud Scheduler job in `infra/terraform/scheduler.tf` matches it. */
const CONVERSATION_RETENTION_INTERVAL_MS = 15 * 60 * 1_000;

export const createConversationRetentionSweep = (deps: {
  db: Kysely<DB>;
  erasure: InactiveConversationErasure;
  logger: Pick<AppLogger, "info" | "warn">;
  metrics: Pick<MetricsRegistry, "incrementCounter"> | null;
  rules?: readonly ConversationDataRetentionRuleBinding[];
  clock?: () => Date;
  budget?: Partial<ConversationRetentionBudget>;
}): ConversationRetentionSweep => new ConversationRetentionSweep({
  policies: new WorkspacePrivacySettingsRepository(deps.db),
  erasure: deps.erasure,
  rules: (deps.rules ?? defaultConversationDataRetentionRules).map((bind) => bind(deps.db)),
  clock: deps.clock ?? (() => new Date()),
  logger: deps.logger,
  metrics: deps.metrics,
  ...(deps.budget ? { budget: deps.budget } : {}),
});

/**
 * The sweep as a periodic task: the poll worker runs it on its interval, and the push worker's
 * `/internal/tasks/periodic-tasks/:taskId/run` route runs it when Cloud Scheduler calls. A run with a
 * failed batch rejects, so the scheduled call is reported as failed instead of as done.
 */
export const conversationRetentionPeriodicTask = (sweep: Pick<ConversationRetentionSweep, "run">): {
  id: string;
  intervalMs: number;
  handle: ApplicationPeriodicTaskHandle;
} => ({
  id: CONVERSATION_RETENTION_TASK_ID,
  intervalMs: CONVERSATION_RETENTION_INTERVAL_MS,
  handle: {
    run: async () => {
      const result = await sweep.run();
      if (result.failed > 0) {
        throw new Error(`Conversation retention sweep left ${result.failed} failed batch(es) for the next run`);
      }
    },
  },
});
