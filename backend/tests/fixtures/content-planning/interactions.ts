import type { ConversationInteractionRole } from "@radioso/conversation-contract";

import type {
  ConversationInteractionLifecycleFacts,
  PreparedConversationInteraction,
} from "../../../src/modules/chat/services/conversationInteraction.js";

export interface ContentPlanningInteractionFixture {
  name: string;
  language: string;
  /** Evidence only. Eligibility code must never inspect this field. */
  visitorMessage: string;
  currentUserMessageId: string;
  history: Array<{ id: string; role: "user" | "assistant" }>;
  inferred: PreparedConversationInteraction;
  lifecycle: ConversationInteractionLifecycleFacts;
  priorUnresolvedSourceUserMessageId?: string;
  sourceChannel?: string;
  expected: {
    role: ConversationInteractionRole;
    sourceUserMessageId: string;
    semanticIntentIds: string[];
    registration: "ready" | "pending_context" | "none";
  };
}

export const contentPlanningInteractionFixture: ContentPlanningInteractionFixture[] = [
  {
    name: "English fresh question",
    language: "en",
    visitorMessage: "How long are audit logs retained?",
    currentUserMessageId: "00000000-0000-4000-8000-000000000101",
    history: [],
    inferred: {
      role: "substantive_new",
      semanticIntents: [{ id: "primary", text: "audit log retention period" }],
    },
    lifecycle: {},
    expected: {
      role: "substantive_new",
      sourceUserMessageId: "00000000-0000-4000-8000-000000000101",
      semanticIntentIds: ["primary"],
      registration: "ready",
    },
  },
  {
    name: "Spanish polite substantive question",
    language: "es",
    visitorMessage: "Gracias, ¿podrías explicar cómo funciona el SSO?",
    currentUserMessageId: "00000000-0000-4000-8000-000000000102",
    history: [],
    inferred: {
      role: "substantive_new",
      semanticIntents: [{ id: "primary", text: "cómo funciona el inicio de sesión único SSO" }],
    },
    lifecycle: {},
    expected: {
      role: "substantive_new",
      sourceUserMessageId: "00000000-0000-4000-8000-000000000102",
      semanticIntentIds: ["primary"],
      registration: "ready",
    },
  },
  {
    name: "Estonian contextual follow-up",
    language: "et",
    visitorMessage: "Aga kui palju see Enterprise paketis maksab?",
    currentUserMessageId: "00000000-0000-4000-8000-000000000103",
    history: [{ id: "00000000-0000-4000-8000-000000000003", role: "assistant" }],
    inferred: {
      role: "substantive_followup",
      semanticIntents: [{ id: "primary", text: "Enterprise paketi hind" }],
    },
    lifecycle: {},
    expected: {
      role: "substantive_followup",
      sourceUserMessageId: "00000000-0000-4000-8000-000000000103",
      semanticIntentIds: ["primary"],
      registration: "ready",
    },
  },
  {
    name: "French social reaction",
    language: "fr",
    visitorMessage: "Merci beaucoup !",
    currentUserMessageId: "00000000-0000-4000-8000-000000000104",
    history: [],
    inferred: { role: "social", semanticIntents: [] },
    lifecycle: { socialTerminal: true },
    expected: {
      role: "social",
      sourceUserMessageId: "00000000-0000-4000-8000-000000000104",
      semanticIntentIds: [],
      registration: "none",
    },
  },
  {
    name: "German routine value overrides a substantive inference",
    language: "de",
    visitorMessage: "Ja",
    currentUserMessageId: "00000000-0000-4000-8000-000000000105",
    history: [],
    inferred: {
      role: "substantive_new",
      semanticIntents: [{ id: "primary", text: "zustimmen" }],
    },
    lifecycle: { routineTurn: true },
    expected: {
      role: "control",
      sourceUserMessageId: "00000000-0000-4000-8000-000000000105",
      semanticIntentIds: [],
      registration: "none",
    },
  },
  {
    name: "Japanese menu choice overrides a substantive inference",
    language: "ja",
    visitorMessage: "2",
    currentUserMessageId: "00000000-0000-4000-8000-000000000106",
    history: [],
    inferred: {
      role: "substantive_followup",
      semanticIntents: [{ id: "primary", text: "2 番目の選択肢" }],
    },
    lifecycle: { pendingDecisionTurn: true },
    expected: {
      role: "control",
      sourceUserMessageId: "00000000-0000-4000-8000-000000000106",
      semanticIntentIds: [],
      registration: "none",
    },
  },
  {
    name: "Arabic unresolved fragment",
    language: "ar",
    visitorMessage: "وماذا عن ذلك؟",
    currentUserMessageId: "00000000-0000-4000-8000-000000000107",
    history: [],
    inferred: { role: "unresolved", semanticIntents: [] },
    lifecycle: {},
    expected: {
      role: "unresolved",
      sourceUserMessageId: "00000000-0000-4000-8000-000000000107",
      semanticIntentIds: [],
      registration: "pending_context",
    },
  },
  {
    name: "Portuguese multi-intent question",
    language: "pt",
    visitorMessage: "Como configuro SSO e quanto tempo os logs ficam guardados?",
    currentUserMessageId: "00000000-0000-4000-8000-000000000108",
    history: [],
    inferred: {
      role: "substantive_new",
      semanticIntents: [
        { id: "subquery_1", text: "configuração de SSO" },
        { id: "subquery_2", text: "período de retenção de logs" },
      ],
    },
    lifecycle: {},
    expected: {
      role: "substantive_new",
      sourceUserMessageId: "00000000-0000-4000-8000-000000000108",
      semanticIntentIds: ["subquery_1", "subquery_2"],
      registration: "ready",
    },
  },
  {
    name: "Clarification value finalizes the earlier source",
    language: "en",
    visitorMessage: "Okta",
    currentUserMessageId: "00000000-0000-4000-8000-000000000109",
    history: [
      { id: "00000000-0000-4000-8000-000000000009", role: "user" },
      { id: "00000000-0000-4000-8000-000000000019", role: "assistant" },
    ],
    inferred: {
      role: "unresolved",
      semanticIntents: [{ id: "primary", text: "Does the product support Okta?" }],
    },
    lifecycle: { clarificationOutcome: "value" },
    priorUnresolvedSourceUserMessageId: "00000000-0000-4000-8000-000000000009",
    expected: {
      role: "clarification_value",
      sourceUserMessageId: "00000000-0000-4000-8000-000000000009",
      semanticIntentIds: ["primary"],
      registration: "ready",
    },
  },
  {
    name: "Operator test traffic is outside the reporting population",
    language: "en",
    visitorMessage: "How do I configure SCIM?",
    currentUserMessageId: "00000000-0000-4000-8000-000000000110",
    history: [],
    inferred: {
      role: "substantive_new",
      semanticIntents: [{ id: "primary", text: "SCIM configuration" }],
    },
    lifecycle: {},
    sourceChannel: "authenticated_chat",
    expected: {
      role: "substantive_new",
      sourceUserMessageId: "00000000-0000-4000-8000-000000000110",
      semanticIntentIds: ["primary"],
      registration: "none",
    },
  },
];
