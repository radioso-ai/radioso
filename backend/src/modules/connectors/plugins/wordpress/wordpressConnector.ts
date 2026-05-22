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

import { createWordpressWebhookRouter } from "./wordpressWebhookRouter.js";
import {
  runBackfill,
  startPollingLoop,
  stopPollingLoop,
  type WordpressSyncDeps,
} from "./wordpressSyncService.js";

export const WP_CONFIG_KEYS = {
  siteUrl: "site_url",
  authMode: "auth_mode",
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
        helpText: "Root URL of the site, e.g. https://example.com",
        placeholder: "https://example.com",
        type: "text",
        required: true,
      },
      {
        key: WP_CONFIG_KEYS.authMode,
        label: "Authentication",
        type: "select",
        required: true,
        defaultValue: "application_password",
        options: [
          { value: "application_password", label: "Application Password (recommended)" },
          { value: "shared_secret", label: "Companion plugin only (no REST auth)" },
        ],
      },
      {
        key: WP_CONFIG_KEYS.username,
        label: "WordPress username",
        helpText: "Required for Application Password auth.",
        type: "text",
        required: false,
      },
      {
        key: WP_CONFIG_KEYS.applicationPassword,
        label: "Application password",
        helpText: "Generate at Users → Profile → Application Passwords on the WordPress site.",
        type: "secret",
        required: false,
      },
      {
        key: WP_CONFIG_KEYS.webhookSecret,
        label: "Webhook shared secret",
        helpText:
          "Paste this into the Radioso Sync settings of the companion WordPress plugin. Used to sign webhook payloads (HMAC-SHA256).",
        type: "secret",
        required: true,
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
        label: "Polling fallback (seconds)",
        helpText:
          "0 disables polling (use only the companion plugin). Otherwise the connector polls the REST API for changes every N seconds.",
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
      db: context.db,
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

  validateConfig(config: Record<string, string>): ConnectorValidationIssue[] {
    const issues: ConnectorValidationIssue[] = [];
    const siteUrl = config[WP_CONFIG_KEYS.siteUrl];
    if (siteUrl && !/^https?:\/\//i.test(siteUrl)) {
      issues.push({
        key: WP_CONFIG_KEYS.siteUrl,
        message: "Must start with http:// or https://",
      });
    }

    const authMode = config[WP_CONFIG_KEYS.authMode];
    if (authMode === "application_password") {
      if (!config[WP_CONFIG_KEYS.username]) {
        issues.push({
          key: WP_CONFIG_KEYS.username,
          message: "WordPress username is required for Application Password auth",
        });
      }
      if (!config[WP_CONFIG_KEYS.applicationPassword]) {
        issues.push({
          key: WP_CONFIG_KEYS.applicationPassword,
          message: "Application password is required for Application Password auth",
        });
      }
    }

    const pollRaw = config[WP_CONFIG_KEYS.pollIntervalSec];
    if (pollRaw !== undefined && pollRaw !== "") {
      const poll = Number(pollRaw);
      if (!Number.isFinite(poll) || poll < 0 || !Number.isInteger(poll)) {
        issues.push({
          key: WP_CONFIG_KEYS.pollIntervalSec,
          message: "Must be a non-negative integer (seconds)",
        });
      }
    }

    return issues;
  }

  /** Exposed for an admin "Backfill now" action; safe to call repeatedly. */
  async backfillNow(workspaceId: string): Promise<{ ingested: number }> {
    if (!this.syncDeps) {
      throw new Error("WordPress connector is not initialized");
    }
    return runBackfill(this.syncDeps, workspaceId);
  }
}
