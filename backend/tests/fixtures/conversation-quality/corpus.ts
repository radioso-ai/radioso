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
  /** The document's operator metadata, seeded as an operator sets it, e.g. an item's `dateFrom`/`dateTo`. */
  metadata?: Record<string, string>;
}

export const REFUND_POLICY_DOC_ID = "22222222-2222-4222-8222-222222222201";
export const PRICING_DOC_ID = "22222222-2222-4222-8222-222222222202";
export const SECURITY_DOC_ID = "22222222-2222-4222-8222-222222222203";
export const GETTING_STARTED_DOC_ID = "22222222-2222-4222-8222-222222222204";
export const BREATH_COURSE_DOC_ID = "22222222-2222-4222-8222-222222222205";
export const ARTS_WEEKEND_DOC_ID = "22222222-2222-4222-8222-222222222206";
export const ONLINE_YOGA_DOC_ID = "22222222-2222-4222-8222-222222222207";
export const MOUNTAIN_COURSE_DOC_ID = "22222222-2222-4222-8222-222222222208";
export const TIDAL_LINES_DOC_ID = "22222222-2222-4222-8222-222222222209";
export const WOVEN_ROOMS_DOC_ID = "22222222-2222-4222-8222-222222222210";

/**
 * One arts centre's programme around the week of Monday 10 to Sunday 16 March 2031, one item per
 * page, dated in the page's metadata as an operator dates an event page. The items sit every way
 * an item can sit against that week: two open the day before it and close on its last day, one
 * runs from well before it to well after it, one begins on its last day and runs past it, two fall
 * inside it, and one closes before it. The pages are in English and clear of the residential
 * courses' words, so the Italian lexical and referent cases keep their own pages.
 */
const artsCentreProgramme: ConversationQualityDocument[] = [
  {
    id: TIDAL_LINES_DOC_ID,
    title: "Tidal Lines: photographs of the estuary",
    content: [
      "Tidal Lines: photographs of the estuary",
      "",
      "Exhibition at Lantern Hall, Gallery 1, from Sunday 9 March to Sunday 16 March 2031.",
      "Forty large-format photographs of the estuary at low tide, taken over one winter.",
      "Open daily from 10:00 to 18:00. Free entry.",
    ].join("\n"),
    metadata: { dateFrom: "2031-03-09", dateTo: "2031-03-16" },
  },
  {
    id: WOVEN_ROOMS_DOC_ID,
    title: "Woven Rooms: a textile installation",
    content: [
      "Woven Rooms: a textile installation",
      "",
      "Installation at Lantern Hall, Gallery 2, from Sunday 9 March to Sunday 16 March 2031.",
      "Three rooms hung floor to ceiling with hand-woven wool that visitors walk through.",
      "Open daily from 10:00 to 18:00. Tickets 6 pounds.",
    ].join("\n"),
    metadata: { dateFrom: "2031-03-09", dateTo: "2031-03-16" },
  },
  {
    id: "22222222-2222-4222-8222-222222222211",
    title: "Glass and Light",
    content: [
      "Glass and Light",
      "",
      "Exhibition at Lantern Hall, Main Hall, from Friday 14 February to Sunday 27 April 2031.",
      "Blown and stained glass from four studios, lit to throw colour across the hall.",
      "Open Tuesday to Sunday from 10:00 to 18:00. Tickets 8 pounds.",
    ].join("\n"),
    metadata: { dateFrom: "2031-02-14", dateTo: "2031-04-27" },
  },
  {
    id: "22222222-2222-4222-8222-222222222212",
    title: "Letterpress workshop series",
    content: [
      "Letterpress workshop series",
      "",
      "Daily workshops at Lantern Hall, Print Room, from Sunday 16 March to Saturday 22 March 2031.",
      "Set type by hand and print a poster on the hall's restored press. Each workshop runs from 14:00 to 17:00.",
      "Places 25 pounds per workshop, materials included.",
    ].join("\n"),
    metadata: { dateFrom: "2031-03-16", dateTo: "2031-03-22" },
  },
  {
    id: "22222222-2222-4222-8222-222222222213",
    title: "Printmaking evening",
    content: [
      "Printmaking evening",
      "",
      "Evening class at Lantern Hall, Print Room, on Wednesday 12 March 2031 from 18:30 to 21:00.",
      "An introduction to linocut: carve a block and pull your first prints.",
      "Places 18 pounds, materials included.",
    ].join("\n"),
    metadata: { dateFrom: "2031-03-12", dateTo: "2031-03-12" },
  },
  {
    id: "22222222-2222-4222-8222-222222222214",
    title: "Clay modelling weekend",
    content: [
      "Clay modelling weekend",
      "",
      "Two-day class at Lantern Hall, Studio 3, on Friday 14 and Saturday 15 March 2031, from 10:00 to 16:00 each day.",
      "Model a small figure in clay over two days; pieces are fired and ready to collect a week later.",
      "Places 60 pounds for both days.",
    ].join("\n"),
    metadata: { dateFrom: "2031-03-14", dateTo: "2031-03-15" },
  },
  {
    id: "22222222-2222-4222-8222-222222222215",
    title: "Paper Cities",
    content: [
      "Paper Cities",
      "",
      "Exhibition at Lantern Hall, Gallery 3, from Saturday 1 February to Saturday 8 March 2031.",
      "Cut-paper models of imagined cities, each built from a single sheet.",
      "Open daily from 10:00 to 18:00. Free entry.",
    ].join("\n"),
    metadata: { dateFrom: "2031-02-01", dateTo: "2031-03-08" },
  },
];

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
  ...artsCentreProgramme,
];
