import type { ConversationQualityCase } from "../../../src/modules/eval/suite/index.js";
import type { ConversationQualityDocument } from "./corpus.js";

/**
 * Narrowing follow-up fixtures (#1873). The visitor asks a broad question, gets the broad answer,
 * then narrows it in a message that names only the new part and no pronoun ("I mean in the
 * routine"). The narrowed question is answered by one section of the routine fields page; the
 * workspace also holds several pages about sensitive data in general, as a product's help centre
 * does. So the answer is right only when the rewrite keeps both the earlier subject and the new
 * constraint:
 *
 * - a rewrite that drops the constraint, or reads "routine" as "usual", searches for sensitive
 *   data alone: the general pages outrank the routine fields page and the answer repeats the first;
 * - a rewrite that drops the earlier subject searches for routines alone: the page on building a
 *   routine answers it and says nothing about sensitive data;
 * - only the routine fields page states the figure each case asserts.
 *
 * More cases hold the other sides. A follow-up that replaces part of the question instead of
 * adding to it ("And the Pro plan?" after the Starter plan, "Und nach Österreich?" after shipping
 * to Germany), or names a topic of its own ("What about pricing?"), must not carry the replaced
 * part or the earlier subject into any search. A follow-up that asks one attribute of the earlier
 * subject ("What about the price?" after the Voice add-on, "E il prezzo?" after the Translation
 * add-on) must keep that subject, or a page that names another add-on's price answers it.
 *
 * A corpus this small hands the answer most of its pages, so a rewrite that loses half the
 * question can still reach the routine fields page further down the evidence. The cases also
 * require that page among the first two retrieved: in a help centre with more pages about
 * sensitive data, a page ranked below the general ones falls out of the answer's context.
 *
 * The pages come in English and Italian, as a bilingual help centre has them, and run in a
 * workspace of their own, seeded with them alone: the shared corpus's security page answers
 * "sensitive data" too, and its seeded routines would compete for a message about a routine.
 */
export const ROUTINE_FIELDS_DOC_ID = "22222222-2222-4222-8222-222222222220";
export const ROUTINE_FIELDS_IT_DOC_ID = "22222222-2222-4222-8222-222222222221";
export const PRO_PLAN_DOC_ID = "22222222-2222-4222-8222-222222222236";
export const SHIPPING_TO_AUSTRIA_DOC_ID = "22222222-2222-4222-8222-222222222238";
export const VOICE_ADD_ON_DOC_ID = "22222222-2222-4222-8222-222222222239";
export const TRANSLATION_ADD_ON_IT_DOC_ID = "22222222-2222-4222-8222-222222222241";

const page = (id: string, title: string, paragraphs: string[]): ConversationQualityDocument => ({
  id,
  title,
  content: [title, "", ...paragraphs].join("\n"),
});

/**
 * The narrowed answer: from the routine fields page, led by it, with its consent step and
 * 14-day erasure, and without the 90-day transcript retention the first answer gave.
 */
const narrowedAnswerAssertions = (documentId: string, consentWord: string): ConversationQualityCase["assertions"] => [
  { type: "turn_route", route: "retrieval" },
  { type: "retrieval_top_k_includes_document", documentId, k: 2 },
  { type: "answer_cites_document", documentId },
  { type: "answer_contains", pattern: consentWord, matchMode: "substring" },
  { type: "answer_contains", pattern: "14", matchMode: "substring" },
  { type: "answer_does_not_contain", pattern: "90", matchMode: "substring" },
];

const englishPages: ConversationQualityDocument[] = [
  page("22222222-2222-4222-8222-222222222223", "Handling sensitive data", [
    "Quillfern treats health details, identity numbers, and payment details as sensitive data.",
    "Sensitive data is encrypted, every view of it is logged, and it is never used to train models.",
    "This page is the overview; the pages below explain how sensitive data is stored, who can see it, and how it is erased.",
  ]),
  page("22222222-2222-4222-8222-222222222224", "Data retention and erasure", [
    "Quillfern keeps conversation transcripts for 90 days and then deletes them automatically, sensitive data included.",
    "To have a visitor's personal or sensitive data erased sooner, email privacy@quillfern.example. Erasure requests are completed within 72 hours.",
  ]),
  page("22222222-2222-4222-8222-222222222225", "Encryption of sensitive data", [
    "Sensitive data is encrypted at rest with AES-256 and in transit with TLS 1.3.",
    "Encryption keys are held in a managed key service and rotated every 90 days.",
  ]),
  page("22222222-2222-4222-8222-222222222226", "Who can see sensitive data", [
    "Only workspace owners and admins can see sensitive data. Members and viewers see it masked.",
    "Every time someone opens sensitive data, the audit log records who did it and when.",
  ]),
  page("22222222-2222-4222-8222-222222222227", "Sensitive data in uploaded documents", [
    "Before an uploaded document is indexed, Quillfern finds payment card numbers and identity numbers in it and replaces them with [redacted].",
    "The original file is deleted 7 days after upload, so sensitive data in it is not kept.",
  ]),
  page("22222222-2222-4222-8222-222222222228", "Sensitive data in chat transcripts", [
    "When a visitor types a payment card number or an identity number into the chat, the transcript stores it masked.",
    "Operators see the last four digits only, and the full value is never sent to the model.",
  ]),
  page("22222222-2222-4222-8222-222222222229", "Building a routine", [
    "A routine is a multi-step flow the agent runs to carry a request to the end, such as booking a demo or starting a return.",
    "Each step asks the visitor for one or more fields, and the routine ends with a confirmation or a hand-off to a person.",
    "Routines are built on the Routines page. Only published routines can start in a conversation.",
  ]),
  page(ROUTINE_FIELDS_DOC_ID, "Routine fields", [
    "Each routine step collects one or more fields: a name, an email address, a date, or a choice from a list. A field can be required or optional.",
    "A field that collects health details or other sensitive data is a sensitive field. Before the routine asks for a sensitive field, the agent asks the visitor for consent; if the visitor declines, the routine skips the field and offers a hand-off to a person.",
    "Sensitive fields are masked in operator notifications and erased from the routine record 14 days after the routine ends.",
  ]),
];

const italianPages: ConversationQualityDocument[] = [
  page("22222222-2222-4222-8222-222222222230", "Gestione dei dati sensibili", [
    "Quillfern considera dati sensibili le informazioni sulla salute, i numeri di documento e i dati di pagamento.",
    "I dati sensibili sono cifrati, ogni accesso viene registrato e non vengono mai usati per addestrare modelli.",
    "Questa pagina è la panoramica; le pagine seguenti spiegano come i dati sensibili vengono conservati, chi può vederli e come vengono cancellati.",
  ]),
  page("22222222-2222-4222-8222-222222222231", "Conservazione e cancellazione dei dati", [
    "Quillfern conserva le trascrizioni delle conversazioni per 90 giorni e poi le cancella automaticamente, dati sensibili compresi.",
    "Per far cancellare prima i dati personali o sensibili di un visitatore, scrivi a privacy@quillfern.example. Le richieste di cancellazione vengono completate entro 72 ore.",
  ]),
  page("22222222-2222-4222-8222-222222222232", "Cifratura dei dati sensibili", [
    "I dati sensibili sono cifrati a riposo con AES-256 e in transito con TLS 1.3.",
    "Le chiavi di cifratura sono custodite in un servizio di gestione delle chiavi e ruotate ogni 90 giorni.",
  ]),
  page("22222222-2222-4222-8222-222222222233", "Chi può vedere i dati sensibili", [
    "Solo i proprietari e gli amministratori del workspace possono vedere i dati sensibili. Membri e lettori li vedono mascherati.",
    "Ogni volta che qualcuno apre dei dati sensibili, il registro di audit annota chi è stato e quando.",
  ]),
  page("22222222-2222-4222-8222-222222222234", "Creare una routine", [
    "Una routine è un flusso in più passaggi che l'agente esegue per portare a termine una richiesta, come prenotare una demo o avviare un reso.",
    "Ogni passaggio chiede al visitatore uno o più campi, e la routine termina con una conferma o con il passaggio a una persona.",
    "Le routine si creano dalla pagina Routine. Solo le routine pubblicate possono partire in una conversazione.",
  ]),
  page(ROUTINE_FIELDS_IT_DOC_ID, "Campi della routine", [
    "Ogni passaggio di una routine raccoglie uno o più campi: un nome, un indirizzo email, una data o una scelta da un elenco. Un campo può essere obbligatorio o facoltativo.",
    "Un campo che raccoglie informazioni sulla salute o altri dati sensibili è un campo sensibile. Prima che la routine chieda un campo sensibile, l'agente chiede il consenso al visitatore; se il visitatore rifiuta, la routine salta il campo e offre il passaggio a una persona.",
    "I campi sensibili sono mascherati nelle notifiche agli operatori e cancellati dal registro della routine 14 giorni dopo la fine della routine.",
  ]),
];

/** Plan pages and a German shipping pair, for follow-ups that replace part of the question instead of adding to it. */
const replacementPages: ConversationQualityDocument[] = [
  page("22222222-2222-4222-8222-222222222235", "Starter plan", [
    "Quillfern Starter is free for one agent and up to 500 conversations a month.",
  ]),
  page(PRO_PLAN_DOC_ID, "Pro plan", [
    "Quillfern Pro costs 39 euro a month per workspace, for up to five agents and 5,000 conversations a month.",
  ]),
  page("22222222-2222-4222-8222-222222222237", "Versand nach Deutschland", [
    "Das Quillfern-Display ist ein Tischaufsteller mit QR-Code, der den Chat öffnet.",
    "Innerhalb Deutschlands kommt das Display in 2 Werktagen an. Der Versand kostet 4,90 Euro.",
  ]),
  page(SHIPPING_TO_AUSTRIA_DOC_ID, "Versand nach Österreich", [
    "Nach Österreich kommt das Quillfern-Display in 5 Werktagen an. Der Versand kostet 9,90 Euro.",
  ]),
];

/**
 * Two add-ons per language, for a follow-up that asks one attribute of the earlier subject ("What
 * about the price?"). The other add-on's page names its price with the request's own word, so a
 * search for the attribute alone finds that page, not the earlier subject's.
 */
const attributePages: ConversationQualityDocument[] = [
  page(VOICE_ADD_ON_DOC_ID, "Voice add-on", [
    "The Voice add-on lets visitors call a phone number and talk to the agent.",
    "It costs 12 euro a month per workspace.",
  ]),
  page("22222222-2222-4222-8222-222222222240", "WhatsApp add-on", [
    "The WhatsApp add-on connects the agent to a WhatsApp Business number.",
    "Price: the WhatsApp add-on costs 19 euro a month per workspace, and the price includes 1,000 conversations a month.",
  ]),
  page(TRANSLATION_ADD_ON_IT_DOC_ID, "Componente aggiuntivo Traduzione", [
    "Il componente aggiuntivo Traduzione traduce le risposte dell'agente nella lingua del visitatore.",
    "Costa 7,50 euro al mese per workspace.",
  ]),
  page("22222222-2222-4222-8222-222222222242", "Componente aggiuntivo Archivio", [
    "Il componente aggiuntivo Archivio esporta le conversazioni in un file ogni settimana.",
    "Prezzo: il prezzo del componente aggiuntivo Archivio è di 15 euro al mese per workspace.",
  ]),
];

export const refinementDocuments: ConversationQualityDocument[] = [
  ...englishPages,
  ...italianPages,
  ...replacementPages,
  ...attributePages,
];

const sensitiveDataExchange: ConversationQualityCase["history"] = [
  { role: "user", content: "How do you handle sensitive data?" },
  {
    role: "assistant",
    content:
      "Conversation transcripts are kept for 90 days and then deleted automatically. You can ask for a visitor's data to be erased sooner by emailing privacy@quillfern.example; erasure requests are completed within 72 hours.",
  },
];

export const refinementCases: ConversationQualityCase[] = [
  {
    id: "refinement-narrows-previous-question-en",
    name: "A follow-up that only names where the question applies keeps the earlier subject and answers the narrowed question",
    description:
      "The visitor asks how sensitive data is handled, gets the retention answer, then writes \"I mean in the routine\". The narrowed question is sensitive data in routines: the routine fields page states the consent step and the 14-day erasure. Repeating the retention answer, answering about sensitive data in general, or answering about routines in general fails (#1873).",
    tags: ["retrieval", "multiturn", "refinement"],
    history: sensitiveDataExchange,
    query: "I mean in the routine",
    assertions: narrowedAnswerAssertions(ROUTINE_FIELDS_DOC_ID, "consent"),
  },
  {
    id: "refinement-narrows-previous-question-it",
    name: "An Italian follow-up that only names where the question applies keeps the earlier subject and answers the narrowed question",
    description:
      "The same exchange in Italian: the visitor asks how sensitive data is handled, gets the retention answer, then writes \"Intendo nella routine\" (I mean in the routine). The Italian routine fields page states the consent step and the 14-day erasure (#1873).",
    tags: ["retrieval", "multiturn", "multilingual", "refinement"],
    history: [
      { role: "user", content: "Come gestite i dati sensibili?" },
      {
        role: "assistant",
        content:
          "Conserviamo le trascrizioni delle conversazioni per 90 giorni e poi le cancelliamo automaticamente. Puoi chiedere di cancellare prima i dati di un visitatore scrivendo a privacy@quillfern.example; le richieste vengono completate entro 72 ore.",
      },
    ],
    query: "Intendo nella routine",
    assertions: narrowedAnswerAssertions(ROUTINE_FIELDS_IT_DOC_ID, "consenso"),
  },
  {
    id: "refinement-swaps-plan-en",
    name: "A follow-up that names another plan in place of the earlier one searches for that plan, not the earlier one",
    description:
      "The visitor asks what the Starter plan costs, then writes \"And the Pro plan?\". The follow-up replaces the subject, so no search may carry Starter forward, and the Pro plan page states 39 euro a month (#1873).",
    tags: ["retrieval", "multiturn", "refinement"],
    history: [
      { role: "user", content: "How much is the Starter plan?" },
      { role: "assistant", content: "The Starter plan is free, for one agent and up to 500 conversations a month." },
    ],
    query: "And the Pro plan?",
    assertions: [
      { type: "turn_route", route: "retrieval" },
      { type: "retrieval_includes_document", documentId: PRO_PLAN_DOC_ID },
      { type: "answer_contains", pattern: "39", matchMode: "substring" },
      { type: "turn_queries_exclude", term: "Starter" },
    ],
  },
  {
    id: "refinement-swaps-place-de",
    name: "A German follow-up that names another country for the same question searches for that country, not the earlier one",
    description:
      "The visitor asks what shipping to Germany costs, then writes \"Und nach Österreich?\" (and to Austria?). The country is replaced and the question kept: no search may name Germany, and the Austria page's 9,90 euro answers it, not the German 4,90 (#1873).",
    tags: ["retrieval", "multiturn", "multilingual", "refinement"],
    history: [
      { role: "user", content: "Was kostet der Versand nach Deutschland?" },
      { role: "assistant", content: "Innerhalb Deutschlands kostet der Versand des Displays 4,90 Euro, und es kommt in 2 Werktagen an." },
    ],
    query: "Und nach Österreich?",
    assertions: [
      { type: "turn_route", route: "retrieval" },
      { type: "retrieval_includes_document", documentId: SHIPPING_TO_AUSTRIA_DOC_ID },
      { type: "answer_contains", pattern: "9,90", matchMode: "substring" },
      { type: "answer_does_not_contain", pattern: "4,90", matchMode: "substring" },
      { type: "turn_queries_exclude", term: "Deutschland" },
    ],
  },
  {
    id: "refinement-attribute-of-earlier-subject-en",
    name: "A follow-up that asks one attribute of the earlier subject keeps that subject",
    description:
      "The visitor asks about the Voice add-on, then writes \"What about the price?\". The price belongs to the Voice add-on, so the turn keeps it as the subject: the answer cites the Voice add-on page and its 12 euro, not the WhatsApp add-on page, which names its 19 euro price with the request's own word (#1873).",
    tags: ["retrieval", "multiturn", "refinement"],
    history: [
      { role: "user", content: "Tell me about the Voice add-on." },
      { role: "assistant", content: "The Voice add-on lets visitors call a phone number and talk to the agent." },
    ],
    query: "What about the price?",
    assertions: [
      { type: "turn_route", route: "retrieval" },
      { type: "answer_cites_document", documentId: VOICE_ADD_ON_DOC_ID },
      { type: "answer_contains", pattern: "12", matchMode: "substring" },
      { type: "answer_does_not_contain", pattern: "19", matchMode: "substring" },
    ],
  },
  {
    id: "refinement-attribute-of-earlier-subject-it",
    name: "An Italian follow-up that asks one attribute of the earlier subject keeps that subject",
    description:
      "The visitor asks about the Translation add-on, then writes \"E il prezzo?\" (and the price?). The answer cites the Translation add-on page and its 7,50 euro, not the Archive add-on page, which names its 15 euro price with the request's own word (#1873).",
    tags: ["retrieval", "multiturn", "multilingual", "refinement"],
    history: [
      { role: "user", content: "Parlami del componente aggiuntivo Traduzione." },
      { role: "assistant", content: "Il componente aggiuntivo Traduzione traduce le risposte dell'agente nella lingua del visitatore." },
    ],
    query: "E il prezzo?",
    assertions: [
      { type: "turn_route", route: "retrieval" },
      { type: "answer_cites_document", documentId: TRANSLATION_ADD_ON_IT_DOC_ID },
      { type: "answer_contains", pattern: "7,50", matchMode: "substring" },
      { type: "answer_does_not_contain", pattern: "15", matchMode: "substring" },
    ],
  },
  {
    id: "refinement-fresh-subject-after-sensitive-data-en",
    name: "A follow-up that names a subject of its own does not carry the earlier subject into its searches",
    description:
      "After the sensitive data exchange the visitor asks \"What about pricing?\". Pricing is a subject of its own, not a narrowing of the earlier question: no search may name sensitive data, and the plan pages answer it (#1873).",
    tags: ["retrieval", "multiturn", "refinement"],
    history: sensitiveDataExchange,
    query: "What about pricing?",
    assertions: [
      { type: "turn_route", route: "retrieval" },
      { type: "retrieval_includes_document", documentId: PRO_PLAN_DOC_ID },
      { type: "answer_contains", pattern: "39", matchMode: "substring" },
      { type: "turn_queries_exclude", term: "sensitive" },
    ],
  },
];
