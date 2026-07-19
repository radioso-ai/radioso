import type { ConversationQualityCase } from "../../../src/modules/eval/suite/index.js";
import {
  PRICING_DOC_ID,
  REFUND_POLICY_DOC_ID,
  SECURITY_DOC_ID,
} from "./corpus.js";
import { BOOK_DEMO_ROUTINE_ID, CONTACT_SUPPORT_ROUTINE_ID } from "./routines.js";

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
    tags: ["directive", "tone"],
    query: "I was charged twice and I'm really frustrated — I want my money back.",
    assertions: [
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
];
