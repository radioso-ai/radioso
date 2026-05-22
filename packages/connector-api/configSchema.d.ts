/**
 * Supported field types for connector configuration schemas.
 * The frontend renders each type with the appropriate UI control.
 */
/**
 * - `secret`: user-supplied credential (encrypted at rest, masked on read).
 * - `generated_secret`: connector-issued credential (encrypted at rest, returned
 *   in plaintext so the user can copy it into the upstream system; auto-filled
 *   by the registry on first read when missing).
 */
export type ConfigFieldType = "text" | "secret" | "generated_secret" | "toggle" | "select";

/**
 * A single configuration field declared by a connector plugin.
 */
export interface ConfigFieldDefinition {
  /** Machine-readable key used in the config JSON (e.g. "phone_number_id"). */
  key: string;

  /** Human-readable label shown in the form (e.g. "Phone Number ID"). */
  label: string;

  /** Optional help text shown below the field. */
  helpText?: string;

  /** Optional placeholder shown in the rendered form control. */
  placeholder?: string;

  /** Field type determines the rendered UI control. */
  type: ConfigFieldType;

  /** Whether the field must be filled before enabling the connector. */
  required: boolean;

  /** Default value. Used when no saved value exists. */
  defaultValue?: string;

  /** For "select" fields: the available options. */
  options?: Array<{ value: string; label: string }>;
}

/**
 * Persisted connector configuration for one workspace.
 */
export interface ConnectorConfigRecord {
  id: string;
  workspaceId: string;
  connectorId: string;
  enabled: boolean;
  configData: Record<string, string>;
  errorStatus: string | null;
  createdAt: Date;
  updatedAt: Date;
}
