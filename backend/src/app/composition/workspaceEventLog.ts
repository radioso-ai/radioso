import type { Kysely } from "kysely";

import {
  postgresWorkspaceEventRecorder,
  WorkspaceEventLogRepository,
} from "../../db/repositories/workspaceEventLogRepository.js";
import type { ConversationActivityRecorder } from "../../modules/conversationActivity/contracts/index.js";
import { publishingWorkspaceEvents } from "../../modules/conversationActivity/public.js";
import { WorkspaceEventLog } from "../../modules/workspaceEventLog/public.js";
import type { WorkspaceEventRecorder } from "../../shared/domain/workspaceEventLog.js";
import type { DB } from "../../shared/infra/kysely/types.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";

/**
 * The workspace event log's one seam (#1851). Every module that records an event is handed this
 * recorder by the composition or builder that constructs it: conversation creation, the chat turn's
 * persistence, the notify outbox, Slack's conversation links, and the activity bridge below. Nothing
 * else imports the Postgres recorder, so a change to how events are written (a delivery wake, say)
 * lands here once.
 */
export const workspaceEventRecorder: WorkspaceEventRecorder = postgresWorkspaceEventRecorder;

/** An activity recorder that also records the workspace events its activity stands for (a handoff). */
export const withWorkspaceEvents = (activity: ConversationActivityRecorder): ConversationActivityRecorder =>
  publishingWorkspaceEvents(activity, workspaceEventRecorder);

/** The log's read side over Postgres. */
export const buildWorkspaceEventLog = (
  db: Kysely<DB>,
  metrics: Pick<MetricsRegistry, "incrementCounter"> | null,
): WorkspaceEventLog => new WorkspaceEventLog({ store: new WorkspaceEventLogRepository(db), metrics });
