import type { ConversationQualityCase } from "../../../src/modules/eval/suite/index.js";
import { replyBlocksCapabilities } from "./replyBlockCases.js";

/**
 * Cards from a skill's result (#1763, slice 2a): an invented letting agency whose catalog search
 * is an MCP tool. The eval runs it as an in-process stub server, so no network and no real
 * agency is involved; every listing, office and address here is made up on `.example` domains.
 * A directive that always applies binds the agent's turns to the search, so each case is the
 * reply written from the tool's result.
 */

/** The bound skill and the stub tool behind it. */
export const TOOL_CARD_SKILL_NAME = "search_catalog";

interface Listing {
  name: string;
  area: string;
  rooms: number;
  rentPerMonth: number;
  url: string;
  photos: Array<{ url: string; caption: string }>;
}

const listing = (slug: string, name: string, area: string, rooms: number, rentPerMonth: number): Listing => ({
  name,
  area,
  rooms,
  rentPerMonth,
  url: `https://homes.example/listings/${slug}`,
  photos: [
    { url: `https://img.homes.example/photos/${slug}/living-room.jpg`, caption: "Living room" },
    { url: `https://img.homes.example/photos/${slug}/kitchen.jpg`, caption: "Kitchen" },
  ],
});

/** Mitte listings: four within a 2,000 budget, two above it. */
const MITTE_LISTINGS: Listing[] = [
  listing("loft-torstrasse", "Loft on Torstrasse", "Mitte", 2, 1_850),
  listing("altbau-auguststrasse", "Altbau flat on Auguststrasse", "Mitte", 3, 1_990),
  listing("studio-rosenthaler", "Studio by Rosenthaler Platz", "Mitte", 1, 1_180),
  listing("garden-flat-linienstrasse", "Garden flat on Linienstrasse", "Mitte", 2, 1_640),
  listing("penthouse-gendarmenmarkt", "Penthouse near Gendarmenmarkt", "Mitte", 4, 3_900),
  listing("maisonette-hackescher", "Maisonette by Hackescher Markt", "Mitte", 3, 2_650),
];

/** The agency's offices: places with an address and a page, and no pictures. */
const OFFICES = [
  { name: "Mitte office", address: "Invalidenstrasse 1, 10115 Berlin", openingHours: "Mon-Fri 9:00-18:00", url: "https://homes.example/offices/mitte" },
  { name: "Kreuzberg office", address: "Oranienstrasse 2, 10999 Berlin", openingHours: "Mon-Fri 10:00-19:00", url: "https://homes.example/offices/kreuzberg" },
  { name: "Neukölln office", address: "Weserstrasse 3, 12045 Berlin", openingHours: "Tue-Sat 10:00-18:00", url: "https://homes.example/offices/neukoelln" },
];

export const TOOL_CARD_LISTINGS_QUERY = "Do you have flats in Mitte under 2,000 a month?";
export const TOOL_CARD_OFFICES_QUERY = "Where are your letting offices?";
export const TOOL_CARD_NO_MATCH_QUERY = "Do you have any houseboats to rent?";

/** What the stub tool returns for a visitor message: the result a real search would give for it. */
interface StubResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
}

const listingsResult: StubResult = {
  content: [{ type: "text", text: `Found ${MITTE_LISTINGS.length} listings.` }],
  structuredContent: { listings: MITTE_LISTINGS },
};

const resultsByMessage = new Map<string, StubResult>([
  [TOOL_CARD_LISTINGS_QUERY, listingsResult],
  [TOOL_CARD_OFFICES_QUERY, { content: [{ type: "text", text: `Found ${OFFICES.length} offices.` }], structuredContent: { offices: OFFICES } }],
  // The catalog holds flats only: the search returns them, and none is what the visitor asked for.
  [TOOL_CARD_NO_MATCH_QUERY, listingsResult],
]);

/**
 * The stub tool: one search that answers each case's message with the result a real search would
 * give for it, looked up by the exact message the case sends. A message no case sends gets the
 * listings.
 */
export const toolCardStubTool = {
  name: TOOL_CARD_SKILL_NAME,
  description: "Searches the letting agency's catalog of homes to rent and its offices.",
  inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
  respond: (args: Record<string, unknown>): StubResult => resultsByMessage.get(String(args.message ?? "")) ?? listingsResult,
};

/** The records a card may come from: its title, and the link of the record that title names. */
const listingRecords = MITTE_LISTINGS.map((home) => ({ title: home.name, link: home.url }));

/** The directive that binds every turn of the tool-card agent to the catalog search. */
export const toolCardDirective = {
  name: "catalog-search",
  condition: { kind: "always" as const },
  action: "Search the letting catalog for what the visitor asks, and answer from what it returns.",
  binding: { kind: "skill" as const, skillName: TOOL_CARD_SKILL_NAME },
};

/** The model reads long or signed addresses shortened (`https://host/…/last`); a reply never carries one. */
const noShortenedAddress = { type: "answer_does_not_contain" as const, pattern: "/…/", matchMode: "substring" as const };

export const toolCardCases: ConversationQualityCase[] = [
  {
    id: "tool-cards-listings-carousel",
    name: "Listings a search returns come as a carousel of the matching ones",
    description: "A visitor asks for flats in Mitte within a budget. The bound search returns six Mitte listings with photos, two of them over budget. The reply is a short lead and a carousel whose every card is one of the returned listings, titled and linked from its own record, and the text names no image address.",
    tags: ["tool-cards", "reply-blocks"],
    query: TOOL_CARD_LISTINGS_QUERY,
    clientContextCapabilities: replyBlocksCapabilities,
    assertions: [
      { type: "reply_block", layout: "carousel", minItems: 2, itemsFromRecords: listingRecords },
      { type: "answer_excludes_image_url" },
      noShortenedAddress,
    ],
  },
  {
    id: "tool-cards-records-without-pictures",
    name: "Records without pictures come as a list, or as no cards",
    description: "A visitor asks where the agency's offices are. The search returns three offices with addresses and pages, and no photos, so any cards are a list without pictures; a page address is never shown as a picture.",
    tags: ["tool-cards", "reply-blocks"],
    query: TOOL_CARD_OFFICES_QUERY,
    clientContextCapabilities: replyBlocksCapabilities,
    assertions: [
      { type: "reply_block_without_pictures" },
      { type: "answer_excludes_image_url" },
      noShortenedAddress,
    ],
  },
  {
    id: "tool-cards-no-match-no-cards",
    name: "A search whose records do not answer the question gets no cards",
    description: "A visitor asks for houseboats. The catalog holds flats only, so the search returns flats; none answers the question, the reply says so, and it carries no cards.",
    tags: ["tool-cards", "reply-blocks"],
    query: TOOL_CARD_NO_MATCH_QUERY,
    clientContextCapabilities: replyBlocksCapabilities,
    assertions: [
      { type: "no_reply_block" },
      { type: "answer_excludes_image_url" },
      noShortenedAddress,
    ],
  },
];
