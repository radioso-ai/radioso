import type { ConversationQualityCase } from "../../../src/modules/eval/suite/index.js";
import type { ConversationQualityDocument } from "./corpus.js";

/**
 * Reply block fixtures (#1763): five product pages of an invented bookshop, each with its cover
 * as the document's primary image, the bookshop's returns page with a picture of its own, and
 * one guest house page whose photos sit inside its text.
 * The runner seeds their `document_images` rows itself once the corpus is processed, as image
 * capture would leave them; an inline photo is anchored to the page's first chunk.
 */
export interface ReplyBlockFixtureImage {
  role: "primary" | "inline";
  sourceUrl: string;
  alt: string;
  caption?: string;
  width: number;
  height: number;
}

export const HIKING_BOOK_DOC_IDS = [
  "22222222-2222-4222-8222-222222222211",
  "22222222-2222-4222-8222-222222222212",
  "22222222-2222-4222-8222-222222222213",
  "22222222-2222-4222-8222-222222222214",
  "22222222-2222-4222-8222-222222222215",
] as const;
export const GUEST_HOUSE_DOC_ID = "22222222-2222-4222-8222-222222222216";
export const RETURNS_POLICY_DOC_ID = "22222222-2222-4222-8222-222222222217";

const hikingBooks = [
  { title: "A Field Guide to Alpine Flowers", slug: "alpine-flowers", pages: 240, price: "€24", about: "identifying the wildflowers met on mountain trails, with a chapter on each altitude zone" },
  { title: "Hut to Hut: Ten Classic Treks", slug: "hut-to-hut", pages: 312, price: "€29", about: "ten multi-day hiking routes between mountain huts, with stage maps and booking tips" },
  { title: "Trail Running for Beginners", slug: "trail-running", pages: 180, price: "€19", about: "moving from road running to hiking trails, with training plans and kit lists" },
  { title: "Reading the Weather in the Hills", slug: "hill-weather", pages: 160, price: "€17", about: "forecasting mountain weather on a hike from clouds, wind and pressure" },
  { title: "Family Day Hikes", slug: "family-day-hikes", pages: 200, price: "€21", about: "thirty short hiking walks suited to children, each under four hours" },
] as const;

export const replyBlockDocuments: ConversationQualityDocument[] = [
  ...hikingBooks.map((book, index) => ({
    id: HIKING_BOOK_DOC_IDS[index],
    title: book.title,
    metadata: { sourceUrl: `https://shop.example/books/${book.slug}` },
    content: [
      book.title,
      "",
      `A hiking book about ${book.about}.`,
      `Paperback, ${book.pages} pages, ${book.price}. In stock at the shop.example bookshop.`,
    ].join("\n"),
  })),
  {
    id: GUEST_HOUSE_DOC_ID,
    title: "The Guest House",
    metadata: { sourceUrl: "https://stay.example/guest-house" },
    content: [
      "The Guest House",
      "",
      "Our guest house is a restored stone farmhouse with six bedrooms, a shared kitchen and a walled garden.",
      "Each bedroom has a view over the valley; the garden has a terrace for breakfast in summer.",
      "Check-in is from 3 pm. Write to bookings@stay.example to book a room.",
    ].join("\n"),
  },
  {
    id: RETURNS_POLICY_DOC_ID,
    title: "Returns and Refunds",
    metadata: { sourceUrl: "https://shop.example/help/returns" },
    content: [
      "Returns and Refunds",
      "",
      "You can return a book within 14 days of delivery for a full refund, as long as it is unread and in its original condition.",
      "Start a return by writing to returns@shop.example with your order number; we send a prepaid return label within two working days.",
      "Refunds go back to the original payment method within five working days of the book reaching us.",
    ].join("\n"),
  },
];

export const replyBlockImages: Record<string, ReplyBlockFixtureImage[]> = {
  ...Object.fromEntries(hikingBooks.map((book, index) => [HIKING_BOOK_DOC_IDS[index], [{
    role: "primary" as const,
    sourceUrl: `https://shop.example/covers/${book.slug}.jpg`,
    alt: "",
    width: 800,
    height: 1200,
  }]])),
  [RETURNS_POLICY_DOC_ID]: [{
    role: "primary",
    sourceUrl: "https://shop.example/images/returns-parcel.jpg",
    alt: "A parcel with a return label",
    width: 1200,
    height: 630,
  }],
  [GUEST_HOUSE_DOC_ID]: [
    { role: "inline", sourceUrl: "https://stay.example/photos/farmhouse.jpg", alt: "The stone farmhouse from the lane", width: 1600, height: 1067 },
    { role: "inline", sourceUrl: "https://stay.example/photos/bedroom.jpg", alt: "A bedroom with a view over the valley", width: 1600, height: 1067 },
    { role: "inline", sourceUrl: "https://stay.example/photos/garden.jpg", alt: "", caption: "The walled garden and terrace", width: 1600, height: 1067 },
  ],
};

/** What the web embed declares: it draws item lists as a carousel or a grid. */
export const replyBlocksCapabilities: NonNullable<ConversationQualityCase["clientContextCapabilities"]> = {
  "reply.blocks": { item_list: { layouts: ["carousel", "grid"] } },
};

export const replyBlockCases: ConversationQualityCase[] = [
  {
    id: "reply-blocks-hiking-books",
    name: "Covers of the products an answer lists come as a carousel",
    description: "A shopper asks which hiking books the shop has. The answer is grounded in product pages with covers, so the reply carries a carousel of covers from those pages, and the text names no image address.",
    tags: ["reply-blocks"],
    query: "Which hiking books do you have?",
    clientContextCapabilities: replyBlocksCapabilities,
    assertions: [
      { type: "reply_block", layout: "carousel", minItems: 2, itemsFromEvidence: true },
      { type: "answer_excludes_image_url" },
    ],
  },
  {
    id: "reply-blocks-guest-house-photos",
    name: "Photos inside a page come as a gallery grid",
    description: "A visitor asks what the guest house looks like. The page carries its photos inside its text, so the reply carries a grid of them.",
    tags: ["reply-blocks"],
    query: "What does the guest house look like?",
    clientContextCapabilities: replyBlocksCapabilities,
    assertions: [
      { type: "reply_block", layout: "grid" },
      { type: "answer_excludes_image_url" },
    ],
  },
  {
    id: "reply-blocks-returns-policy-no-pictures",
    name: "A question about a policy gets no pictures, even when the policy page has one",
    description: "A shopper asks how returns work. The returns page has a main picture, but the question is about the policy, not about items or places, so the reply carries no block.",
    tags: ["reply-blocks"],
    query: "How do I return a book I ordered?",
    clientContextCapabilities: replyBlocksCapabilities,
    assertions: [
      { type: "no_reply_block" },
      { type: "answer_excludes_image_url" },
    ],
  },
];
