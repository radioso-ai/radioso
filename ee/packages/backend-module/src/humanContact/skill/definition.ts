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
  displayName: "Contact handoff request",
  description: "Let a chat user request follow-up through configured Enterprise contact delivery.",
  display: {
    icon: "handshake",
    title: "Contact us",
  },
  owner: "contact",
  executionClass: "deferred",
  supportedCallers: ["assistant", "dashboard", "public_embed"],
  requiredCapabilities: ["human_contact.request"],
  contractReferences: [],
  intake: {
    enabled: true,
    supportedCallers: ["assistant", "dashboard", "public_embed"],
    intent: {
      description: "Start when the user wants to talk to a human, contact a person, reach the team, or have someone follow up.",
      examples: [
        "I want to talk to a human.",
        "Can someone from the team contact me?",
        "Please connect me with a person.",
      ],
    },
    fields: [
      {
        name: "email",
        displayName: "email address",
        type: "email",
        required: true,
        sensitive: true,
        ttlSeconds: 900,
        extractionHint: "The email address where follow-up should be sent.",
      },
      {
        name: "message",
        displayName: "message",
        type: "string",
        required: true,
        maxLength: 6000,
        extractionHint: "A concise summary of what the user wants help with.",
      },
    ],
    subjectIdentityField: "email",
    confirmation: "none",
    interruptionPolicy: "pause_and_resume",
  },
  execution: {
    kind: "delivery_pipeline",
    adapter: "human_contact",
    destinations: ["email", "webhook"],
    enqueue: true,
  },
  diagnostics: {
    defined: true,
    shapeAware: true,
    strategyAware: false,
    supportedFields: supportedDiagnosticFields,
  },
  outcomes: [
    {
      name: "sent",
      displayName: "Sent",
      description: "The contact handoff was accepted for delivery.",
      status: "completed",
      tone: "positive",
    },
    {
      name: "failed",
      displayName: "Failed",
      description: "The contact handoff could not be submitted.",
      status: "failed",
      tone: "warning",
    },
    {
      name: "cancelled",
      displayName: "Cancelled",
      description: "The contact handoff was cancelled before submission.",
      status: "cancelled",
      tone: "muted",
    },
  ],
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
        ],
        explicitActionSource: "explicit_user_request",
        classifier: "intake_start",
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
      description: "The user asked for human follow-up in chat and completed the intake.",
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
