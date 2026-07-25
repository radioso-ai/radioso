/**
 * WordPress connector plugin.
 *
 * Surfaces:
 *   - Settings form (declarative schema) for site URL, auth, webhook secret,
 *     post types, and optional polling interval.
 *   - Webhook receiver at /api/connectors/wordpress/:workspaceId/webhook for
 *     companion-plugin push on publish/update/delete.
 *   - Background polling loop for workspaces with poll_interval_sec > 0.
 *   - One-shot backfill triggered automatically the first time the poll loop
 *     sees a workspace without a backfill_completed_at timestamp.
 */

import type {
  ConfigFieldDefinition,
  ConnectorContext,
  ConnectorPlugin,
  ConnectorValidationIssue,
} from "@radioso/connector-api";

import { connectorKyselyDb } from "../../services/connectorKyselyDb.js";
import { createWordpressWebhookRouter } from "./wordpressWebhookRouter.js";
import {
  requestBackfill,
  runBackfillWithErrorStatus,
  startPollingLoop,
  stopPollingLoop,
  type WordpressSyncDeps,
} from "./wordpressSyncService.js";
import { wordpressSourceFor } from "./wordpressSource.js";

export const WP_CONFIG_KEYS = {
  siteUrl: "site_url",
  username: "wp_username",
  applicationPassword: "wp_application_password",
  webhookSecret: "webhook_shared_secret",
  postTypes: "post_types",
  pollIntervalSec: "poll_interval_sec",
} as const;

export class WordpressConnector implements ConnectorPlugin {
  readonly id = "wordpress";
  readonly name = "WordPress";
  readonly description =
    "Auto-ingest WordPress pages and posts when they are published, updated, or deleted.";

  private syncDeps: WordpressSyncDeps | null = null;

  configSchema(): ConfigFieldDefinition[] {
    return [
      {
        key: WP_CONFIG_KEYS.siteUrl,
        label: "WordPress site URL",
        helpText: "The site you want Radioso to sync, e.g. https://example.com.",
        placeholder: "https://example.com",
        type: "text",
        required: true,
      },
      {
        key: WP_CONFIG_KEYS.webhookSecret,
        label: "Webhook shared secret",
        helpText:
          "Radioso generated this. Paste it into the Radioso Sync settings inside WordPress so the plugin can prove updates come from your site.",
        type: "generated_secret",
        required: true,
      },
      {
        key: WP_CONFIG_KEYS.username,
        label: "WordPress username",
        helpText: "Only required if you can't install the companion plugin and want Radioso to poll the REST API instead.",
        type: "text",
        required: false,
      },
      {
        key: WP_CONFIG_KEYS.applicationPassword,
        label: "Application password",
        helpText: "Generate one at Users → Profile → Application Passwords inside WordPress. Leave blank if you use the companion plugin.",
        type: "secret",
        required: false,
      },
      {
        key: WP_CONFIG_KEYS.postTypes,
        label: "Post types to sync",
        helpText: "Comma-separated WordPress post types. Defaults to page and post.",
        type: "text",
        required: false,
        defaultValue: "page,post",
      },
      {
        key: WP_CONFIG_KEYS.pollIntervalSec,
        label: "Polling interval (seconds)",
        helpText:
          "0 means no polling — Radioso relies on the companion plugin to push changes. Set a value (e.g. 300) if you supplied an application password and want Radioso to poll WordPress instead.",
        type: "text",
        required: false,
        defaultValue: "0",
      },
    ];
  }

  async migrate(): Promise<void> {
    // Sync state lives in the shared `connector_sync_state` table created by
    // migration 055; no connector-specific schema needed.
  }

  async initialize(context: ConnectorContext): Promise<void> {
    this.syncDeps = {
      logger: context.logger,
      db: connectorKyselyDb(context.db),
      state: context.state,
      ingestion: context.ingestion,
    };

    context.http.mount(
      "/:workspaceId/webhook",
      createWordpressWebhookRouter({
        logger: context.logger,
        state: context.state,
        ingestion: context.ingestion,
      }),
    );

    startPollingLoop(this.syncDeps);
  }

  async shutdown(): Promise<void> {
    stopPollingLoop();
    this.syncDeps = null;
  }

  getWebhookPath(): string {
    return "/api/connectors/wordpress/:workspaceId/webhook";
  }

  uniqueChannelField(): string | null {
    return WP_CONFIG_KEYS.siteUrl;
  }

  rotateGeneratedSecretsOnUniqueChannelChange(): boolean {
    return true;
  }

  validateConfig(config: Record<string, string>): ConnectorValidationIssue[] {
    const issues: ConnectorValidationIssue[] = [];
    const siteUrl = config[WP_CONFIG_KEYS.siteUrl];
    if (siteUrl && !/^https?:\/\//i.test(siteUrl)) {
      issues.push({
        key: WP_CONFIG_KEYS.siteUrl,
        message: "Must start with http:// or https://",
      });
    }

    const username = config[WP_CONFIG_KEYS.username];
    const appPassword = config[WP_CONFIG_KEYS.applicationPassword];
    // REST credentials must travel together: a username with no password (or
    // vice-versa) is never a valid call.
    if (username && !appPassword) {
      issues.push({
        key: WP_CONFIG_KEYS.applicationPassword,
        message: "Application password is required when a WordPress username is set",
      });
    }
    if (appPassword && !username) {
      issues.push({
        key: WP_CONFIG_KEYS.username,
        message: "WordPress username is required when an application password is set",
      });
    }

    const pollRaw = config[WP_CONFIG_KEYS.pollIntervalSec];
    let pollSeconds = 0;
    if (pollRaw !== undefined && pollRaw !== "") {
      const poll = Number(pollRaw);
      if (!Number.isFinite(poll) || poll < 0 || !Number.isInteger(poll)) {
        issues.push({
          key: WP_CONFIG_KEYS.pollIntervalSec,
          message: "Must be a non-negative integer (seconds)",
        });
      } else {
        pollSeconds = poll;
      }
    }

    if (pollSeconds > 0) {
      if (!username) {
        issues.push({
          key: WP_CONFIG_KEYS.username,
          message: "WordPress username is required when polling is enabled",
        });
      }
      if (!appPassword) {
        issues.push({
          key: WP_CONFIG_KEYS.applicationPassword,
          message: "Application password is required when polling is enabled",
        });
      }
    }

    return issues;
  }

  /** Exposed for an admin "Backfill now" action; safe to call repeatedly. */
  async backfillNow(workspaceId: string): Promise<{ ingested: number }> {
    return this.runBackfillWithStatus(workspaceId, { force: true });
  }

  private async runBackfillWithStatus(
    workspaceId: string,
    options?: { force?: boolean; lockToken?: string },
  ): Promise<{ ingested: number; alreadyRunning?: boolean }> {
    if (!this.syncDeps) {
      throw new Error("WordPress connector is not initialized");
    }
    const deps = this.syncDeps;
    return runBackfillWithErrorStatus(deps, workspaceId, options);
  }

  async syncNow({ workspaceId }: { workspaceId: string }): Promise<{ accepted: boolean; alreadyRunning?: boolean }> {
    if (!this.syncDeps) {
      throw new Error("WordPress connector is not initialized");
    }
    const deps = this.syncDeps;
    return requestBackfill(deps, workspaceId);
  }

  /**
   * On enable: register the source row so the user sees the channel in Sources
   * immediately, then kick off a one-shot backfill in the background. The
   * WordPress REST API is publicly readable by default, so backfill works on
   * most sites even without an application password; for private sites it
   * fails harmlessly and the connector still receives webhook events for new
   * edits going forward.
   */
  async onEnable({ workspaceId }: { workspaceId: string }): Promise<void> {
    if (!this.syncDeps) return;
    const stored = await this.syncDeps.state.getConfig(workspaceId);
    if (!stored) return;
    const source = wordpressSourceFor(stored.config);
    if (!source) return;
    try {
      await this.syncDeps.ingestion.ensureSource({ workspaceId, source });
    } catch (error) {
      this.syncDeps.logger.error(
        {
          workspaceId,
          err: error instanceof Error ? error.message : String(error),
        },
        "wordpress connector failed to register source on enable",
      );
    }

    void this.runBackfillWithStatus(workspaceId).catch((error) => {
      const deps = this.syncDeps;
      if (!deps) return;
      deps.logger.warn(
        {
          workspaceId,
          err: error instanceof Error ? error.message : String(error),
        },
        "wordpress backfill on enable failed",
      );
    });
  }
}
