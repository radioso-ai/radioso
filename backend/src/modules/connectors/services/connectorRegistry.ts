import type { Router } from "express";
import { Router as createRouter } from "express";

import type {
  ConnectorPlugin,
  ConnectorDatabasePort,
  ConnectorChatPort,
  ConnectorHttpHost,
  ConnectorLogger,
  ConnectorStatePort,
  ConnectorSummary,
  ConnectorDetail,
  ConnectorValidationIssue,
  ConfigFieldDefinition,
} from "@radioso/connector-api";
import { encryptField, decryptField, isEncryptedConnectorSecret, maskSecret } from "./configEncryption.js";

interface ConnectorSaveSuccess {
  kind: "success";
}

interface ConnectorValidationFailure {
  kind: "validation_error";
  issues: ConnectorValidationIssue[];
}

interface ConnectorConflictFailure {
  kind: "conflict";
  detail: string;
}

export type ConnectorMutationResult =
  | ConnectorSaveSuccess
  | ConnectorValidationFailure
  | ConnectorConflictFailure;

const SECRET_ENCRYPTION_REQUIRED_STATUS = "secret_encryption_required";
const SECRET_ROTATION_REQUIRED_STATUS = "secret_rotation_required";
const SECRET_REMEDIATION_PLACEHOLDER = "[re-enter secret]";

export class ConnectorRegistry {
  private readonly plugins = new Map<string, ConnectorPlugin>();
  private readonly router: Router;
  private encryptionKey: string | undefined;

  constructor() {
    this.router = createRouter();
  }

  getRouter(): Router {
    return this.router;
  }

  register(plugin: ConnectorPlugin): void {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`Connector "${plugin.id}" is already registered`);
    }
    this.plugins.set(plugin.id, plugin);
  }

  listPlugins(): Array<{ id: string; name: string; description: string }> {
    return [...this.plugins.values()].map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
    }));
  }

  getPlugin(id: string): ConnectorPlugin | undefined {
    return this.plugins.get(id);
  }

  async runMigrations(db: ConnectorDatabasePort): Promise<void> {
    for (const plugin of this.plugins.values()) {
      await plugin.migrate(db);
    }
  }

  async initializeAll(context: {
    db: ConnectorDatabasePort;
    logger: ConnectorLogger;
    chat: ConnectorChatPort;
  }): Promise<void> {
    for (const plugin of this.plugins.values()) {
      try {
        await plugin.initialize({
          db: context.db,
          logger: context.logger,
          chat: context.chat,
          state: this.createPluginState(context.db, plugin.id),
          http: this.createHttpHost(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        context.logger.error({ connectorId: plugin.id, err: message }, `Connector "${plugin.id}" failed to initialize`);
      }
    }
  }

  async shutdownAll(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      try {
        await plugin.shutdown();
      } catch {
        // Best-effort shutdown — log and continue
      }
    }
  }

  // ── Config persistence ──────────────────────────────────────────────

  setEncryptionKey(key: string): void {
    this.encryptionKey = key;
  }

  async listConnectors(db: ConnectorDatabasePort, workspaceId: string): Promise<ConnectorSummary[]> {
    const configs = await db.query<{
      connector_id: string;
      enabled: boolean;
      error_status: string | null;
    }>(
      `SELECT connector_id, enabled, error_status FROM connector_configs WHERE workspace_id = $1`,
      [workspaceId],
    );
    const configMap = new Map(configs.map((c) => [c.connector_id, c]));

    return [...this.plugins.values()].map((plugin) => {
      const config = configMap.get(plugin.id);
      return {
        id: plugin.id,
        name: plugin.name,
        description: plugin.description,
        enabled: config?.enabled ?? false,
        errorStatus: config?.error_status ?? null,
        webhookPath: plugin.getWebhookPath(),
      };
    });
  }

  async getConnectorDetail(
    db: ConnectorDatabasePort,
    workspaceId: string,
    connectorId: string,
  ): Promise<ConnectorDetail | null> {
    const plugin = this.plugins.get(connectorId);
    if (!plugin) return null;

    const rows = await db.query<{
      enabled: boolean;
      config_data: Record<string, string>;
      error_status: string | null;
    }>(
      `SELECT enabled, config_data, error_status FROM connector_configs WHERE workspace_id = $1 AND connector_id = $2`,
      [workspaceId, connectorId],
    );

    const row = rows[0];
    const schema = plugin.configSchema();

    let maskedConfig: Record<string, string> | null = {};
    let errorStatus = row?.error_status ?? null;
    if (row) {
      const secretStatus = this.describeSecretState(row.config_data, schema);
      maskedConfig = this.maskSecrets(row.config_data, schema);
      errorStatus = errorStatus ?? secretStatus;
    }

    return {
      id: plugin.id,
      name: plugin.name,
      description: plugin.description,
      enabled: row?.enabled ?? false,
      errorStatus,
      webhookPath: plugin.getWebhookPath(),
      configSchema: schema,
      config: maskedConfig,
    };
  }

  async saveConfig(
    db: ConnectorDatabasePort,
    workspaceId: string,
    connectorId: string,
    configData: Record<string, unknown>,
  ): Promise<ConnectorMutationResult> {
    const plugin = this.plugins.get(connectorId);
    if (!plugin) {
      return {
        kind: "validation_error",
        issues: [{ key: "connector", message: `Unknown connector: ${connectorId}` }],
      };
    }

    const schema = plugin.configSchema();
    const normalizedInput = this.normalizeConfigData(configData);
    const existingRow = await db.query<{
      config_data: Record<string, string>;
    }>(
      `SELECT config_data FROM connector_configs WHERE workspace_id = $1 AND connector_id = $2`,
      [workspaceId, connectorId],
    );
    const existingStoredConfig = existingRow[0]?.config_data ?? {};
    const existingSecretState = this.describeSecretState(existingStoredConfig, schema);
    const inputIssues = this.validateSecretWriteState(normalizedInput, schema);
    if (inputIssues.length > 0) {
      return { kind: "validation_error", issues: inputIssues };
    }

    if (
      existingSecretState === SECRET_ROTATION_REQUIRED_STATUS &&
      !this.canRemediateSecretRotation(normalizedInput, schema)
    ) {
      return {
        kind: "validation_error",
        issues: this.secretRemediationIssues(schema, SECRET_ROTATION_REQUIRED_STATUS),
      };
    }

    const existingPlainConfig = this.decryptSecrets(existingStoredConfig, schema);
    const mergedPlainConfig = {
      ...existingPlainConfig,
      ...normalizedInput,
    };

    const issues = this.validateConfig(plugin, schema, mergedPlainConfig, false);
    if (issues.length > 0) {
      return { kind: "validation_error", issues };
    }

    // Unique channel enforcement (FR-012)
    const uniqueField = plugin.uniqueChannelField();
    if (uniqueField && mergedPlainConfig[uniqueField]) {
      const conflicts = await db.query<{ workspace_id: string }>(
        `SELECT workspace_id FROM connector_configs
         WHERE connector_id = $1 AND enabled = true AND workspace_id != $2
           AND config_data->>$3 = $4`,
        [connectorId, workspaceId, uniqueField, mergedPlainConfig[uniqueField]],
      );
      if (conflicts.length > 0) {
        return {
          kind: "conflict",
          detail: `${this.labelForField(schema, uniqueField)} is already configured in another workspace.`,
        };
      }
    }

    const storedUpdates = this.encryptSecrets(normalizedInput, schema);
    const mergedStoredConfig = {
      ...existingStoredConfig,
      ...storedUpdates,
    };

    await db.query(
      `INSERT INTO connector_configs (workspace_id, connector_id, config_data, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (workspace_id, connector_id)
       DO UPDATE SET config_data = $3, error_status = NULL, updated_at = NOW()`,
      [workspaceId, connectorId, JSON.stringify(mergedStoredConfig)],
    );

    return { kind: "success" };
  }

  async enableConnector(
    db: ConnectorDatabasePort,
    workspaceId: string,
    connectorId: string,
  ): Promise<ConnectorMutationResult> {
    const plugin = this.plugins.get(connectorId);
    if (!plugin) {
      return {
        kind: "validation_error",
        issues: [{ key: "connector", message: `Unknown connector: ${connectorId}` }],
      };
    }

    const rows = await db.query<{ config_data: Record<string, string> }>(
      `SELECT config_data FROM connector_configs WHERE workspace_id = $1 AND connector_id = $2`,
      [workspaceId, connectorId],
    );

    if (rows.length === 0) {
      return {
        kind: "validation_error",
        issues: [{ key: "config", message: "Save configuration before enabling" }],
      };
    }

    const schema = plugin.configSchema();
    const storedConfig = rows[0].config_data;
    const secretState = this.describeSecretState(storedConfig, schema);
    if (secretState) {
      return {
        kind: "validation_error",
        issues: this.secretRemediationIssues(schema, secretState),
      };
    }
    const config = this.decryptSecrets(storedConfig, schema);
    const issues = this.validateConfig(plugin, schema, config, true);
    if (issues.length > 0) {
      return { kind: "validation_error", issues };
    }

    // Unique channel enforcement on enable
    const uniqueField = plugin.uniqueChannelField();
    if (uniqueField && config[uniqueField]) {
      const conflicts = await db.query<{ workspace_id: string }>(
        `SELECT workspace_id FROM connector_configs
         WHERE connector_id = $1 AND enabled = true AND workspace_id != $2
           AND config_data->>$3 = $4`,
        [connectorId, workspaceId, uniqueField, storedConfig[uniqueField] ?? config[uniqueField]],
      );
      if (conflicts.length > 0) {
        return {
          kind: "conflict",
          detail: `${this.labelForField(schema, uniqueField)} is already configured in another workspace.`,
        };
      }
    }

    await db.query(
      `UPDATE connector_configs SET enabled = true, error_status = NULL, updated_at = NOW()
       WHERE workspace_id = $1 AND connector_id = $2`,
      [workspaceId, connectorId],
    );

    return { kind: "success" };
  }

  async disableConnector(
    db: ConnectorDatabasePort,
    workspaceId: string,
    connectorId: string,
  ): Promise<void> {
    await db.query(
      `UPDATE connector_configs SET enabled = false, updated_at = NOW()
       WHERE workspace_id = $1 AND connector_id = $2`,
      [workspaceId, connectorId],
    );
  }

  async getDecryptedConfig(
    db: ConnectorDatabasePort,
    workspaceId: string,
    connectorId: string,
  ): Promise<{ enabled: boolean; config: Record<string, string> } | null> {
    const rows = await db.query<{
      enabled: boolean;
      config_data: Record<string, string>;
    }>(
      `SELECT enabled, config_data FROM connector_configs WHERE workspace_id = $1 AND connector_id = $2`,
      [workspaceId, connectorId],
    );

    if (rows.length === 0) return null;

    const plugin = this.plugins.get(connectorId);
    if (!plugin) return null;

    const schema = plugin.configSchema();
    const secretState = this.describeSecretState(rows[0].config_data, schema);
    if (secretState) {
      return null;
    }
    const decrypted = this.decryptSecrets(rows[0].config_data, schema);
    return { enabled: rows[0].enabled, config: decrypted };
  }

  async setErrorStatus(
    db: ConnectorDatabasePort,
    workspaceId: string,
    connectorId: string,
    errorStatus: string | null,
  ): Promise<void> {
    await db.query(
      `UPDATE connector_configs SET error_status = $3, updated_at = NOW()
       WHERE workspace_id = $1 AND connector_id = $2`,
      [workspaceId, connectorId, errorStatus],
    );
  }

  // ── Encryption helpers ──────────────────────────────────────────────

  private encryptSecrets(
    config: Record<string, string>,
    schema: ConfigFieldDefinition[],
  ): Record<string, string> {
    if (!this.encryptionKey) return config;

    const secretKeys = new Set(schema.filter((f) => f.type === "secret").map((f) => f.key));
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(config)) {
      result[key] = secretKeys.has(key) ? encryptField(value, this.encryptionKey) : value;
    }
    return result;
  }

  private decryptSecrets(
    config: Record<string, string>,
    schema: ConfigFieldDefinition[],
  ): Record<string, string> {
    if (!this.encryptionKey) return config;

    const secretKeys = new Set(schema.filter((f) => f.type === "secret").map((f) => f.key));
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(config)) {
      result[key] = secretKeys.has(key) ? this.tryDecryptValue(value) : value;
    }
    return result;
  }

  private maskSecrets(
    config: Record<string, string>,
    schema: ConfigFieldDefinition[],
  ): Record<string, string> {
    const secretKeys = new Set(schema.filter((f) => f.type === "secret").map((f) => f.key));
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(config)) {
      if (secretKeys.has(key)) {
        const decrypted = this.tryDecryptValue(value);
        result[key] = decrypted === null ? SECRET_REMEDIATION_PLACEHOLDER : maskSecret(decrypted);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  private tryDecryptValue(value: string): string | null {
    if (!this.encryptionKey) {
      return null;
    }
    try {
      return decryptField(value, this.encryptionKey);
    } catch {
      return null;
    }
  }

  private describeSecretState(
    config: Record<string, string>,
    schema: ConfigFieldDefinition[],
  ): string | null {
    const secretKeys = schema.filter((field) => field.type === "secret").map((field) => field.key);
    if (secretKeys.length === 0) {
      return null;
    }

    const secretValues = secretKeys
      .map((key) => config[key])
      .filter((value): value is string => typeof value === "string" && value.length > 0);

    if (secretValues.length === 0) {
      return null;
    }

    if (!this.encryptionKey) {
      return SECRET_ENCRYPTION_REQUIRED_STATUS;
    }

    return secretValues.every((value) => isEncryptedConnectorSecret(value, this.encryptionKey!))
      ? null
      : SECRET_ROTATION_REQUIRED_STATUS;
  }

  private validateSecretWriteState(
    config: Record<string, string>,
    schema: ConfigFieldDefinition[],
  ): ConnectorValidationIssue[] {
    const secretKeys = schema.filter((field) => field.type === "secret").map((field) => field.key);
    const providedSecretKeys = secretKeys.filter((key) => {
      const value = config[key];
      return typeof value === "string" && value.length > 0;
    });

    if (providedSecretKeys.length === 0) {
      return [];
    }

    if (!this.encryptionKey) {
      return providedSecretKeys.map((key) => ({
        key,
        message: "Connector secret encryption must be configured before saving secret fields",
      }));
    }

    return [];
  }

  private canRemediateSecretRotation(
    config: Record<string, string>,
    schema: ConfigFieldDefinition[],
  ): boolean {
    const secretKeys = schema.filter((field) => field.type === "secret").map((field) => field.key);
    return (
      secretKeys.length > 0 &&
      secretKeys.every((key) => {
        const value = config[key];
        return typeof value === "string" && value.trim().length > 0;
      })
    );
  }

  private secretRemediationIssues(
    schema: ConfigFieldDefinition[],
    state: string,
  ): ConnectorValidationIssue[] {
    const secretKeys = schema.filter((field) => field.type === "secret");
    const message =
      state === SECRET_ENCRYPTION_REQUIRED_STATUS
        ? "Connector secret encryption must be configured before this connector can use stored secret fields"
        : "Stored connector secrets require rotation before this connector can be used";

    return secretKeys.map((field) => ({
      key: field.key,
      message,
    }));
  }

  private normalizeConfigData(config: Record<string, unknown>): Record<string, string> {
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(config)) {
      if (value === null || value === undefined) {
        continue;
      }
      normalized[key] = typeof value === "string" ? value.trim() : String(value);
    }
    return normalized;
  }

  private validateConfig(
    plugin: ConnectorPlugin,
    schema: ConfigFieldDefinition[],
    config: Record<string, string>,
    requireAllFields: boolean,
  ): ConnectorValidationIssue[] {
    const issues: ConnectorValidationIssue[] = [];

    for (const field of schema) {
      const value = config[field.key];
      if (!value) {
        if (requireAllFields && field.required) {
          issues.push({
            key: field.key,
            message: `${field.label} is required`,
          });
        }
      }
    }

    issues.push(...plugin.validateConfig(config));
    return issues;
  }

  private labelForField(schema: ConfigFieldDefinition[], key: string): string {
    return schema.find((field) => field.key === key)?.label ?? key;
  }

  private createPluginState(db: ConnectorDatabasePort, connectorId: string): ConnectorStatePort {
    return {
      getConfig: async (workspaceId) => this.getDecryptedConfig(db, workspaceId, connectorId),
      setErrorStatus: async (workspaceId, errorStatus) =>
        this.setErrorStatus(db, workspaceId, connectorId, errorStatus),
    };
  }

  private createHttpHost(): ConnectorHttpHost {
    return {
      mount: (path, router) => {
        this.router.use(path, router);
      },
    };
  }
}
