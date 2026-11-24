import type { Kysely } from "kysely";

import { connectorEncryptionKeys, type Env } from "../config/env.js";
import { WorkspaceEventSubscriptionRepository } from "../../db/repositories/workspaceEventSubscriptionRepository.js";
import {
  postgresDocumentEventEraser,
  postgresWorkspaceEventRecorder,
  WorkspaceEventLogRepository,
} from "../../db/repositories/workspaceEventLogRepository.js";
import type { WorkspaceRepositoryPort } from "../../db/repositories/workspaceRepository.js";
import type { AccountAccessService } from "../../modules/account/public.js";
import type { AuditPort } from "../../modules/audit/contracts/index.js";
import type { ConversationActivityRecorder } from "../../modules/conversationActivity/contracts/index.js";
import { publishingWorkspaceEvents } from "../../modules/conversationActivity/public.js";
import type { ApiPrincipalAuthenticator } from "../../modules/machineAccess/public.js";
import { assertPublicWebsiteUrl } from "../../modules/websiteCrawler/urlPolicy.js";
import {
  connectorKeySealer,
  EventSubscriptionService,
  requestSubscriptionDrain,
  WorkspaceEventDeliveryDrain,
  WorkspaceEventDeliveryScheduler,
  WorkspaceEventLog,
  workspaceEventDeliveryJobHandler,
  type EventSubscriptionOwnerCheck,
} from "../../modules/workspaceEventLog/public.js";
import type { BackgroundJobHandlerRegistration, BackgroundJobQueue } from "../../shared/background-jobs/index.js";
import type { DocumentEventEraser, WorkspaceEventRecorder } from "../../shared/domain/workspaceEventLog.js";
import type { WorkspaceEventDeliveryWake } from "../../shared/domain/workspaceEventSubscriptions.js";
import { FetchWebhookHttpClient, type WebhookUrlGuard } from "../../shared/infra/http/signedWebhook.js";
import { assertPublicHttpTarget, fetchPublicUrl } from "../../shared/infra/http/publicUrlFetch.js";
import type { DB } from "../../shared/infra/kysely/types.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import type { ApplicationPeriodicTaskHandle } from "./applicationModule.js";

/**
 * The workspace event log's one seam (#1851). Every module that records an event is handed this
 * recorder by the composition or builder that constructs it: conversation creation, the chat turn's
 * persistence, the notify outbox, Slack's conversation links, and the activity bridge below. Nothing
 * else imports the Postgres recorder, so a change to how events are written lands here once.
 */
export const workspaceEventRecorder: WorkspaceEventRecorder = postgresWorkspaceEventRecorder;

/** What deleting documents hands their events to, in the deleting transaction. */
export const documentEventEraser: DocumentEventEraser = postgresDocumentEventEraser;

/** An activity recorder that also records the workspace events its activity stands for (a handoff). */
export const withWorkspaceEvents = (activity: ConversationActivityRecorder): ConversationActivityRecorder =>
  publishingWorkspaceEvents(activity, workspaceEventRecorder);

/** The log's read side over Postgres. */
export const buildWorkspaceEventLog = (
  db: Kysely<DB>,
  metrics: Pick<MetricsRegistry, "incrementCounter"> | null,
): WorkspaceEventLog => new WorkspaceEventLog({ store: new WorkspaceEventLogRepository(db), metrics });

/**
 * Whether a subscription's creator may still read what it subscribes to: a credential exactly as a
 * request presenting it would be checked (revoked, expired, its service account disabled, its owner
 * gone), then its role; a teammate by their live role on the workspace.
 */
const eventSubscriptionOwnerCheck = (deps: {
  credentials: Pick<ApiPrincipalAuthenticator, "principalForCredential">;
  access: Pick<AccountAccessService, "hasAllWorkspacePermissions">;
  workspaces: Pick<WorkspaceRepositoryPort, "findById">;
}): EventSubscriptionOwnerCheck => ({
  async permits({ workspaceId, createdBy, permissions }) {
    if (createdBy.kind === "teammate") {
      const workspace = createdBy.userId ? await deps.workspaces.findById(workspaceId) : null;
      return workspace !== null && createdBy.userId !== null && deps.access.hasAllWorkspacePermissions({
        accountId: workspace.accountId,
        userId: createdBy.userId,
        principal: { type: "session_user", userId: createdBy.userId },
        workspaceId,
        permissions,
      });
    }
    const resolved = createdBy.credentialId ? await deps.credentials.principalForCredential(createdBy.credentialId) : null;
    return resolved !== null && resolved.workspaceId === workspaceId && deps.access.hasAllWorkspacePermissions({
      accountId: resolved.accountId,
      principal: resolved.principal,
      workspaceId,
      permissions,
    });
  },
});

/** The registration id the worker task route runs the sweep by, and the Cloud Scheduler job's name. */
const WORKSPACE_EVENT_DELIVERY_TASK_ID = "workspace-event-delivery";
/** Every minute, matching `workspace_event_delivery` in `infra/terraform/scheduler.tf`. */
const WORKSPACE_EVENT_DELIVERY_INTERVAL_MS = 60_000;

/**
 * The outbound URL guard at every hop of a push: an http(s) URL whose host resolves only to public
 * addresses. It refuses with `PublicNetworkPolicyError`, and a host that does not resolve with its
 * `PublicHostUnresolvedError` subclass, so delivery tells a refused target from a resolver outage.
 * The DNS-pinned fetch checks the addresses it connects to again.
 */
const assertPublicDeliveryTarget: WebhookUrlGuard = (url) => assertPublicHttpTarget(url);

/**
 * Subscriptions and their delivery (#1852): the service the routes and Ray read through, the drain
 * job's handler, the periodic sweep that guarantees every due subscription is drained within a
 * minute, and the post-commit wake that drains a workspace's due subscriptions sooner once a change
 * that recorded events has committed (the chat turn's persistence and the document worker). A
 * target passes the website crawler's public-address check at create, and the public address rule
 * with the DNS-pinned fetch webhook skills use at every hop of every push; plain http to this
 * machine only where `WEBHOOK_DESTINATIONS_ALLOW_HTTP_LOOPBACK` allows it outside production.
 */
export const buildWorkspaceEventDelivery = (input: {
  infrastructure: {
    database: { kysely: Kysely<DB> };
    auditService: Pick<AuditPort, "record">;
    metricsRegistry: Pick<MetricsRegistry, "incrementCounter" | "observeHistogram"> | null;
  };
  env: Pick<Env, "CONNECTOR_ENCRYPTION_KEY" | "CONNECTOR_ENCRYPTION_PREVIOUS_KEYS" | "NODE_ENV" | "WEBHOOK_DESTINATIONS_ALLOW_HTTP_LOOPBACK">;
  queue: Pick<BackgroundJobQueue, "enqueue">;
  access: {
    apiPrincipalAuthenticator: Pick<ApiPrincipalAuthenticator, "principalForCredential">;
    accountAccessService: Pick<AccountAccessService, "hasAllWorkspacePermissions">;
  };
  workspaces: Pick<WorkspaceRepositoryPort, "findById">;
  logger: Pick<AppLogger, "warn" | "info">;
  /** The outbound URL guard at create; the website crawler's public-address check unless a test supplies one. */
  assertPublicUrl?: WebhookUrlGuard;
}): {
  subscriptions: EventSubscriptionService;
  jobHandler: BackgroundJobHandlerRegistration;
  periodicTask: { id: string; intervalMs: number; handle: ApplicationPeriodicTaskHandle };
  wake: WorkspaceEventDeliveryWake;
} => {
  const db = input.infrastructure.database.kysely;
  const store = new WorkspaceEventSubscriptionRepository(db);
  const sealer = connectorKeySealer(connectorEncryptionKeys(input.env));
  const assertPublicUrl = input.assertPublicUrl ?? assertPublicWebsiteUrl;
  const allowHttpLoopback = input.env.NODE_ENV !== "production" && input.env.WEBHOOK_DESTINATIONS_ALLOW_HTTP_LOOPBACK === true;
  const audit = input.infrastructure.auditService;
  const drain = new WorkspaceEventDeliveryDrain({
    subscriptions: store,
    log: new WorkspaceEventLogRepository(db),
    owners: eventSubscriptionOwnerCheck({
      credentials: input.access.apiPrincipalAuthenticator,
      access: input.access.accountAccessService,
      workspaces: input.workspaces,
    }),
    client: new FetchWebhookHttpClient(assertPublicDeliveryTarget, { allowHttpLoopback, fetchImpl: fetchPublicUrl }),
    sealer,
    requeue: (target) => requestSubscriptionDrain(input.queue, target),
    audit,
    metrics: input.infrastructure.metricsRegistry,
    logger: input.logger,
  });
  const scheduler = new WorkspaceEventDeliveryScheduler({ subscriptions: store, queue: input.queue, logger: input.logger });
  return {
    subscriptions: new EventSubscriptionService({ store, sealer, audit, assertPublicUrl, allowHttpLoopback }),
    jobHandler: workspaceEventDeliveryJobHandler(drain),
    periodicTask: {
      id: WORKSPACE_EVENT_DELIVERY_TASK_ID,
      intervalMs: WORKSPACE_EVENT_DELIVERY_INTERVAL_MS,
      handle: { run: async () => { await scheduler.sweep(); } },
    },
    wake: scheduler,
  };
};
