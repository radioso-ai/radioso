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
 * The two pages run in a workspace of their own, seeded with them alone: they describe a product the
 * shared corpus's own pricing page does not sell, so every "which plans" case there would read both.
 */
export const SECTIONED_PLANS_DOC_ID = "22222222-2222-4222-8222-222222222218";
const PLAN_CHANGE_HELP_DOC_ID = "22222222-2222-4222-8222-222222222219";

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
];

export const sectionedPageCases: ConversationQualityCase[] = [
  {
    id: "retrieval-sectioned-page-later-section-figure",
    name: "A later section's price is quoted with its own name, not the section before it",
    description:
      "The plans page gives each plan a heading and a section that opens with the plan's price; the plan asked about is the third. Its neighbour's price (149) sits one heading above it, so an answer quoting it as the Planet plan's price attaches a figure to the wrong name, and an answer that never reads the Planet section declines (#1876).",
    tags: ["retrieval", "grounding"],
    query: "How much does the Planet plan cost?",
    assertions: [
      { type: "turn_route", route: "retrieval" },
      { type: "retrieval_includes_document", documentId: SECTIONED_PLANS_DOC_ID },
      { type: "answer_cites_document", documentId: SECTIONED_PLANS_DOC_ID },
      { type: "answer_contains", pattern: "579", matchMode: "substring" },
      { type: "answer_does_not_contain", pattern: "149", matchMode: "substring" },
    ],
  },
];
