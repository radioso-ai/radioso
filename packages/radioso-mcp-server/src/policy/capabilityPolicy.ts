export type CapabilityAccessMode = "read" | "write";

export interface CapabilityDefinition {
  accessMode: CapabilityAccessMode;
  enabled: boolean;
  name: string;
  requiresApproval: boolean;
}

export interface CapabilityPolicyConfig {
  allowedReadTools: string[];
  allowedWriteTools: string[];
  approvalRequiredWriteTools: string[];
}

export interface RequestedToolResolution {
  approvalRequiredTools: string[];
  deniedTools: string[];
  grantedTools: string[];
}

export class CapabilityPolicyError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "CapabilityPolicyError";
  }
}

export const TOOL_CATALOG: Record<string, { accessMode: CapabilityAccessMode }> = {
  answer_grounded: { accessMode: "read" },
  chat_with_assistant: { accessMode: "read" },
  create_document: { accessMode: "write" },
  delete_document: { accessMode: "write" },
  describe_capabilities: { accessMode: "read" },
  get_document: { accessMode: "read" },
  get_retrieval_settings: { accessMode: "read" },
  list_documents: { accessMode: "read" },
  reprocess_document: { accessMode: "write" },
  search_documents: { accessMode: "read" },
  update_document: { accessMode: "write" },
  update_retrieval_settings: { accessMode: "write" },
};

export const DEFAULT_ALLOWED_READ_TOOLS = Object.keys(TOOL_CATALOG).filter(
  (toolName) => TOOL_CATALOG[toolName].accessMode === "read",
);
export const DEFAULT_ALLOWED_WRITE_TOOLS = Object.keys(TOOL_CATALOG).filter(
  (toolName) => TOOL_CATALOG[toolName].accessMode === "write",
);
export const DEFAULT_APPROVAL_REQUIRED_WRITE_TOOLS = [...DEFAULT_ALLOWED_WRITE_TOOLS];

const unique = (values: string[]): string[] => [...new Set(values)];

const validateConfiguredTools = (allowedTools: string[]): void => {
  const unknownTools = allowedTools.filter((tool) => !(tool in TOOL_CATALOG));
  if (unknownTools.length > 0) {
    throw new CapabilityPolicyError(
      `Unknown tool names in policy configuration: ${unknownTools.join(", ")}`,
      "invalid_policy_configuration",
      { unknownTools },
    );
  }
};

export interface CapabilityPolicyRegistry {
  configuredTools(): string[];
  isToolAllowed(toolName: string): boolean;
  listCapabilities(): CapabilityDefinition[];
  requiresApproval(toolName: string): boolean;
  resolveApprovalTools(requestedTools: string[], grantedSessionTools?: string[]): RequestedToolResolution;
  resolveRequestedTools(requestedTools: string[]): RequestedToolResolution;
  toolDefinition(toolName: string): CapabilityDefinition | null;
}

export const createCapabilityPolicyRegistry = (config: CapabilityPolicyConfig): CapabilityPolicyRegistry => {
  validateConfiguredTools(config.allowedReadTools);
  validateConfiguredTools(config.allowedWriteTools);
  validateConfiguredTools(config.approvalRequiredWriteTools);

  const allowedReadTools = new Set(config.allowedReadTools);
  const allowedWriteTools = new Set(config.allowedWriteTools);
  const approvalRequiredWriteTools = new Set(config.approvalRequiredWriteTools);

  const toolDefinition = (toolName: string): CapabilityDefinition | null => {
    const catalogEntry = TOOL_CATALOG[toolName];
    if (!catalogEntry) {
      return null;
    }

    const enabled = catalogEntry.accessMode === "read" ? allowedReadTools.has(toolName) : allowedWriteTools.has(toolName);
    return {
      accessMode: catalogEntry.accessMode,
      enabled,
      name: toolName,
      requiresApproval: catalogEntry.accessMode === "write" && approvalRequiredWriteTools.has(toolName),
    };
  };

  const isToolAllowed = (toolName: string): boolean => toolDefinition(toolName)?.enabled ?? false;
  const requiresApproval = (toolName: string): boolean => toolDefinition(toolName)?.requiresApproval ?? false;

  return {
    configuredTools() {
      return Object.keys(TOOL_CATALOG).filter((toolName) => isToolAllowed(toolName));
    },
    isToolAllowed,
    listCapabilities() {
      return Object.keys(TOOL_CATALOG)
        .map((name) => toolDefinition(name))
        .filter((definition): definition is CapabilityDefinition => definition !== null && definition.enabled);
    },
    requiresApproval,
    resolveApprovalTools(requestedTools, grantedSessionTools = requestedTools) {
      const grantedTools = unique(requestedTools).filter((toolName) => grantedSessionTools.includes(toolName));
      const deniedTools = unique(requestedTools).filter((toolName) => !grantedSessionTools.includes(toolName));
      const approvalRequiredTools = grantedTools.filter((toolName) => requiresApproval(toolName));

      return {
        approvalRequiredTools,
        deniedTools,
        grantedTools,
      };
    },
    resolveRequestedTools(requestedTools) {
      const uniqueRequestedTools = unique(requestedTools);
      const grantedTools = uniqueRequestedTools.filter((toolName) => isToolAllowed(toolName));
      const deniedTools = uniqueRequestedTools.filter((toolName) => !isToolAllowed(toolName));
      const approvalRequiredTools = grantedTools.filter((toolName) => requiresApproval(toolName));

      return {
        approvalRequiredTools,
        deniedTools,
        grantedTools,
      };
    },
    toolDefinition,
  };
};
