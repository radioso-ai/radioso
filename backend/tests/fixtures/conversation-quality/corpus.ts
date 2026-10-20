/**
 * A small, self-contained corpus the conversation-quality suite grounds against. Facts
 * are concrete and quotable (a 30-day window, a $49 plan, "SOC 2 Type II", a residential
 * course's fees in euro) so cases can assert on exact figures deterministically instead of
 * relying only on a judge.
 *
 * Document ids are fixed UUIDs so assertions can reference them by constant.
 */
export interface ConversationQualityDocument {
  id: string;
  title: string;
  content: string;
}

export const REFUND_POLICY_DOC_ID = "22222222-2222-4222-8222-222222222201";
export const PRICING_DOC_ID = "22222222-2222-4222-8222-222222222202";
export const SECURITY_DOC_ID = "22222222-2222-4222-8222-222222222203";
export const GETTING_STARTED_DOC_ID = "22222222-2222-4222-8222-222222222204";
export const BREATH_COURSE_DOC_ID = "22222222-2222-4222-8222-222222222205";
export const ARTS_WEEKEND_DOC_ID = "22222222-2222-4222-8222-222222222206";
export const ONLINE_YOGA_DOC_ID = "22222222-2222-4222-8222-222222222207";
export const MOUNTAIN_COURSE_DOC_ID = "22222222-2222-4222-8222-222222222208";

export const conversationQualityCorpus: ConversationQualityDocument[] = [
  {
    id: REFUND_POLICY_DOC_ID,
    title: "Refund Policy",
    content: [
      "Refund Policy",
      "",
      "Customers may request a full refund within 30 days of purchase, no questions asked.",
      "After the 30-day window, refunds are prorated for annual plans and are not available for monthly plans.",
      "To request a refund, contact support with your account email and order number.",
    ].join("\n"),
  },
  {
    id: PRICING_DOC_ID,
    title: "Plans and Pricing",
    content: [
      "Plans and Pricing",
      "",
      "The Starter plan is free and includes a single assistant and 100 documents.",
      "The Pro plan costs $49 per month and includes unlimited documents, custom branding, and priority support.",
      "The Enterprise plan is custom-priced and adds SSO, audit logs, and a dedicated success manager.",
    ].join("\n"),
  },
  {
    id: SECURITY_DOC_ID,
    title: "Security and Compliance",
    content: [
      "Security and Compliance",
      "",
      "Radioso is SOC 2 Type II compliant and undergoes annual third-party audits.",
      "All data is encrypted in transit with TLS 1.2+ and at rest with AES-256.",
      "Enterprise customers can request a data processing agreement and single sign-on.",
    ].join("\n"),
  },
  {
    id: GETTING_STARTED_DOC_ID,
    title: "Getting Started",
    content: [
      "Getting Started",
      "",
      "Create a workspace, upload your first documents, and the ingestion worker chunks and embeds them automatically.",
      "Once processing completes, ask your assistant a question to get a grounded, cited answer.",
    ].join("\n"),
  },
  // Two residential courses with the same price structure and different figures, so an answer
  // that quotes the wrong one is visible. Only the arts weekend uses the words a generic quote
  // request carries ("evento", "preventivo", "pernottamento").
  {
    id: BREATH_COURSE_DOC_ID,
    title: "CORSO RESIDENZIALE: Il respiro Superconsapevole",
    content: [
      "CORSO RESIDENZIALE: Il respiro Superconsapevole",
      "",
      "Dal 26 al 29 novembre 2031 nella nostra sede di campagna.",
      "Quattro giorni di pratica guidata del respiro superconsapevole, con meditazione al mattino e alla sera.",
      "Quota di partecipazione, vitto e alloggio inclusi: 260 euro in camera singola, 200 euro in camera doppia, 180 euro in dormitorio.",
      "Per iscriversi scrivere a corsi@example.org.",
    ].join("\n"),
  },
  {
    id: ARTS_WEEKEND_DOC_ID,
    title: "CORSO RESIDENZIALE: Weekend delle arti creative",
    content: [
      "CORSO RESIDENZIALE: Weekend delle arti creative",
      "",
      "Evento residenziale dal 22 al 24 agosto 2031 nella nostra sede di campagna.",
      "Un weekend di musica, danza e pittura aperto a tutti i livelli.",
      "Preventivo completo, pernottamento e pasti compresi: 280 euro in camera singola, 220 euro in camera doppia, 200 euro in dormitorio.",
      "Per iscriversi scrivere a corsi@example.org.",
    ].join("\n"),
  },
  {
    id: ONLINE_YOGA_DOC_ID,
    title: "Lezioni di yoga online",
    content: [
      "Lezioni di yoga online",
      "",
      "Ogni martedì e giovedì alle 19:00 in diretta video.",
      "Abbonamento mensile: 40 euro. La prima lezione è gratuita.",
    ].join("\n"),
  },
  {
    // An Italian course page that states its fees, so a directive that withholds figures
    // has something to withhold (#1575). Its figures appear nowhere else in the corpus, and it
    // keeps clear of the quote-request words above so the referent cases still single out
    // the arts weekend.
    id: MOUNTAIN_COURSE_DOC_ID,
    title: "Corso di yoga in montagna",
    content: [
      "Corso di yoga in montagna",
      "",
      "Il corso residenziale si svolge dal venerdì sera alla domenica pomeriggio e comprende pratica, meditazione e pasti vegetariani.",
      "La quota del programma è di 345 €.",
      "Le camere si pagano a parte: singola 310 €, doppia 255 € a persona, dormitorio 195 € a persona.",
      "Per prenotare scrivi alla reception.",
    ].join("\n"),
  },
];
