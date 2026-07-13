export type DocumentEnrichmentOverride = "on" | "off";
export type DocumentSourceEnrichmentOverride = DocumentEnrichmentOverride | "inherit";

export interface DocumentEnrichmentEnablementInput {
  workspaceDefaultEnabled: boolean;
  sourceOverride?: DocumentSourceEnrichmentOverride | null;
  jobOverride?: DocumentEnrichmentOverride | null;
}

export type DocumentEnrichmentEnablementReason =
  | "job_override"
  | "source_override"
  | "workspace_default";

export interface DocumentEnrichmentEnablement {
  enabled: boolean;
  reason: DocumentEnrichmentEnablementReason;
}

export const resolveDocumentEnrichmentEnablement = (
  input: DocumentEnrichmentEnablementInput,
): DocumentEnrichmentEnablement => {
  if (input.jobOverride === "on" || input.jobOverride === "off") {
    return { enabled: input.jobOverride === "on", reason: "job_override" };
  }

  if (input.sourceOverride === "on" || input.sourceOverride === "off") {
    return { enabled: input.sourceOverride === "on", reason: "source_override" };
  }

  return { enabled: input.workspaceDefaultEnabled, reason: "workspace_default" };
};

export const parseDocumentEnrichmentOverride = (value: unknown): DocumentEnrichmentOverride | null => {
  if (value === "on" || value === "off") {
    return value;
  }
  return null;
};

export const parseDocumentSourceEnrichmentOverride = (value: unknown): DocumentSourceEnrichmentOverride => {
  if (value === "on" || value === "off" || value === "inherit") {
    return value;
  }
  return "inherit";
};
