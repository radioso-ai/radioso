import { ZERO_TOLERANCE_JUDGE_TAG, type ConversationQualityCase } from "../../../src/modules/eval/suite/index.js";
import { seedDirectiveConfigWith } from "./agent.js";
import {
  BREATH_COURSE_DOC_ID,
  PRICING_DOC_ID,
  REFUND_POLICY_DOC_ID,
  SECURITY_DOC_ID,
  MOUNTAIN_COURSE_DOC_ID,
  TIDAL_LINES_DOC_ID,
  WOVEN_ROOMS_DOC_ID,
} from "./corpus.js";
import { contactFormOnlyDirective, listedLanguagesDirective, pricesFromTheCoursePageDirective } from "./directives.js";
import {
  BOOK_DEMO_ROUTINE_ID,
  BOOK_RETREAT_ROUTINE_ID,
  CONTACT_SUPPORT_ROUTINE_ID,
  CREATE_RETURN_TICKET_SKILL,
  START_RETURN_ROUTINE_ID,
  START_RETURN_TOOL_NAME,
} from "./routines.js";

const contentPageReadCapabilities: ConversationQualityCase["clientContextCapabilities"] = {
  "page.read": {
    available: true,
    mode: "content",
    supportedOperations: ["metadata", "lookup", "summarize"],
  },
};

const refundExchangeEnglish: NonNullable<ConversationQualityCase["history"]> = [
  { role: "user", content: "How long do I have to get a refund?" },
  { role: "assistant", content: "You can request a full refund within 30 days of purchase." },
];

const refundExchangeItalian: NonNullable<ConversationQualityCase["history"]> = [
  { role: "user", content: "Quanto tempo ho per chiedere un rimborso?" },
  { role: "assistant", content: "Puoi richiedere un rimborso completo entro 30 giorni dall'acquisto." },
];

/**
 * A booking exchange in which the visitor names a course and the assistant's next turn only asks
 * for contact details, so the course is two turns behind a later reference to "the event".
 */
const courseNamedBehindContactFormItalian = (
  dates: string,
  course: string,
): NonNullable<ConversationQualityCase["history"]> => [
  { role: "user", content: `Vorrei partecipare all'evento ${dates}` },
  { role: "assistant", content: "Che bello! A quale corso vorresti partecipare?" },
  { role: "user", content: "Corso residenziale" },
  { role: "assistant", content: "Perfetto. Per procedere mi servono il tuo nome e il tuo indirizzo email." },
  { role: "user", content: course },
  { role: "assistant", content: "Grazie. Per completare la richiesta mi servono il tuo nome e il tuo indirizzo email." },
];

/**
 * The form is still waiting on the visitor's name when the quote request arrives, so the request
 * is a digression the routine yields to retrieval. The demo-booking routine stands in for the
 * booking form; its first step asks for the name.
 */
const contactFormAwaitingName: NonNullable<ConversationQualityCase["routineStartState"]> = {
  routineId: BOOK_DEMO_ROUTINE_ID,
  path: ["ask_name"],
  variables: {},
  status: "active",
};

/** The mountain yoga course's fee and room rates, none of which belongs in an answer about another course. */
const MOUNTAIN_COURSE_FIGURES_ABSENT: ConversationQualityCase["assertions"] = ["345", "310", "255", "195"].map((figure) => ({
  type: "answer_does_not_contain",
  pattern: figure,
  matchMode: "substring",
}));

const FULL_QUOTE_FOR_THE_EVENT_ITALIAN = "Mi mandi un preventivo completo compreso di pernottamento per l'evento?";

/**
 * The rubric every quick reply is graded on: no factual proposition at all, except what a
 * standing instruction supplies word for word or a courtesy about the assistant's own
 * willingness to help — a claim about what it can do still counts as a factual proposition.
 */
const NO_FACTUAL_PROPOSITION_RUBRIC =
  "The reply contains no factual proposition about anything (the organisation, its products, plans, prices, policies, or people, the assistant's abilities, or the world), except text a standing instruction supplies word for word. A greeting, thanks, a farewell, a generic invitation to ask, or a courtesy about the assistant's own willingness or pleasure to help is not a factual proposition. A claim about what the assistant can do is a factual proposition about its abilities and is not covered by that exception.";

/** The judge criterion for a quick-reply case whose reference describes the expected reply. */
const quickReplyCriteria = (language: string): string =>
  `The reference describes the expected reply rather than quoting it: judge whether the observed reply fits that description, not whether it repeats its words or includes its optional parts. The reply is one or two short sentences in ${language}. ${NO_FACTUAL_PROPOSITION_RUBRIC}`;

const quickReplyCase = (input: {
  id: string;
  name: string;
  kind: "greeting" | "thanks" | "farewell" | "acknowledgement";
  language: string;
  query: string;
  history?: ConversationQualityCase["history"];
  expectedAnswer: string;
}): ConversationQualityCase => ({
  id: input.id,
  name: input.name,
  description: `Pure conversational mechanics (${input.kind}): the turn planner writes the reply itself, so the turn makes one model call and the composer never runs.`,
  tags: ["quick-reply", "direct", ZERO_TOLERANCE_JUDGE_TAG],
  ...(input.history ? { history: input.history } : {}),
  query: input.query,
  assertions: [
    { type: "turn_route", route: "direct" },
    { type: "turn_reply_source", source: "turn_planning" },
    { type: "llm_judge", expectedAnswer: input.expectedAnswer, criteria: quickReplyCriteria(input.language) },
  ],
});

/** The tag whose judge grades how an answer places each item against a period the question names. */
const REQUESTED_PERIOD_JUDGE_TAG = "requested-period";

const ARTS_CENTRE_WEEK_REFERENCE =
  "The reference describes the dates rather than quoting a reply. In the week of Monday 10 to Sunday 16 March 2031: Tidal Lines and Woven Rooms opened on Sunday 9 March, the day before the week, and close on 16 March, its last day; Glass and Light opened on 14 February and runs until 27 April; the printmaking evening is on Wednesday 12 March; the clay modelling weekend is on 14 and 15 March; the letterpress workshop series begins on Sunday 16 March and runs until 22 March. Paper Cities closed on 8 March, before the week.";

/** The judge criterion for a reply in `language` to a question about the arts centre's week. */
const artsCentreWeekCriteria = (language: string): string =>
  `Grade only how the reply, written in ${language}, places each item it mentions against the week of 10 to 16 March 2031. FAIL when the reply says or implies that Tidal Lines, Woven Rooms, or Glass and Light starts, opens, begins, or is new during that week or on any day of it (each opened before 10 March), or that the letterpress workshop series ends during the week (it ends on 22 March), or when it states a date for an item that contradicts the reference. Saying an item is running, on view, already open, or continuing during the week, or that Tidal Lines and Woven Rooms close on 16 March, is correct. A reply may leave items out, group them, or add other details from the reference, and is not marked down for any of that.`;

/**
 * A question about one week whose items include two that open the day before it and close on its
 * last day, the shape a production answer described as starting in the week (#1632). The date
 * lookup must fetch those pages, and the answer must not move their start into the week.
 */
const requestedPeriodRelationCase = (input: { id: string; language: string; query: string }): ConversationQualityCase => ({
  id: input.id,
  name: `A ${input.language} question about one week does not move an item that opened the day before it into the week`,
  tags: ["retrieval", "temporal", "multilingual", REQUESTED_PERIOD_JUDGE_TAG, ZERO_TOLERANCE_JUDGE_TAG],
  query: input.query,
  assertions: [
    { type: "turn_route", route: "retrieval" },
    { type: "retrieval_includes_document", documentId: TIDAL_LINES_DOC_ID },
    { type: "retrieval_includes_document", documentId: WOVEN_ROOMS_DOC_ID },
    { type: "answer_contains", pattern: "Tidal Lines", matchMode: "substring" },
    { type: "llm_judge", expectedAnswer: ARTS_CENTRE_WEEK_REFERENCE, criteria: artsCentreWeekCriteria(input.language) },
  ],
});

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
    id: "retrieval-partial-refund-and-fee",
    name: "A refund window question with an undocumented add-on states the documented limit and does not fabricate the rest",
    description:
      "FR-022 (#1260): the seed agent's always-on maximally-helpful directive is the pressure a separate, un-pressured assessor call never felt — a model asked to be maximally helpful is the one most tempted to pad an undocumented half of a compound request (the processing fee) with invented specifics instead of stating the material doesn't cover it. The refund window itself IS documented and must still be stated exactly.",
    tags: ["retrieval", "grounding", "coverage"],
    query: "How long is your refund window, and will you also refund the payment processing fee my bank charged me for the transaction?",
    assertions: [
      { type: "turn_route", route: "retrieval" },
      { type: "retrieval_includes_document", documentId: REFUND_POLICY_DOC_ID },
      { type: "answer_contains", pattern: "30", matchMode: "substring" },
      { type: "turn_answer_coverage", coverage: "partial" },
      {
        type: "llm_judge",
        expectedAnswer:
          "States the 30-day refund window from the documented policy, and says it does not have information about refunding bank processing fees rather than inventing a fee policy.",
        criteria:
          "States the 30-day window as documented. For the processing fee, either declines to answer or clearly flags it as not covered by the documentation — does NOT state a specific fee-refund policy or amount that isn't in the corpus.",
      },
    ],
  },
  // #1575: an always-on directive withholds every figure, the Results state the figures, and
  // the built-in represent-organization (priority 80, "state supported facts directly")
  // ranks above it. The answer leaves the figures out. Italian like the report. Whether the
  // answer committed to the directive before writing is checked deterministically in
  // tests/unit/eval-suite: a withholding answer can carry no citation and be replaced by a
  // focused decline, which records no commitment, so a live check of it would be flaky.
  {
    id: "directive-withholds-figures-it",
    name: "An always-on directive keeps a course's fees out of an answered price question",
    tags: ["directive", "retrieval", "coverage", "multilingual", "directive-withholds"],
    // A price question, not a booking request: the seeded book-retreat routine claims a turn
    // that asks to book a stay, and this case measures the answer, not the routine.
    query: "Quanto costa il corso di yoga in montagna?",
    agentConfigOverride: { authoredDirectives: seedDirectiveConfigWith(pricesFromTheCoursePageDirective) },
    assertions: [
      { type: "turn_route", route: "retrieval" },
      { type: "retrieval_includes_document", documentId: MOUNTAIN_COURSE_DOC_ID },
      ...MOUNTAIN_COURSE_FIGURES_ABSENT,
      // Any euro amount, the corpus writes them both ways: a currency format check, so
      // another course's figures in the same answer break the directive too.
      { type: "answer_does_not_contain", pattern: "\\d\\s?(€|euro)|€\\s?\\d", matchMode: "regex" },
    ],
  },
  {
    id: "directive-withholds-figures-en",
    name: "An always-on directive keeps the Pro plan price out of an answered price question",
    description:
      "Informational until represent-organization stops being read as \"state the price\": the answer still quotes $49 in some samples, so its recorded rate sits too low for the gate to flag a drop. The seeded pricing-precision directive asks to quote prices exactly, which the withholding directive outranks.",
    tags: ["directive", "retrieval", "directive-withholds"],
    query: "How much is the Pro plan?",
    agentConfigOverride: { authoredDirectives: seedDirectiveConfigWith(pricesFromTheCoursePageDirective) },
    assertions: [
      { type: "turn_route", route: "retrieval" },
      { type: "retrieval_includes_document", documentId: PRICING_DOC_ID },
      { type: "answer_does_not_contain", pattern: "49", matchMode: "substring" },
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
  // #1351: an always-on directive written for open answers must not replace a routine
  // step's question. The directive sends follow-ups to a contact form instead of taking
  // an email in chat; the contact routine's first step asks for an email. The step decides
  // what the reply asks for, so the reply asks for the email and leaves the form out.
  // Italian, like the report.
  {
    id: "routine-step-outranks-always-on-handoff-directive",
    name: "An always-on redirect directive does not replace the contact step's question",
    tags: ["routine", "directive", "multilingual", "directive-precedence"],
    query: "Ho un addebito doppio sulla fattura e vorrei parlare con una persona del supporto.",
    agentConfigOverride: { authoredDirectives: seedDirectiveConfigWith(contactFormOnlyDirective) },
    assertions: [
      { type: "turn_activates_routine", routineId: CONTACT_SUPPORT_ROUTINE_ID },
      { type: "routine_step_reached", routineId: CONTACT_SUPPORT_ROUTINE_ID, stepId: "ask_email" },
      { type: "answer_contains", pattern: "e-?mail|posta elettronica", matchMode: "regex" },
      { type: "answer_does_not_contain", pattern: "acme\\.example/contact", matchMode: "regex" },
      {
        type: "llm_judge",
        expectedAnswer: "Chiede a quale indirizzo email il supporto può ricontattare il cliente.",
        criteria: "Asks the customer, in Italian, for the email address to reach them at. Does not send them to a contact form instead of asking.",
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
  // #1370: a first message keeps every slot it states, even when the step it lands on
  // asks for another. The demo routine starts on `ask_name`; this message gives the email
  // and a date without a year but no name, so the step is re-asked with both slots filled.
  // Italian, like the report.
  {
    id: "routine-first-message-keeps-stated-slots",
    name: "A first message keeps the slots it states when its step asks for another",
    tags: ["routine", "slot-extraction", "multilingual"],
    query: "Vorrei prenotare una demo per il 14 novembre, la mia email di lavoro è jo@acme.example",
    assertions: [
      { type: "turn_activates_routine", routineId: BOOK_DEMO_ROUTINE_ID },
      { type: "routine_slots_filled", routineId: BOOK_DEMO_ROUTINE_ID, slotKeys: ["email", "preferredDate"] },
    ],
  },
  // #1369: a re-asked step asks again; it never announces a confirmation. The retreat step
  // asks the visitor to confirm, and "sì" to a bare wish to stay names no retreat, so the
  // step is re-asked. The reply must be a question, not "your stay is confirmed".
  {
    id: "routine-reasked-confirmation-step-asks-again",
    name: "A re-asked confirmation step asks again instead of confirming",
    tags: ["routine", "multiturn", "reask", "multilingual"],
    history: [
      { role: "user", content: "Vorrei venire a stare da voi dall'11 al 14 novembre." },
      { role: "assistant", content: "Certamente — vuoi prenotare un soggiorno da noi dall'11 al 14 novembre?" },
    ],
    routineStartState: {
      routineId: BOOK_RETREAT_ROUTINE_ID,
      path: ["confirm_retreat"],
      variables: {},
      status: "active",
    },
    query: "sì",
    assertions: [
      { type: "turn_activates_routine", routineId: BOOK_RETREAT_ROUTINE_ID },
      { type: "answer_contains", pattern: "\\?", matchMode: "regex" },
      {
        type: "llm_judge",
        expectedAnswer: "Chiede quale ritiro del calendario il visitatore vuole prenotare.",
        criteria: "Asks which retreat the visitor wants. Does not say or imply that the stay or booking is confirmed, booked, or submitted.",
      },
    ],
  },
  // #1377: an answer to a digression leads back to the question the routine waits on. The
  // demo routine holds the name and waits on the work email; the visitor asks the Pro plan
  // price instead. The routine yields and stays on `ask_email`, and the grounded answer
  // gives the price, then asks for the email in one closing sentence. Italian, so the
  // closing sentence has to follow the visitor's language.
  {
    id: "routine-digression-leads-back",
    name: "An answer to a digression mid-routine leads back to the pending question",
    tags: ["routine", "multiturn", "digression", "multilingual"],
    history: [
      { role: "user", content: "Vorrei prenotare una demo." },
      { role: "assistant", content: "Volentieri! Come ti chiami?" },
      { role: "user", content: "Giulia Verdi" },
      { role: "assistant", content: "Grazie, Giulia. A quale email di lavoro mando l'invito per la demo?" },
    ],
    routineStartState: {
      routineId: BOOK_DEMO_ROUTINE_ID,
      path: ["ask_name", "ask_email"],
      variables: { name: "Giulia Verdi" },
      status: "active",
    },
    query: "Prima di continuare: quanto costa il piano Pro?",
    assertions: [
      { type: "routine_yielded", routineId: BOOK_DEMO_ROUTINE_ID, stepId: "ask_email" },
      { type: "answer_contains", pattern: "49", matchMode: "substring" },
      { type: "answer_contains", pattern: "e-?mail", matchMode: "regex" },
      {
        type: "llm_judge",
        expectedAnswer: "Il piano Pro costa 49 $ al mese. Quando vuoi, a quale email di lavoro mando l'invito?",
        criteria: "Answers the Pro plan price, then ends with one short sentence in Italian that asks for the work email. Does not repeat the whole demo request or say anything is booked.",
      },
    ],
  },
  // SC-002: the same routine driven by a human transcript and by one tool call reaches
  // the same step and the same skill effect; a slot-missing call stops short of the skill.
  {
    id: "routine-return-transcript",
    name: "Return routine driven by transcript reaches the ticket step and opens the ticket",
    tags: ["routine", "multiturn", "invocation-parity"],
    history: [
      { role: "user", content: "I want to send back an order." },
      { role: "assistant", content: "Sure — what is the order number?" },
      { role: "user", content: "A-1001" },
      { role: "assistant", content: "Thanks. Why is it coming back?" },
    ],
    routineStartState: {
      routineId: START_RETURN_ROUTINE_ID,
      path: ["ask_order", "ask_reason"],
      variables: { orderId: "A-1001" },
      status: "active",
    },
    query: "It arrived damaged.",
    assertions: [
      { type: "turn_activates_routine", routineId: START_RETURN_ROUTINE_ID },
      { type: "routine_step_reached", routineId: START_RETURN_ROUTINE_ID, stepId: "create_return" },
      { type: "turn_uses_skill", skillName: CREATE_RETURN_TICKET_SKILL },
    ],
  },
  {
    id: "routine-return-invocation",
    name: "Return routine invoked as a tool with every slot reaches the ticket step and opens the ticket",
    tags: ["routine", "invocation-parity"],
    routineInvocation: { toolName: START_RETURN_TOOL_NAME, input: { orderId: "A-1001", reason: "It arrived damaged." } },
    assertions: [
      { type: "turn_activates_routine", routineId: START_RETURN_ROUTINE_ID },
      { type: "routine_step_reached", routineId: START_RETURN_ROUTINE_ID, stepId: "create_return" },
      { type: "turn_uses_skill", skillName: CREATE_RETURN_TICKET_SKILL },
    ],
  },
  {
    id: "routine-return-invocation-partial",
    name: "Return routine invoked with only the order id asks for the reason and opens no ticket",
    tags: ["routine", "invocation-parity"],
    routineInvocation: { toolName: START_RETURN_TOOL_NAME, input: { orderId: "A-1001" } },
    assertions: [
      { type: "turn_activates_routine", routineId: START_RETURN_ROUTINE_ID },
      { type: "routine_step_reached", routineId: START_RETURN_ROUTINE_ID, stepId: "ask_reason" },
      { type: "turn_skips_skill", skillName: CREATE_RETURN_TICKET_SKILL },
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
    id: "referent-course-behind-contact-form",
    name: "A reference to \"the event\" resolves to the course the visitor named before a contact-details question",
    description:
      "The visitor names a residential course, the form only asks for name and email, then the visitor asks for a full quote \"for the event\". The quote must come from that course (260/200/180 euro), not from the other residential course whose page uses the request's own words (280/220/200 euro). The visitor's spelling splits the course's compound name.",
    tags: ["retrieval", "multiturn", "coverage", "multilingual", "referent-resolution"],
    history: courseNamedBehindContactFormItalian("dal 26/11/2031 al 29/11/2031", "Il respiro super consapevole"),
    routineStartState: contactFormAwaitingName,
    query: FULL_QUOTE_FOR_THE_EVENT_ITALIAN,
    assertions: [
      { type: "turn_route", route: "retrieval" },
      { type: "retrieval_includes_document", documentId: BREATH_COURSE_DOC_ID },
      { type: "answer_cites_document", documentId: BREATH_COURSE_DOC_ID },
      { type: "turn_answer_coverage", coverage: "answered" },
      { type: "answer_contains", pattern: "260", matchMode: "substring" },
      { type: "answer_does_not_contain", pattern: "280", matchMode: "substring" },
      { type: "answer_does_not_contain", pattern: "220", matchMode: "substring" },
      ...MOUNTAIN_COURSE_FIGURES_ABSENT,
    ],
  },
  {
    id: "referent-course-missing-from-corpus",
    name: "A quote for a named course the material does not cover is not answered from another course",
    description:
      "The same exchange, but the named course has no page; the two residential courses that do are other courses. Their prices are the requested kind of fact about a different subject, so the coverage verdict stays unanswered and the answer quotes neither course's figures (280/220 and 260/180 euro).",
    tags: ["retrieval", "multiturn", "coverage", "multilingual", "referent-resolution"],
    history: courseNamedBehindContactFormItalian("dal 3/10/2031 al 5/10/2031", "Il silenzio del cuore"),
    routineStartState: contactFormAwaitingName,
    query: FULL_QUOTE_FOR_THE_EVENT_ITALIAN,
    assertions: [
      { type: "turn_route", route: "retrieval" },
      { type: "turn_answer_coverage", coverage: "unanswered" },
      // Neither residential course's prices may stand in for the named course's quote.
      { type: "answer_does_not_contain", pattern: "280", matchMode: "substring" },
      { type: "answer_does_not_contain", pattern: "220", matchMode: "substring" },
      { type: "answer_does_not_contain", pattern: "260", matchMode: "substring" },
      { type: "answer_does_not_contain", pattern: "180", matchMode: "substring" },
      ...MOUNTAIN_COURSE_FIGURES_ABSENT,
    ],
  },
  requestedPeriodRelationCase({
    id: "requested-period-relation-en",
    language: "English",
    query: "What's on at Lantern Hall in the week of 10 March 2031?",
  }),
  requestedPeriodRelationCase({
    id: "requested-period-relation-it",
    language: "Italian",
    query: "Cosa c'è alla Lantern Hall nella settimana del 10 marzo 2031?",
  }),
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
  quickReplyCase({
    id: "quick-reply-greeting-en",
    name: "An English greeting is answered by the planner's own reply",
    kind: "greeting",
    language: "English",
    query: "Hello!",
    expectedAnswer: "A greeting in English, optionally followed by a generic invitation to ask something. It states no facts.",
  }),
  quickReplyCase({
    id: "quick-reply-thanks-en",
    name: "English thanks after an answer is answered by the planner's own reply",
    kind: "thanks",
    language: "English",
    history: refundExchangeEnglish,
    query: "Thanks, that's really helpful!",
    expectedAnswer: "A reply to the customer's thanks in English (for example, that they are welcome), optionally with a generic invitation to ask anything else. It states no facts.",
  }),
  quickReplyCase({
    id: "quick-reply-farewell-en",
    name: "An English farewell is answered by the planner's own reply",
    kind: "farewell",
    language: "English",
    history: refundExchangeEnglish,
    query: "That's all I needed. Bye!",
    expectedAnswer: "A farewell in English, optionally wishing the customer well. It states no facts.",
  }),
  quickReplyCase({
    id: "quick-reply-acknowledgement-en",
    name: "An English acknowledgement of a plain answer is answered by the planner's own reply",
    kind: "acknowledgement",
    language: "English",
    history: refundExchangeEnglish,
    query: "Ok, got it.",
    expectedAnswer: "A brief acknowledgement in English that the customer has what they needed, optionally with a generic invitation to ask anything else. It states no facts.",
  }),
  quickReplyCase({
    id: "quick-reply-greeting-it",
    name: "An Italian greeting is answered by the planner's own reply, in Italian",
    kind: "greeting",
    language: "Italian",
    query: "Ciao!",
    expectedAnswer: "A greeting in Italian, optionally followed by a generic invitation to ask something. It states no facts.",
  }),
  quickReplyCase({
    id: "quick-reply-thanks-it",
    name: "Italian thanks after an answer is answered by the planner's own reply, in Italian",
    kind: "thanks",
    language: "Italian",
    history: refundExchangeItalian,
    query: "Grazie mille, molto gentile!",
    expectedAnswer: "A reply to the customer's thanks in Italian (for example, prego), optionally with a generic invitation to ask anything else. It states no facts.",
  }),
  quickReplyCase({
    id: "quick-reply-farewell-it",
    name: "An Italian farewell is answered by the planner's own reply, in Italian",
    kind: "farewell",
    language: "Italian",
    history: refundExchangeItalian,
    query: "Perfetto, è tutto. Arrivederci!",
    expectedAnswer: "A farewell in Italian, optionally wishing the customer well. It states no facts.",
  }),
  quickReplyCase({
    id: "quick-reply-acknowledgement-it",
    name: "An Italian acknowledgement of a plain answer is answered by the planner's own reply, in Italian",
    kind: "acknowledgement",
    language: "Italian",
    history: refundExchangeItalian,
    query: "Va bene, capito.",
    expectedAnswer: "A brief acknowledgement in Italian that the customer has what they needed, optionally with a generic invitation to ask anything else. It states no facts.",
  }),
  {
    id: "quick-reply-not-greeting-with-question",
    name: "A greeting that carries a question is retrieved and composed, not a quick reply",
    tags: ["quick-reply", "routing"],
    query: "Hi, are you open on Sunday?",
    assertions: [
      { type: "turn_route", route: "retrieval" },
      { type: "turn_reply_source", source: "composer" },
    ],
  },
  {
    id: "quick-reply-not-thanks-with-question",
    name: "Thanks that carries a price question is retrieved and composed, not a quick reply",
    tags: ["quick-reply", "routing"],
    history: refundExchangeEnglish,
    query: "Thanks! And how much is the Pro plan?",
    assertions: [
      { type: "turn_route", route: "retrieval" },
      { type: "turn_reply_source", source: "composer" },
    ],
  },
  {
    id: "quick-reply-not-ack-pending-clarification",
    name: "An acknowledgement while the assistant's question is still open is composed, not a quick reply",
    description:
      "The assistant asked which plan the customer means; a bare \"ok\" leaves that question open, so the composer answers it rather than the planner closing the exchange.",
    tags: ["quick-reply", "clarification"],
    history: [
      { role: "user", content: "How much does a plan cost?" },
      { role: "assistant", content: "Do you mean the Pro plan or the Team plan?" },
    ],
    query: "ok",
    assertions: [
      { type: "turn_route", route: "direct" },
      { type: "turn_reply_source", source: "composer" },
      {
        type: "llm_judge",
        expectedAnswer: "Asks again which plan the customer means, the Pro plan or the Team plan.",
        criteria: "The reply keeps the open question moving (asks which plan, or offers both) and does not treat the conversation as finished. It does not invent a price.",
      },
    ],
  },
  {
    id: "quick-reply-not-greeting-with-request",
    name: "A greeting that carries a request is retrieved and composed, not a quick reply",
    tags: ["quick-reply", "routing"],
    query: "Good morning! I'd like to cancel my subscription.",
    assertions: [
      { type: "turn_route", route: "retrieval" },
      { type: "turn_reply_source", source: "composer" },
    ],
  },
  {
    id: "quick-reply-not-capabilities",
    name: "A question about what the assistant can do is composed, not a quick reply",
    tags: ["quick-reply", "identity"],
    query: "What can you help me with?",
    assertions: [
      { type: "turn_route", route: "direct" },
      { type: "turn_reply_source", source: "composer" },
    ],
  },
  {
    id: "quick-reply-not-price",
    name: "A price request is retrieved and composed, not a quick reply",
    tags: ["quick-reply", "retrieval"],
    query: "How much is the Pro plan?",
    assertions: [
      { type: "turn_route", route: "retrieval" },
      { type: "turn_reply_source", source: "composer" },
    ],
  },
  {
    id: "quick-reply-unlisted-language-standing-directive",
    name: "A greeting in a language the agent does not answer in follows the always-on language directive",
    description:
      "An always-on directive names English and Italian as the agent's only languages. A standing directive is operator-authored truth, so the planner may repeat what it says word for word in a quick reply, or the composer may answer; either way the reply is in a listed language and claims nothing beyond the directive's wording.",
    tags: ["quick-reply", "directive", "language", ZERO_TOLERANCE_JUDGE_TAG],
    agentConfigOverride: { authoredDirectives: seedDirectiveConfigWith(listedLanguagesDirective) },
    query: "こんにちは！",
    assertions: [
      { type: "turn_route", route: "direct" },
      // Hiragana, katakana, and CJK ideographs: a script check, not a vocabulary list.
      { type: "answer_does_not_contain", pattern: "[\\u3040-\\u30ff\\u4e00-\\u9fff]", matchMode: "regex" },
      {
        type: "llm_judge",
        expectedAnswer: "A greeting written in English or Italian, optionally saying the assistant can help in English or Italian. It states no other facts.",
        criteria: `The reply is written in English or Italian, not Japanese. The agent's always-on directive supplies "I can help in English or Italian", so saying that is allowed. ${NO_FACTUAL_PROPOSITION_RUBRIC}`,
      },
    ],
  },
  {
    id: "quick-reply-not-repeat",
    name: "A request to repeat the previous answer is composed, not a quick reply",
    tags: ["quick-reply", "routing"],
    history: refundExchangeEnglish,
    query: "Can you repeat that?",
    assertions: [
      { type: "turn_route", route: "retrieval" },
      { type: "turn_reply_source", source: "composer" },
    ],
  },
  {
    id: "quick-reply-not-yes-after-options",
    name: "A bare yes after the assistant offered two options is composed, not a quick reply",
    tags: ["quick-reply", "routing"],
    history: [
      { role: "user", content: "I'm thinking about upgrading." },
      {
        role: "assistant",
        content: "I can explain what the Pro plan costs, or walk you through how refunds work if it doesn't suit you. Which would you like?",
      },
    ],
    query: "yes",
    assertions: [
      { type: "turn_route", route: "retrieval" },
      { type: "turn_reply_source", source: "composer" },
    ],
  },
  {
    id: "email-review-covered-refund",
    name: "An emailed refund question the policy covers is drafted and not sent",
    description:
      "A review turn, as the email channel runs one: the customer's message is already recorded and the reply comes back as a draft, and the conversation gains no assistant message. The 30-day refund window covers the question, but the turn sometimes asks which sense the customer means instead of answering; that ask is a non-retrieval reply with no grounding or coverage verdict, so the case asserts neither.",
    tags: ["email", "review", "grounding", "coverage"],
    executionMode: "review",
    query: "Hi, I bought an annual plan two weeks ago and it isn't working out for us. Can I still get a full refund?",
    assertions: [{ type: "turn_persists_no_reply" }],
  },
  {
    id: "email-review-uncovered-nonprofit-discount",
    name: "An emailed question the corpus does not answer is drafted and not sent",
    description:
      "A review turn on a question next to the pricing material that no document answers: the reply comes back as a draft and the conversation gains no assistant message. The turn mostly asks which plan or discount the customer means, a non-retrieval reply with no grounding or coverage verdict, so the case asserts neither.",
    tags: ["email", "review", "grounding", "coverage"],
    executionMode: "review",
    query: "Hello, we are a registered charity. Do you offer a nonprofit discount on your plans?",
    assertions: [{ type: "turn_persists_no_reply" }],
  },
];
