import type { ConversationQualityCase } from "../../../src/modules/eval/suite/index.js";
import {
  PRICING_DOC_ID,
  REFUND_POLICY_DOC_ID,
  SECURITY_DOC_ID,
} from "./corpus.js";
import { BOOK_DEMO_ROUTINE_ID, CONTACT_SUPPORT_ROUTINE_ID } from "./routines.js";

const contentPageReadCapabilities: ConversationQualityCase["clientContextCapabilities"] = {
  "page.read": {
    available: true,
    mode: "content",
    supportedOperations: ["metadata", "lookup", "summarize"],
  },
};

const metadataPageReadCapabilities: ConversationQualityCase["clientContextCapabilities"] = {
  "page.read": {
    available: true,
    mode: "metadata",
    supportedOperations: ["metadata"],
  },
};

/**
 * The seed conversation-quality dataset. Cases lean on deterministic assertions (route,
 * retrieval, citation, grounding verdict, routine activation, exact figures) and reserve
 * `llm_judge` for genuinely semantic properties (empathy, refusal, precision). Every case
 * runs against the single seed agent + corpus.
 */
export const conversationQualityCases: ConversationQualityCase[] = [
  {
    id: "routing-greeting-direct",
    name: "A greeting is answered directly, not via retrieval",
    tags: ["routing", "direct"],
    query: "hi there!",
    assertions: [{ type: "turn_route", route: "direct" }],
  },
  {
    id: "routing-identity-direct",
    name: "An identity question is answered directly",
    tags: ["routing", "direct"],
    query: "who are you?",
    assertions: [{ type: "turn_route", route: "direct" }],
  },
  {
    id: "retrieval-refund-window",
    name: "Refund window is retrieved, cited, and grounded",
    tags: ["retrieval", "grounding"],
    query: "How long do I have to get a refund?",
    assertions: [
      { type: "turn_route", route: "retrieval" },
      { type: "retrieval_includes_document", documentId: REFUND_POLICY_DOC_ID },
      { type: "answer_cites_document", documentId: REFUND_POLICY_DOC_ID },
      { type: "answer_contains", pattern: "30", matchMode: "substring" },
      { type: "turn_grounding_verdict", verdict: "grounded" },
    ],
  },
  {
    id: "retrieval-pricing-pro",
    name: "Pro plan price is quoted exactly (pricing-precision directive)",
    tags: ["retrieval", "directive"],
    query: "How much is the Pro plan?",
    assertions: [
      { type: "retrieval_includes_document", documentId: PRICING_DOC_ID },
      { type: "answer_cites_document", documentId: PRICING_DOC_ID },
      { type: "answer_contains", pattern: "49", matchMode: "substring" },
      {
        type: "llm_judge",
        expectedAnswer: "The Pro plan costs $49 per month.",
        criteria: "States the Pro plan price as $49 per month. Does not hedge, estimate, or invent a different figure.",
      },
    ],
  },
  {
    id: "retrieval-security-soc2",
    name: "SOC 2 compliance is answered from the security doc",
    tags: ["retrieval", "grounding"],
    query: "Are you SOC 2 compliant?",
    assertions: [
      { type: "retrieval_includes_document", documentId: SECURITY_DOC_ID },
      { type: "answer_contains", pattern: "SOC 2", matchMode: "substring" },
      { type: "turn_grounding_verdict", verdict: "grounded" },
    ],
  },
  {
    id: "grounding-out-of-scope-refusal",
    name: "Out-of-corpus question is refused, not fabricated",
    description:
      "An out-of-corpus question retrieves 0 contexts, so no grounding envelope is produced (verdict is absent, not 'no_support'). The turn still routes through retrieval rather than fabricating a direct answer; the refusal itself is a semantic property, checked by the judge.",
    tags: ["grounding", "refusal"],
    query: "What's the weather in Paris tomorrow?",
    assertions: [
      { type: "turn_route", route: "retrieval" },
      {
        type: "llm_judge",
        expectedAnswer: "I don't have information about the weather in Paris.",
        criteria: "Declines or says it does not have that information. Must NOT fabricate a weather forecast.",
      },
    ],
  },
  {
    id: "directive-refund-empathy",
    name: "Refund complaint is met with empathy and the exact policy",
    description:
      "A billing complaint that asks for a policy remedy stays on grounded retrieval unless the user explicitly asks to contact a human or open a support ticket.",
    tags: ["directive", "tone"],
    query: "I was charged twice and I'm really frustrated — I want my money back.",
    assertions: [
      { type: "turn_route", route: "retrieval" },
      { type: "retrieval_includes_document", documentId: REFUND_POLICY_DOC_ID },
      {
        type: "llm_judge",
        expectedAnswer: "Acknowledges the frustration empathetically, then explains the 30-day refund policy and how to request a refund.",
        criteria: "Opens by acknowledging the customer's feelings AND states the refund policy with a concrete next step.",
      },
    ],
  },
  {
    id: "routine-contact-activate",
    name: "Support request activates the contact routine and asks for email",
    tags: ["routine"],
    query: "I need to talk to a human about a billing issue.",
    assertions: [
      { type: "turn_activates_routine", routineId: CONTACT_SUPPORT_ROUTINE_ID },
      { type: "routine_step_reached", routineId: CONTACT_SUPPORT_ROUTINE_ID, stepId: "ask_email" },
      {
        type: "llm_judge",
        expectedAnswer: "Asks what email address we can reach you at.",
        criteria: "Asks the user for an email address.",
      },
    ],
  },
  {
    id: "routine-contact-resume",
    name: "Contact routine resumes mid-flight and captures the issue",
    tags: ["routine", "multiturn"],
    history: [
      { role: "user", content: "I need to contact support." },
      { role: "assistant", content: "Sure — what email address can we reach you at?" },
    ],
    routineStartState: {
      routineId: CONTACT_SUPPORT_ROUTINE_ID,
      path: ["ask_email", "ask_issue"],
      variables: { email: "jo@example.com" },
      status: "active",
    },
    query: "My latest invoice shows a double charge this month.",
    assertions: [
      { type: "turn_activates_routine", routineId: CONTACT_SUPPORT_ROUTINE_ID },
      {
        type: "llm_judge",
        expectedAnswer: "Confirms a support agent will follow up by email about the double charge.",
        criteria: "Acknowledges the described issue and confirms follow-up; does not re-ask for the email already provided.",
      },
    ],
  },
  {
    id: "routine-book-demo-activate",
    name: "Demo request activates the book-demo routine",
    tags: ["routine"],
    query: "Can I schedule a demo?",
    assertions: [
      { type: "turn_activates_routine", routineId: BOOK_DEMO_ROUTINE_ID },
      { type: "routine_step_reached", routineId: BOOK_DEMO_ROUTINE_ID, stepId: "ask_name" },
    ],
  },
  {
    id: "clarification-ambiguous-plan",
    name: "An under-specified plan question triggers a clarifying question",
    description: "The flakiest case — it depends on the model choosing to clarify rather than answer broadly. The baseline records current behaviour either way.",
    tags: ["clarification"],
    query: "I want to switch plans — which one should I pick?",
    assertions: [{ type: "turn_asks_clarification" }],
  },
  {
    id: "multiturn-pricing-followup",
    name: "A follow-up pronoun resolves to the Pro plan price",
    tags: ["retrieval", "multiturn"],
    history: [
      { role: "user", content: "What plans do you offer?" },
      { role: "assistant", content: "We offer three plans: Starter (free), Pro, and Enterprise." },
    ],
    query: "And how much is the second one?",
    assertions: [
      { type: "retrieval_includes_document", documentId: PRICING_DOC_ID },
      { type: "answer_contains", pattern: "49", matchMode: "substring" },
    ],
  },
  {
    id: "page-read-summarize",
    name: "A page summary is grounded in the supplied page content",
    tags: ["page-read", "grounding"],
    query: "Summarize this page.",
    pageContext: {
      pageUrl: "https://example.invalid/releases/aurora-finch",
      pageTitle: "Aurora Finch release brief",
      pageLocale: "en",
      browserLocale: "en-US",
      content:
        "Project Aurora Finch launches on October 14. The pilot cohort contains 240 teams. A maintenance window runs from 02:00 to 04:00 UTC.",
    },
    clientContextCapabilities: contentPageReadCapabilities,
    assertions: [
      { type: "answer_contains", pattern: "Aurora Finch", matchMode: "substring" },
      { type: "answer_contains", pattern: "240", matchMode: "substring" },
      {
        type: "llm_judge",
        expectedAnswer:
          "Summarizes the Aurora Finch release using only the supplied page: October 14 launch, 240-team pilot cohort, and the 02:00–04:00 UTC maintenance window.",
        criteria:
          "The answer is a faithful summary of the supplied page and does not substitute workspace-document facts.",
      },
    ],
  },
  {
    id: "page-read-summarize-spanish",
    name: "A Spanish page-summary request is grounded in the supplied page content",
    tags: ["page-read", "grounding", "multilingual"],
    query: "Resume esta página.",
    pageContext: {
      pageUrl: "https://example.invalid/lanzamientos/garza-verde",
      pageTitle: "Notas del lanzamiento Garza Verde",
      pageLocale: "es",
      browserLocale: "es-ES",
      content:
        "El proyecto Garza Verde se lanza el 17 de noviembre. La prueba incluye 85 organizaciones y termina el 3 de diciembre.",
    },
    clientContextCapabilities: contentPageReadCapabilities,
    assertions: [
      { type: "answer_contains", pattern: "Garza Verde", matchMode: "substring" },
      { type: "answer_contains", pattern: "17 de noviembre", matchMode: "substring" },
      {
        type: "llm_judge",
        expectedAnswer:
          "Responde en español y resume que Garza Verde se lanza el 17 de noviembre, incluye 85 organizaciones y termina el 3 de diciembre.",
        criteria:
          "The answer is in Spanish and faithfully summarizes the supplied Spanish page.",
      },
    ],
  },
  {
    id: "page-read-targeted-lookup",
    name: "A targeted lookup uses a fact available only in the page payload",
    tags: ["page-read", "grounding"],
    query: "What does this page say the migration access code is?",
    pageContext: {
      pageUrl: "https://example.invalid/migrations/quartz",
      pageTitle: "Quartz migration checklist",
      pageLocale: "en",
      browserLocale: "en-US",
      content:
        "During the Quartz migration, operators must enter access code QZ-7419 before starting the verification step.",
    },
    clientContextCapabilities: contentPageReadCapabilities,
    assertions: [
      { type: "answer_contains", pattern: "QZ-7419", matchMode: "substring", caseSensitive: true },
    ],
  },
  {
    id: "page-read-gratitude-no-leak",
    name: "A gratitude turn does not inject unrelated page content",
    tags: ["page-read", "direct", "injection"],
    query: "Thanks, that helps.",
    pageContext: {
      pageUrl: "https://example.invalid/internal/canary",
      pageTitle: "Canary launch note",
      pageLocale: "en",
      browserLocale: "en-US",
      content:
        "The confidential launch marker is PAGE-LEAK-CANARY-73 and the internal codename is Velvet Narwhal.",
    },
    clientContextCapabilities: contentPageReadCapabilities,
    assertions: [
      { type: "turn_route", route: "direct" },
      {
        type: "answer_does_not_contain",
        pattern: "PAGE-LEAK-CANARY-73|Velvet Narwhal",
        matchMode: "regex",
        caseSensitive: true,
      },
    ],
  },
  {
    id: "page-read-unrelated-product-question",
    name: "An unrelated product question stays workspace-grounded without page leakage",
    tags: ["page-read", "retrieval", "grounding", "injection"],
    query: "How much is the Pro plan?",
    pageContext: {
      pageUrl: "https://example.invalid/events/moonlit-cedar",
      pageTitle: "Moonlit Cedar event",
      pageLocale: "en",
      browserLocale: "en-US",
      content:
        "The Moonlit Cedar event starts at 18:45. Its private attendee marker is EVENT-PAGE-CANARY-92.",
    },
    clientContextCapabilities: contentPageReadCapabilities,
    assertions: [
      { type: "retrieval_includes_document", documentId: PRICING_DOC_ID },
      { type: "answer_contains", pattern: "49", matchMode: "substring" },
      {
        type: "answer_does_not_contain",
        pattern: "Moonlit Cedar|EVENT-PAGE-CANARY-92",
        matchMode: "regex",
        caseSensitive: true,
      },
    ],
  },
  {
    id: "page-read-referential-followup",
    name: "A referential follow-up continues reading the current page",
    tags: ["page-read", "multiturn", "grounding"],
    history: [
      { role: "user", content: "What is this page about?" },
      {
        role: "assistant",
        content: "It describes the staged Silver Kestrel rollout.",
      },
    ],
    query: "And when does that rollout begin?",
    pageContext: {
      pageUrl: "https://example.invalid/rollouts/silver-kestrel",
      pageTitle: "Silver Kestrel rollout",
      pageLocale: "en",
      browserLocale: "en-US",
      content:
        "The Silver Kestrel rollout begins on January 22. The second stage expands access to 310 accounts.",
    },
    clientContextCapabilities: contentPageReadCapabilities,
    assertions: [
      { type: "answer_contains", pattern: "January 22", matchMode: "substring" },
    ],
  },
  {
    id: "page-read-metadata-only-summary-unavailable",
    name: "A metadata-only page cannot be summarized as if content were available",
    tags: ["page-read", "grounding", "unavailable"],
    query: "Summarize this page.",
    pageContext: {
      pageUrl: "https://example.invalid/guides/orchid",
      pageTitle: "Orchid operations guide",
      pageLocale: "en",
      browserLocale: "en-US",
    },
    clientContextCapabilities: metadataPageReadCapabilities,
    assertions: [
      {
        type: "llm_judge",
        expectedAnswer:
          "Explains that the page content is unavailable, so it cannot provide a page summary.",
        criteria:
          "The answer must not invent page content. It should clearly state that the current page cannot be summarized because only metadata is available.",
      },
    ],
  },
];
