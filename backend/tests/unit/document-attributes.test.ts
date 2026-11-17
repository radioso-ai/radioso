import { describe, expect, it } from "vitest";

import {
  DOCUMENT_ATTRIBUTE_LIMITS,
  extractLeadingDocumentAttributes,
  readDocumentAttributes,
  withDocumentAttributes,
  withoutDocumentAttributes,
} from "../../src/modules/retrieval/domain/documentAttributes.js";
import { propertyCorpus } from "../fixtures/document-attributes/propertyCorpus.js";

const attributesOf = (markdown: string) => extractLeadingDocumentAttributes(markdown).attributes;

describe("leading document attributes: blocks that describe the document", () => {
  it("lifts a Markdown list of bold labels that opens a property sheet", () => {
    expect(extractLeadingDocumentAttributes(propertyCorpus[0].markdown)).toEqual({
      outcome: "extracted",
      attributes: [
        { label: "Property id", value: "fixture-p1" },
        { label: "Region", value: "Umbria" },
        { label: "Type", value: "Farmhouse" },
        { label: "Architectural style", value: "Rural stone" },
        { label: "Film crew capacity", value: "up to 30 crew; base camp for 4 vehicles" },
      ],
    });
  });

  it("lifts a product block whose labels carry units and abbreviations", () => {
    const markdown = [
      "# Trail Runner 3",
      "",
      "**SKU:** TR3-BLUE-42",
      "**Price:** 129 EUR",
      "**Weight (g):** 280",
      "**Approx. drop:** 6 mm",
      "",
      "A light trail shoe with a rock plate and a grippy outsole. It suits long mountain runs.",
    ].join("\n");

    expect(attributesOf(markdown)).toEqual([
      { label: "SKU", value: "TR3-BLUE-42" },
      { label: "Price", value: "129 EUR" },
      { label: "Weight (g)", value: "280" },
      { label: "Approx. drop", value: "6 mm" },
    ]);
  });

  it("lifts front matter, then a course block under the title", () => {
    const markdown = [
      "---",
      "level: Beginner",
      "language: \"Italian\"",
      "tags: [painting, evening]",
      "location:",
      "  room: B2",
      "summary: |",
      "  A long text.",
      "---",
      "",
      "# Watercolour for beginners",
      "",
      "Duration: 6 weeks",
      "Schedule: Tuesdays 18:00–20:00",
      "Tel.: +39 055 000 000",
      "",
      "The course covers washes, layering and colour mixing.",
    ].join("\n");

    expect(attributesOf(markdown)).toEqual([
      { label: "level", value: "Beginner" },
      { label: "language", value: "Italian" },
      { label: "tags", value: "painting, evening" },
      { label: "Duration", value: "6 weeks" },
      { label: "Schedule", value: "Tuesdays 18:00–20:00" },
      { label: "Tel.", value: "+39 055 000 000" },
    ]);
  });

  it("lifts plain label lines separated by blank lines, as converted documents write them", () => {
    expect(attributesOf("Region: Umbria\n\nType: Farmhouse\n\n**Size**: 420 m²\n\nThe house sits on a ridge.")).toEqual([
      { label: "Region", value: "Umbria" },
      { label: "Type", value: "Farmhouse" },
      { label: "Size", value: "420 m²" },
    ]);
  });

  it("lifts labels written in any script, with a full-width colon too", () => {
    expect(attributesOf("# 古い農家\n\n- 地域：ウンブリア\n- 種類: 農家\n\n丘の上に立っている。")).toEqual([
      { label: "地域", value: "ウンブリア" },
      { label: "種類", value: "農家" },
    ]);
  });

  it("ends the block at an odd line and keeps the entries before it", () => {
    const markdown = [
      "- **Region:** Umbria",
      "- **Type:** Farmhouse",
      "- Five bedrooms, a pool and a walled garden",
      "- **Era:** 1890s",
      "",
      "The house sits on a ridge.",
    ].join("\n");

    expect(attributesOf(markdown)).toEqual([
      { label: "Region", value: "Umbria" },
      { label: "Type", value: "Farmhouse" },
    ]);
  });

  it("keeps the entries before a labelled line that turns into prose", () => {
    const markdown = [
      "- **Region:** Umbria",
      "- **Type:** Farmhouse",
      "- **Description:** A stone farmhouse on a ridge above olive groves. It has five rooms.",
      "",
      "More about the house.",
    ].join("\n");

    expect(attributesOf(markdown)).toEqual([
      { label: "Region", value: "Umbria" },
      { label: "Type", value: "Farmhouse" },
    ]);
  });
});

describe("leading document attributes: openings that are not attribute blocks", () => {
  const openings: Record<string, { markdown: string; outcome: string }> = {
    faq: {
      markdown: [
        "# Frequently asked questions",
        "",
        "Q: How do I book a location?",
        "A: Use the booking form on each property page.",
        "",
        "Q: Can we visit before the shoot?",
        "A: Yes, we arrange recce visits on weekdays.",
      ].join("\n"),
      outcome: "rejected_sentence_values",
    },
    "faq with short answers": {
      markdown: "Q: Parking\nA: Yes\n\nQ: Wifi\nA: Yes\n\nWe answer more questions by phone.",
      outcome: "rejected_repeated_labels",
    },
    transcript: {
      markdown: [
        "Customer: Hi, I would like to book the villa for May.",
        "Agent: Sure, which dates do you need?",
        "Customer: The fourth to the eighth.",
      ].join("\n"),
      outcome: "rejected_sentence_values",
    },
    "short transcript": {
      markdown: "Guest: hello\nHost: hi there\nGuest: thanks\n\nThe call ended there.",
      outcome: "rejected_repeated_labels",
    },
    "email headers": {
      markdown: [
        "From: Anna Rossi <anna.rossi@example.com>",
        "To: bookings@example.com",
        "Subject: Shoot in May",
        "Date: Tue, 17 Nov 2026 09:12:00 +0100",
        "",
        "Hello team, we would like to shoot at the farmhouse in May.",
      ].join("\n"),
      outcome: "rejected_message_headers",
    },
    glossary: {
      markdown: [
        "# Glossary",
        "",
        "**Recce**: A visit to scout a location before the shoot.",
        "**Base camp**: The area where crew vehicles park.",
        "**Call sheet**: The daily schedule sent to cast and crew.",
      ].join("\n"),
      outcome: "rejected_sentence_values",
    },
    "step list": {
      markdown: [
        "## Booking steps",
        "",
        "1. Choose: pick a property from the catalogue",
        "2. Request: send the dates you need",
        "3. Confirm: sign the agreement",
      ].join("\n"),
      outcome: "rejected_list_or_code",
    },
    "indented code": {
      markdown: "    region: Umbria\n    type: Farmhouse\n\nThe snippet above sets the region.",
      outcome: "rejected_list_or_code",
    },
    "fenced code": {
      markdown: "```yaml\nregion: Umbria\ntype: Farmhouse\n```\n\nThis configuration sets the region.",
      outcome: "none",
    },
    "note and warning": {
      markdown: [
        "**Note:** This page is for location managers only.",
        "**Warning:** Prices change every season.",
        "",
        "The catalogue lists every property we represent.",
      ].join("\n"),
      outcome: "rejected_sentence_values",
    },
    "single note": {
      markdown: "Note: prices exclude VAT\n\nThe catalogue lists every property we represent.",
      outcome: "rejected_single_entry",
    },
    "prose straight after the labels": {
      markdown: "Region: Umbria\nType: Farmhouse\nThe house sits on a ridge above the valley, among olive groves.",
      outcome: "rejected_prose_follows",
    },
    "prose opening": {
      markdown: "# Villa\n\nThe villa sits on a cliff. Region: none of your business.\n\n- **Region:** Campania\n- **Type:** Villa",
      outcome: "none",
    },
    "address and clock time": {
      markdown: "https://example.com/villa\n10:30 arrival\n\nWelcome.",
      outcome: "none",
    },
    "horizontal rules around prose": {
      markdown: "---\n\nWelcome to our studio. We teach watercolour.\n\n---\n\nThe next course starts in March.",
      outcome: "none",
    },
  };

  for (const [name, { markdown, outcome }] of Object.entries(openings)) {
    it(`finds no attributes in ${name}`, () => {
      expect(extractLeadingDocumentAttributes(markdown)).toEqual({ attributes: [], outcome });
    });
  }

  it("reads a leading horizontal rule as a rule, not as front matter", () => {
    const markdown = "---\n# Villa Marisol\n---\n\n- **Region:** Campania\n- **Type:** Villa\n\nA white house above the bay.";

    expect(attributesOf(markdown)).toEqual([
      { label: "Region", value: "Campania" },
      { label: "Type", value: "Villa" },
    ]);
  });
});

describe("leading document attributes: limits and metadata", () => {
  it("stays within its limits on an oversized block and leaves long values in the text", () => {
    const lines = Array.from({ length: 70 }, (_, index) => `- **Feature ${index + 1}:** terracotta tiles and beams`);
    lines.splice(2, 0, `- **Notes:** ${"long ".repeat(60).trim()}`);
    const attributes = attributesOf(`${lines.join("\n")}\n\nBody text.`);

    expect(attributes.length).toBe(2);
    expect(attributes.every((attribute) => attribute.value.length <= DOCUMENT_ATTRIBUTE_LIMITS.maxValueChars)).toBe(true);

    const withoutLongValue = attributesOf(`${lines.filter((line) => !line.includes("Notes")).join("\n")}\n\nBody text.`);
    expect(withoutLongValue.length).toBeLessThanOrEqual(DOCUMENT_ATTRIBUTE_LIMITS.maxEntries);
  });

  it("reads only well-formed attributes back from chunk metadata", () => {
    expect(readDocumentAttributes({ documentAttributes: "Region: Umbria" })).toEqual([]);
    expect(readDocumentAttributes({ documentAttributes: [{ label: "Region", value: "Umbria" }, { label: 3 }, null] }))
      .toEqual([{ label: "Region", value: "Umbria" }]);
    expect(readDocumentAttributes(undefined)).toEqual([]);
  });

  it("adds attributes to chunk metadata only when there are some, and strips them on request", () => {
    const metadata = { sourceUrl: "https://example.com/villa" };
    const withAttributes = withDocumentAttributes(metadata, [{ label: "Region", value: "Umbria" }]);

    expect(withDocumentAttributes(metadata, [])).toBe(metadata);
    expect(readDocumentAttributes(withAttributes)).toEqual([{ label: "Region", value: "Umbria" }]);
    expect(withoutDocumentAttributes(withAttributes)).toEqual(metadata);
  });
});
