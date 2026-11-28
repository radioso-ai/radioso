import type { ConversationQualityCase } from "../../../src/modules/eval/suite/index.js";
import type { ConversationQualityDocument } from "./corpus.js";

/**
 * Sectioned page fixtures (#1876): an invented product's markdown pricing page with one heading
 * per plan, each section opening with the plan's name and its price, the shape a generated price
 * page has. The case asks for the third plan's price. Two other passages of the page name that plan
 * in passing and hold every query word, so they rank above the section that states its price; an
 * answer that never reads the section declines, or quotes the price one heading above it.
 *
 * A help page on changing plans competes with it: it names Planet and every query word in passing
 * and states no price, so the answer's room is shared between two documents, as in a real workspace.
 *
 * The section that answers is headed with the plan's bare name and never says "plan", so a lexical
 * search for the question's full phrase never finds it (#1912). An Italian product's pricing page and
 * help page repeat that shape, so the case asking for "il piano Maestrale" holds it in a second
 * language. Its plans carry names of their own, so neither language's search finds the other's
 * sections.
 *
 * Searching the bare name beside the phrase must not turn every passage holding the name into
 * evidence. Three counter-cases hold that line: a plan named by a common word ("free") beside a
 * support page that uses the word in passing; a plan no page sells ("Gold") beside a sponsorship
 * page whose tier shares its name; and a plan two products sell under one name ("Pro"), which asks
 * which product is meant.
 *
 * The pages run in a workspace of their own, seeded with them alone: they describe products the
 * shared corpus's own pricing page does not sell, so every "which plans" case there would read them.
 */
export const SECTIONED_PLANS_DOC_ID = "22222222-2222-4222-8222-222222222218";
const PLAN_CHANGE_HELP_DOC_ID = "22222222-2222-4222-8222-222222222219";
export const SECTIONED_PLANS_IT_DOC_ID = "22222222-2222-4222-8222-222222222220";
const PLAN_CHANGE_HELP_IT_DOC_ID = "22222222-2222-4222-8222-222222222221";
const SUPPORT_DOC_ID = "22222222-2222-4222-8222-222222222223";
const SUMMIT_SPONSORSHIP_DOC_ID = "22222222-2222-4222-8222-222222222224";
const QUILLMARK_PLANS_DOC_ID = "22222222-2222-4222-8222-222222222225";
const HARBORLINE_PLANS_DOC_ID = "22222222-2222-4222-8222-222222222226";

export const sectionedPageDocuments: ConversationQualityDocument[] = [
  {
    id: SECTIONED_PLANS_DOC_ID,
    title: "Lumenfold plans and pricing",
    content: [
      "# Lumenfold plans and pricing",
      "",
      "Generated from the pricing page at https://lumenfold.example/pricing. These are the current",
      "commercial facts for Lumenfold Cloud and the open-source edition.",
      "",
      "## Plans on Lumenfold Cloud",
      "",
      "Lumenfold Cloud is priced on conversations. There are no per-seat fees and no",
      "per-resolution fees. Every product feature is available on every plan,",
      "including the free one. Listed prices exclude VAT.",
      "",
      "",
      "### Comet",
      "",
      "Comet is free. It includes 50 conversations a month and 10 MB of content, up to 300 documents, with unlimited agents and seats, every channel (website embed, REST API, TypeScript SDK, Slack, MCP), and community support.",
      "",
      "Models: models on us. Over the limit: move up to Satellite.",
      "",
      "### Satellite",
      "",
      "Satellite costs €149 a month, or €1,490 a year (two months free). It includes 1,000 conversations a month and 20 MB of content, up to 5,000 documents, with unlimited agents and seats, every channel (website embed, REST API, TypeScript SDK, Slack, MCP), and email support.",
      "",
      "Models: models included, no keys to set up. Over the limit: €50 for 300 more.",
      "",
      "### Planet",
      "",
      "Planet costs €579 a month, or €5,790 a year (two months free). It includes 5,000 conversations a month and 100 MB of content, up to 20,000 documents, with unlimited agents and seats, every channel (website embed, REST API, TypeScript SDK, Slack, MCP), and priority support and a quarterly review.",
      "",
      "Models: your model keys or ours. Over the limit: €50 for 300 more.",
      "",
      "### Star",
      "",
      "Star is the tier above Planet, by agreement: More than 5,000 conversations a month, on your keys or ours. There is no self-serve checkout for Star; email hello@lumenfold.example.",
      "",
      "### Top-ups",
      "",
      "On the paid plans you can buy 300 additional conversations for €50. One-off, no subscription. Lasts 12 months. Top-ups are not available on the free plan; the next step from there is Satellite.",
      "",
      "### Managed service",
      "",
      "We set up your agent, tune it, and review what your visitors asked every month. It is priced by agreement, on top of any plan including the free one, and there is no listed price. It is a service, not a software tier: the software is the same. To arrange it, email hello@lumenfold.example.",
      "",
      "## What counts as a conversation",
      "",
      "A conversation is one person talking to one agent, up to 10 agent replies. Retrieval, tool calls, and the internal steps of a routine are not counted separately: a routine that takes six internal steps to produce one reply is still one reply. A conversation that runs past 10 replies counts as another conversation for each further 10.",
      "",
      "An operator's own work with the agent also counts against the monthly allowance, lightly:",
      "",
      "- A customer conversation, up to 10 replies: 1",
      "- A message to the operator assistant: 0.5",
      "- A test run in Workbench or evals: 0.5",
      "- An on-demand Audience Pulse report: 10",
      "- Publishing routines, crawling, indexing: 0",
      "",
      "Every line appears in the workspace usage view.",
      "",
      "## Which model answers",
      "",
      "On Lumenfold's keys, every plan uses OpenAI GPT-5.4 mini for answers, with smaller models for the steps around it (query rewriting, reranking, classification). There are no model multipliers and no credit tables. On Planet the customer can add their own model keys and choose any model; the platform price is the same either way, and with their own keys the customer pays their model provider directly.",
      "",
      "## Content storage",
      "",
      "Storage counts the text of the documents and pages given to the agent and how many there are; each plan above lists both limits, and each page of a crawled site is one document. Embeddings and the search index do not count. At either limit, new uploads pause until content is removed or the workspace moves up a plan, and nothing already indexed is deleted.",
      "",
      "## What happens at the limit",
      "",
      "The dashboard warns at 80 percent of the monthly limit. At the limit, the workspace can move up a plan, or on the paid plans buy a top-up. Nothing is charged without the customer asking, and there is no overage bill at the end of the month.",
      "",
      "Unused monthly conversations do not roll over; the allowance resets on the billing date, on monthly and annual plans alike. Conversations in a top-up pack stay available for 12 months from purchase.",
      "",
      "## Self-hosting (Own Galaxy)",
      "",
      "Every product feature is open source: grounded answers, directives, routines, actions, every channel. Run it on your own infrastructure with your own model keys, and nothing routes through us. There is no conversation limit and no markup on inference.",
      "",
      "One organization per install, which covers any company hosting for itself. Running many separate organizations off a single deployment is reserved for the Enterprise Edition.",
      "",
      "Lumenfold Cloud and the self-hosted release are the same open-source code. The cloud is Lumenfold running the servers, not a different product, and you can move between them in either direction.",
      "",
      "## Do I need the Enterprise Edition to self-host?",
      "",
      "No. Every product feature is in the open-source release, and a self-hosted install runs on your own model keys with no conversation limit.",
      "",
      "The Enterprise Edition is the commercial layer behind Lumenfold Cloud: plans, billing, usage limits, and running many separate organizations from a single deployment. A company self-hosting Lumenfold for its own use is one organization and needs none of it. Nothing in the Enterprise Edition is a product feature that self-hosters or cloud customers are missing.",
      "",
      "## Is anything gated behind a paid plan?",
      "",
      "No. Every product feature is available on the free plan, on every paid plan, and in the open-source release. Plans differ only in the number of conversations per month, the amount of content, who pays for the models, and the level of support.",
      "",
      "Usage limits on Lumenfold Cloud are volume limits, not feature gates. A `usage_limit_exceeded` response means the workspace has used its monthly conversations; the answer is to move up a plan or buy a top-up, and no feature is being withheld.",
      "",
      "## How to get started",
      "",
      "Create a workspace at https://app.lumenfold.example. The free plan needs no card. To self-host, follow https://docs.lumenfold.example/quickstarts/run-locally. To talk to the team, email hello@lumenfold.example.",
    ].join("\n"),
  },
  {
    id: PLAN_CHANGE_HELP_DOC_ID,
    title: "Changing your Lumenfold plan",
    content: [
      "# Changing your Lumenfold plan",
      "",
      "You can change plan at any time from Settings → Billing. Moving up, for example from Satellite to Planet, takes effect at once, and the difference is charged pro rata for the rest of the month. Moving down takes effect at the next renewal, so a workspace on the Planet plan keeps its Planet limits until then.",
      "",
      "Agents, documents, directives and routines stay as they are when the plan changes. If the workspace holds more content than the new plan allows, nothing is deleted: new uploads wait until the content fits or the plan moves up again.",
      "",
      "Annual plans renew on the date they started. Switching between monthly and annual billing on the same plan takes effect at the next renewal.",
      "",
      "Questions about an invoice go to billing@lumenfold.example.",
    ].join("\n"),
  },
  {
    id: SECTIONED_PLANS_IT_DOC_ID,
    title: "Piani e prezzi di Ventoluce",
    content: [
      "# Piani e prezzi di Ventoluce",
      "",
      "Generato dalla pagina dei prezzi su https://ventoluce.example/prezzi. Sono i dati commerciali",
      "attuali di Ventoluce Cloud e dell'edizione open source.",
      "",
      "## I piani di Ventoluce Cloud",
      "",
      "Ventoluce Cloud ha un prezzo basato sulle conversazioni. Non ci sono costi per postazione né",
      "costi per risoluzione. Ogni funzione del prodotto è disponibile in tutti i piani, compreso",
      "quello gratuito. I prezzi indicati sono IVA esclusa.",
      "",
      "",
      "### Brezza",
      "",
      "Brezza è gratuito. Comprende 50 conversazioni al mese e 10 MB di contenuti, fino a 300 documenti, con agenti e postazioni illimitati, tutti i canali (widget del sito, REST API, SDK TypeScript, Slack, MCP) e il supporto della community.",
      "",
      "Modelli: a carico nostro. Oltre il limite: si passa a Libeccio.",
      "",
      "### Libeccio",
      "",
      "Libeccio costa 139 € al mese, oppure 1.390 € all'anno (due mesi in omaggio). Comprende 1.000 conversazioni al mese e 20 MB di contenuti, fino a 5.000 documenti, con agenti e postazioni illimitati, tutti i canali (widget del sito, REST API, SDK TypeScript, Slack, MCP) e il supporto via email.",
      "",
      "Modelli: inclusi, nessuna chiave da configurare. Oltre il limite: 40 € per altre 300.",
      "",
      "### Maestrale",
      "",
      "Maestrale costa 469 € al mese, oppure 4.690 € all'anno (due mesi in omaggio). Comprende 5.000 conversazioni al mese e 100 MB di contenuti, fino a 20.000 documenti, con agenti e postazioni illimitati, tutti i canali (widget del sito, REST API, SDK TypeScript, Slack, MCP), il supporto prioritario e una revisione trimestrale.",
      "",
      "Modelli: le tue chiavi o le nostre. Oltre il limite: 40 € per altre 300.",
      "",
      "### Tramontana",
      "",
      "Tramontana è il livello sopra Maestrale, su accordo: più di 5.000 conversazioni al mese, con le tue chiavi o le nostre. Per Tramontana non c'è un acquisto self-service; scrivi a ciao@ventoluce.example.",
      "",
      "### Ricariche",
      "",
      "Sui piani a pagamento puoi acquistare 300 conversazioni in più per 40 €. Una tantum, senza abbonamento. Valgono 12 mesi. Le ricariche non sono disponibili sul piano gratuito; da lì il passo successivo è Libeccio.",
      "",
      "### Servizio gestito",
      "",
      "Configuriamo il tuo agente, lo mettiamo a punto e ogni mese rivediamo cosa hanno chiesto i tuoi visitatori. Il prezzo è su accordo, in aggiunta a qualsiasi livello, anche quello gratuito, e non ha un listino. È un servizio, non un livello del software: il software è lo stesso. Per attivarlo, scrivi a ciao@ventoluce.example.",
      "",
      "## Cosa conta come conversazione",
      "",
      "Una conversazione è una persona che parla con un agente, fino a 10 risposte dell'agente. Ricerca, chiamate agli strumenti e i passaggi interni di una routine non si contano a parte: una routine che fa sei passaggi interni per dare una risposta resta una risposta. Una conversazione che supera le 10 risposte conta come un'altra conversazione per ogni ulteriore blocco di 10.",
      "",
      "Anche il lavoro dell'operatore con l'agente conta sul limite mensile, in misura leggera:",
      "",
      "- Una conversazione con un cliente, fino a 10 risposte: 1",
      "- Un messaggio all'assistente dell'operatore: 0,5",
      "- Una prova in Workbench o nelle valutazioni: 0,5",
      "- Un rapporto Audience Pulse su richiesta: 10",
      "- Pubblicare routine, scansionare siti, indicizzare: 0",
      "",
      "Ogni voce compare nella vista dei consumi dello spazio di lavoro.",
      "",
      "## Quale modello risponde",
      "",
      "Con le chiavi di Ventoluce, ogni piano usa OpenAI GPT-5.4 mini per le risposte, con modelli più piccoli per i passaggi intorno (riscrittura della domanda, riordino, classificazione). Non ci sono moltiplicatori per modello né tabelle di crediti. Sul piano Maestrale il cliente può aggiungere le proprie chiavi e scegliere qualsiasi modello; il prezzo della piattaforma è lo stesso in entrambi i casi, e con le proprie chiavi il cliente paga direttamente il suo fornitore di modelli.",
      "",
      "## Archiviazione dei contenuti",
      "",
      "L'archiviazione conta il testo dei documenti e delle pagine date all'agente e quanti sono; ogni livello qui sopra indica entrambi i limiti, e ogni pagina di un sito scansionato è un documento. Gli embedding e l'indice di ricerca non contano. A uno dei due limiti, i nuovi caricamenti si fermano finché non si rimuovono contenuti o si passa a un livello superiore, e nulla di ciò che è già indicizzato viene cancellato.",
      "",
      "## Cosa succede al limite",
      "",
      "La dashboard avvisa all'80 per cento del limite mensile. Al limite, lo spazio di lavoro può passare a un livello superiore o, sui livelli a pagamento, acquistare una ricarica. Nulla viene addebitato senza che il cliente lo chieda, e non c'è una fattura per eccedenze a fine mese.",
      "",
      "## Come iniziare",
      "",
      "Crea uno spazio di lavoro su https://app.ventoluce.example. Il livello gratuito non richiede una carta. Per parlare con il team, scrivi a ciao@ventoluce.example.",
    ].join("\n"),
  },
  {
    id: PLAN_CHANGE_HELP_IT_DOC_ID,
    title: "Cambiare il piano Ventoluce",
    content: [
      "# Cambiare il piano Ventoluce",
      "",
      "Puoi cambiare piano in qualsiasi momento da Impostazioni → Fatturazione. Il passaggio a un piano superiore, per esempio da Libeccio a Maestrale, ha effetto subito, e la differenza viene addebitata in proporzione per il resto del mese. Il passaggio a un piano inferiore ha effetto al rinnovo successivo, quindi uno spazio di lavoro sul piano Maestrale mantiene i limiti di Maestrale fino ad allora.",
      "",
      "Agenti, documenti, direttive e routine restano come sono quando il piano cambia. Se lo spazio di lavoro contiene più contenuti di quanti il nuovo piano ne consenta, nulla viene cancellato: i nuovi caricamenti aspettano finché i contenuti non rientrano o il piano non sale di nuovo.",
      "",
      "I piani annuali si rinnovano alla data in cui sono iniziati. Il passaggio dalla fatturazione mensile a quella annuale sullo stesso piano ha effetto al rinnovo successivo.",
      "",
      "Le domande su una fattura vanno a fatturazione@ventoluce.example.",
    ].join("\n"),
  },
  {
    id: SUPPORT_DOC_ID,
    title: "Getting help with Lumenfold",
    content: [
      "# Getting help with Lumenfold",
      "",
      "## Writing to support",
      "",
      "Feel free to write to support@lumenfold.example with any question about your workspace. We answer within one working day, and feel free to attach screenshots.",
      "",
      "## Visiting the office",
      "",
      "Visitors to the Lumenfold office are welcome on weekdays. Free parking is available in the courtyard, and the coffee is free too.",
      "",
      "## The printed onboarding kit",
      "",
      "Every new workspace can order the printed onboarding kit, a short guide to setting up a first agent. The kit ships free of charge within the EU.",
    ].join("\n"),
  },
  {
    id: SUMMIT_SPONSORSHIP_DOC_ID,
    title: "Lumenfold Summit 2031 sponsorship",
    content: [
      "# Lumenfold Summit 2031 sponsorship",
      "",
      "The Lumenfold Summit is a one-day conference for people who run customer agents. Sponsors support the day and meet its guests.",
      "",
      "### Gold sponsor",
      "",
      "Gold sponsors get a booth in the main hall, four passes, and their logo on the stage screen. A Gold sponsorship costs €4,000.",
      "",
      "### Silver sponsor",
      "",
      "Silver sponsors get a table in the hallway and two passes. A Silver sponsorship costs €1,500.",
      "",
      "To sponsor the Summit, write to summit@lumenfold.example.",
    ].join("\n"),
  },
  {
    id: QUILLMARK_PLANS_DOC_ID,
    title: "Quillmark plans and pricing",
    content: [
      "# Quillmark plans and pricing",
      "",
      "Quillmark is a writing tool for documentation teams. Prices are per editor and exclude VAT.",
      "",
      "### Solo",
      "",
      "Solo costs €9 a month for one editor, with unlimited documents and a personal style guide.",
      "",
      "### Pro",
      "",
      "Pro costs €29 a month per editor. It adds version history, shared style guides, and review comments.",
      "",
      "### Studio",
      "",
      "Studio is priced by agreement for more than 50 editors. Write to sales@quillmark.example.",
    ].join("\n"),
  },
  {
    id: HARBORLINE_PLANS_DOC_ID,
    title: "Harborline plans and pricing",
    content: [
      "# Harborline plans and pricing",
      "",
      "Harborline tracks deliveries for small shipping firms. Prices are per vehicle and exclude VAT.",
      "",
      "### Basic",
      "",
      "Basic costs €39 a month for up to 5 vehicles, with live positions and a daily delivery report.",
      "",
      "### Pro",
      "",
      "Pro costs €89 a month for up to 25 vehicles. It adds route planning, proof of delivery, and an API.",
      "",
      "### Fleet",
      "",
      "Fleet is priced by agreement for more than 25 vehicles. Write to sales@harborline.example.",
    ].join("\n"),
  },
];

/** The opening of the section that answers each case's question; neither section names the kind of item. */
export const PLANET_SECTION_PASSAGE = "Planet costs €579 a month";
export const MAESTRALE_SECTION_PASSAGE = "Maestrale costa 469 € al mese";

/** How far down a lexical search's hits the answering section must rank to count as found. */
const TOP_LEXICAL_HITS = 3;
/** How far down the passages the answer reads the answering section must come. */
const TOP_ANSWER_PASSAGES = 3;

export const sectionedPageCases: ConversationQualityCase[] = [
  {
    id: "retrieval-sectioned-page-later-section-figure",
    name: "A later section's price is quoted with its own name, not the section before it",
    description:
      "The plans page gives each plan a heading and a section that opens with the plan's price; the plan asked about is the third. Its neighbour's price (149) sits one heading above it, so an answer quoting it as the Planet plan's price attaches a figure to the wrong name, and an answer that never reads the Planet section declines (#1876). The Planet section never says \"plan\", and three passages name Planet and \"plan\" in passing, so only a lexical search for the plan's bare name ranks the section among its first hits (#1912).",
    tags: ["retrieval", "grounding", "sectioned-page"],
    query: "How much does the Planet plan cost?",
    assertions: [
      { type: "turn_route", route: "retrieval" },
      { type: "retrieval_includes_document", documentId: SECTIONED_PLANS_DOC_ID },
      {
        type: "retrieval_lexical_top_k_includes_passage",
        documentId: SECTIONED_PLANS_DOC_ID,
        passage: PLANET_SECTION_PASSAGE,
        k: TOP_LEXICAL_HITS,
      },
      {
        type: "retrieval_answer_top_k_includes_passage",
        documentId: SECTIONED_PLANS_DOC_ID,
        passage: PLANET_SECTION_PASSAGE,
        k: TOP_ANSWER_PASSAGES,
      },
      { type: "answer_cites_document", documentId: SECTIONED_PLANS_DOC_ID },
      { type: "answer_contains", pattern: "579", matchMode: "substring" },
      { type: "answer_does_not_contain", pattern: "149", matchMode: "substring" },
    ],
  },
  {
    id: "retrieval-sectioned-page-later-section-figure-it",
    name: "A later section's price is quoted with its own name, in Italian",
    description:
      "The Italian plans page repeats the shape: the plan asked about, Maestrale, is the third, its section never says \"piano\", and three passages name Maestrale and \"piano\" in passing. Only a lexical search for the plan's bare name ranks the section among its first hits (#1912), and an answer quoting the price one heading above (139) attaches it to the wrong name.",
    tags: ["retrieval", "grounding", "sectioned-page"],
    query: "Quanto costa il piano Maestrale?",
    assertions: [
      { type: "turn_route", route: "retrieval" },
      { type: "retrieval_includes_document", documentId: SECTIONED_PLANS_IT_DOC_ID },
      {
        type: "retrieval_lexical_top_k_includes_passage",
        documentId: SECTIONED_PLANS_IT_DOC_ID,
        passage: MAESTRALE_SECTION_PASSAGE,
        k: TOP_LEXICAL_HITS,
      },
      {
        type: "retrieval_answer_top_k_includes_passage",
        documentId: SECTIONED_PLANS_IT_DOC_ID,
        passage: MAESTRALE_SECTION_PASSAGE,
        k: TOP_ANSWER_PASSAGES,
      },
      { type: "answer_cites_document", documentId: SECTIONED_PLANS_IT_DOC_ID },
      { type: "answer_contains", pattern: "469", matchMode: "substring" },
      { type: "answer_does_not_contain", pattern: "139", matchMode: "substring" },
    ],
  },
  {
    id: "retrieval-sectioned-page-common-word-name",
    name: "A plan named by a common word is answered from its own section, not from passages that use the word",
    description:
      "The free plan's section says \"Comet is free\"; a support page says \"feel free\", \"free parking\" and \"ships free of charge\". A search for the bare word must not make those passages evidence: no lexical search holds the support page's passage as a full match, and the answer gives the free plan's limits (10 MB) from the pricing page and says nothing of parking or the onboarding kit.",
    tags: ["retrieval", "grounding", "sectioned-page"],
    query: "What does the Lumenfold free plan include?",
    assertions: [
      { type: "turn_route", route: "retrieval" },
      { type: "retrieval_lexical_full_matches_exclude_passage", documentId: SUPPORT_DOC_ID, passage: "Feel free to write" },
      { type: "answer_cites_document", documentId: SECTIONED_PLANS_DOC_ID },
      { type: "answer_contains", pattern: "10 MB", matchMode: "substring" },
      { type: "answer_does_not_contain", pattern: "parking", matchMode: "substring" },
      { type: "answer_does_not_contain", pattern: "onboarding kit", matchMode: "substring" },
    ],
  },
  {
    id: "retrieval-sectioned-page-missing-item",
    name: "A plan no page sells is not answered from a sponsorship tier that shares its name",
    description:
      "No product here has a Gold plan; the Summit sponsorship page has a \"Gold sponsor\" tier at €4,000. Its section is headed with a word the question never used, so a search for the bare name holds it as a passage that names Gold in passing, never as a full match: lexical search adds no evidence the search for the phrase did not find.",
    tags: ["retrieval", "coverage", "sectioned-page"],
    query: "How much does the Gold plan cost?",
    assertions: [
      { type: "turn_route", route: "retrieval" },
      { type: "retrieval_lexical_full_matches_exclude_passage", documentId: SUMMIT_SPONSORSHIP_DOC_ID, passage: "Gold sponsors get a booth" },
    ],
  },
  {
    id: "retrieval-sectioned-page-ambiguous-item",
    name: "A plan two products sell under one name keeps both products in play",
    description:
      "Quillmark and Harborline each sell a plan headed \"Pro\" (€29 and €89 a month). The search for the bare name finds both sections as the item's own, and it searches the same item as the phrase beside it, so it is no second retrieval branch: the turn weighs the readings as it does for one search, and retrieval keeps both products' pages rather than settling on one.",
    tags: ["retrieval", "clarification", "sectioned-page"],
    query: "How much is the Pro plan?",
    assertions: [
      { type: "turn_route", route: "retrieval" },
      { type: "retrieval_includes_document", documentId: QUILLMARK_PLANS_DOC_ID },
      { type: "retrieval_includes_document", documentId: HARBORLINE_PLANS_DOC_ID },
    ],
  },
];
