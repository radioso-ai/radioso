import type { SkillDefinition } from "../../radiosoModuleTypes.js";

const supportedDiagnosticFields = [
  "skillName",
  "shapeName",
  "selectionMode",
  "selectionReason",
  "selectionConfidence",
  "callerSurface",
  "capabilityChecks",
  "parameters",
  "fallback",
  "outcome",
  "error",
  "evidence",
];

export const humanContactRequestSkillDefinition: SkillDefinition = {
  name: "human_contact.request",
  displayName: "Human contact request",
  description: "Let a chat user request follow-up from a person through configured Enterprise contact delivery.",
  owner: "contact",
  executionClass: "deferred",
  supportedCallers: ["assistant", "dashboard", "public_embed"],
  requiredCapabilities: ["human_contact.request"],
  contractReferences: [
    {
      kind: "http",
      label: "Enterprise contact submit API",
      method: "POST",
      path: "/api/v1/ee/contact/submit",
    },
    {
      kind: "http",
      label: "Enterprise public contact submit API",
      method: "POST",
      path: "/api/v1/ee/contact/public/chat/{token}/submit",
    },
  ],
  diagnostics: {
    defined: true,
    shapeAware: true,
    supportedFields: supportedDiagnosticFields,
  },
  steps: [
    {
      name: "availability_check",
      kind: "availability_check",
      displayName: "Availability check",
      clauses: {
        requireEnabledWorkspace: true,
        requireConfiguredDelivery: true,
      },
    },
    {
      name: "trigger_evaluation",
      kind: "trigger_evaluation",
      displayName: "Trigger evaluation",
      clauses: {
        deterministicSources: [
          "explicit_user_request",
          "no_context_refusal",
          "grounded_degraded_unsupported_segments",
        ],
        classifier: "bounded",
      },
    },
    {
      name: "draft_build",
      kind: "draft_build",
      displayName: "Draft build",
      clauses: {
        includeRecentConversation: true,
        maxMessageLength: 6000,
      },
    },
    {
      name: "request_submit",
      kind: "request_submit",
      displayName: "Request submit",
      clauses: {
        requireConversationAccess: true,
        rateLimit: "settings_default",
      },
    },
    {
      name: "delivery_dispatch",
      kind: "delivery_dispatch",
      displayName: "Delivery dispatch",
      clauses: {
        email: "settings_default",
        webhook: "settings_default",
        retryPolicy: "settings_default",
      },
    },
    {
      name: "audit_record",
      kind: "audit_record",
      displayName: "Audit record",
      clauses: {
        persist: true,
        exposeInActivity: true,
      },
    },
  ],
  shapes: [
    {
      name: "explicit_contact_request",
      displayName: "Explicit contact request",
      description: "The user selected or submitted a contact action explicitly.",
      stepOverrides: {},
    },
    {
      name: "assistant_suggested_contact",
      displayName: "Assistant suggested contact",
      description: "The assistant offered contact based on grounded answer outcome or classifier output.",
      stepOverrides: {},
    },
    {
      name: "default_contact_request",
      displayName: "Default contact request",
      description: "Default Enterprise contact request behavior.",
      stepOverrides: {},
    },
  ],
};
