import type { AuditService, HumanContactSettingsRow } from "./humanContactTypes.js";
import {
  generateSecret,
  mapSettings,
  normalizeOptionalText,
  queryRows,
} from "./humanContactTypes.js";
import type { UsageLimitDatabasePort } from "../radiosoModuleTypes.js";

export class HumanContactSettingsService {
  constructor(private readonly input: {
    database: UsageLimitDatabasePort;
    auditService: AuditService;
  }) {}

  async getAvailability(input: { workspaceId: string }) {
    const settings = await this.findSettings(input.workspaceId);
    return {
      enabled: settings.enabled,
      configured: settings.configured,
    };
  }

  async getSettings(input: { workspaceId: string; accountId?: string | null }) {
    return this.findSettings(input.workspaceId);
  }

  async updateSettings(input: {
    workspaceId: string;
    accountId?: string | null;
    enabled: boolean;
    emailEnabled?: boolean;
    defaultEmail?: string | null;
    webhookEnabled?: boolean;
    webhookUrl?: string | null;
    signingSecret?: string | null;
    rotateSigningSecret?: boolean;
  }) {
    const existing = await this.findSettingsRow(input.workspaceId);
    const emailEnabled = input.emailEnabled ?? existing?.email_enabled ?? false;
    const defaultEmail = input.defaultEmail !== undefined
      ? normalizeOptionalText(input.defaultEmail)
      : existing?.default_email ?? null;
    const webhookEnabled = input.webhookEnabled ?? existing?.webhook_enabled ?? false;
    const webhookUrl = input.webhookUrl !== undefined
      ? normalizeOptionalText(input.webhookUrl)
      : existing?.webhook_url ?? null;
    const signingSecret = input.signingSecret !== undefined
      ? normalizeOptionalText(input.signingSecret)
      : input.rotateSigningSecret
        ? generateSecret()
        : webhookEnabled && webhookUrl && !existing?.signing_secret
          ? generateSecret()
          : existing?.signing_secret ?? null;

    const [row] = await queryRows<HumanContactSettingsRow>(
      this.input.database,
      `INSERT INTO ee_contact_settings (
         workspace_id,
         enabled,
         email_enabled,
         default_email,
         webhook_enabled,
         webhook_url,
         signing_secret
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (workspace_id)
       DO UPDATE SET
         enabled = EXCLUDED.enabled,
         email_enabled = EXCLUDED.email_enabled,
         default_email = EXCLUDED.default_email,
         webhook_enabled = EXCLUDED.webhook_enabled,
         webhook_url = EXCLUDED.webhook_url,
         signing_secret = EXCLUDED.signing_secret,
         updated_at = NOW()
       RETURNING workspace_id, enabled, email_enabled, default_email, webhook_enabled, webhook_url, signing_secret, updated_at`,
      [input.workspaceId, input.enabled, emailEnabled, defaultEmail, webhookEnabled, webhookUrl, signingSecret],
    );

    await this.input.auditService.record({
      workspaceId: input.workspaceId,
      eventType: "human_contact.settings_updated",
      eventStatus: "success",
      metadata: {
        enabled: input.enabled,
        emailConfigured: emailEnabled && Boolean(defaultEmail),
        webhookConfigured: webhookEnabled && Boolean(webhookUrl),
        signingSecretConfigured: Boolean(signingSecret),
        secretRotated: Boolean(input.rotateSigningSecret || input.signingSecret),
      },
    });

    return mapSettings(row);
  }

  async revealSigningSecret(input: { workspaceId: string }) {
    const row = await this.findSettingsRow(input.workspaceId);
    return {
      signingSecret: row?.signing_secret ?? null,
    };
  }

  async findSettingsRow(workspaceId: string): Promise<HumanContactSettingsRow | null> {
    const [row] = await queryRows<HumanContactSettingsRow>(
      this.input.database,
      `SELECT workspace_id, enabled, email_enabled, default_email, webhook_enabled, webhook_url, signing_secret, updated_at
       FROM ee_contact_settings
       WHERE workspace_id = $1`,
      [workspaceId],
    );
    return row ?? null;
  }

  async findSettings(workspaceId: string) {
    return mapSettings(await this.findSettingsRow(workspaceId));
  }

  async requireConfigured(workspaceId: string): Promise<HumanContactSettingsRow> {
    const row = await this.findSettingsRow(workspaceId);
    const hasEmailDelivery = Boolean(row?.email_enabled && row.default_email);
    const hasWebhookDelivery = Boolean(row?.webhook_enabled && row.webhook_url && row.signing_secret);
    if (!row?.enabled || (!hasEmailDelivery && !hasWebhookDelivery)) {
      throw {
        statusCode: 503,
        code: "service_unavailable",
        message: "Contact handoff is not available for this workspace.",
      };
    }
    return row;
  }
}
