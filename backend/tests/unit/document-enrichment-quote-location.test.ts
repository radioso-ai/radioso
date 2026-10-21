import { describe, expect, it } from "vitest";

import { locateQuotedFacts } from "../../src/modules/documents/domain/enrichment/factQuoteLocation.js";

const fact = (quote: string, dateFrom = "2026-12-12") => ({ kind: "event_date" as const, quote, dateFrom });

const rangeText = (body: string, range: { start: number; end: number } | null | undefined) =>
  range ? body.slice(range.start, range.end) : null;

describe("locating extracted facts from quoted text", () => {
  it("places a quote found once at its offsets in the body", () => {
    const body = "Hatha Yoga intensivo\n\nDate: dal 12 al 14 dicembre 2026.";

    const located = locateQuotedFacts({ facts: [fact("dal 12 al 14 dicembre 2026")], body, title: "Hatha Yoga" });

    expect(located.unplacedCount).toBe(0);
    expect(located.facts).toHaveLength(1);
    expect(rangeText(body, located.facts[0]?.sourceRange)).toBe("dal 12 al 14 dicembre 2026");
    expect(located.facts[0]).toMatchObject({ kind: "event_date", dateFrom: "2026-12-12" });
  });

  it("resolves a repeated quote in document order", () => {
    const body = "### Yoga\nSabato 12 dicembre\n\n### Kirtan\nSabato 12 dicembre\n\n### Mantra\nDomenica 13 dicembre";
    const second = body.indexOf("Sabato 12 dicembre", body.indexOf("Kirtan"));

    const located = locateQuotedFacts({
      facts: [fact("Sabato 12 dicembre"), fact("Sabato 12 dicembre"), fact("Domenica 13 dicembre", "2026-12-13")],
      body,
      title: "Settimana",
    });

    expect(located.facts.map((entry) => entry.sourceRange?.start)).toEqual([
      body.indexOf("Sabato 12 dicembre"),
      second,
      body.indexOf("Domenica 13 dicembre"),
    ]);
  });

  it("falls back to the first occurrence when a quote appears only before the previous fact", () => {
    const body = "Open day: 3 March.\n\nWorkshop: 10 March.";

    const located = locateQuotedFacts({
      facts: [fact("Workshop: 10 March", "2027-03-10"), fact("Open day: 3 March", "2027-03-03")],
      body,
      title: "Spring",
    });

    expect(rangeText(body, located.facts[1]?.sourceRange)).toBe("Open day: 3 March");
  });

  it("keeps a date quoted only from the title as a document-wide fact with no chunk range", () => {
    const located = locateQuotedFacts({
      facts: [fact("12–14 dicembre 2026")],
      body: "Un fine settimana di pratica per tutti i livelli.",
      title: "Hatha Yoga intensivo — 12–14 dicembre 2026",
    });

    expect(located.unplacedCount).toBe(0);
    expect(located.facts).toEqual([expect.objectContaining({ dateFrom: "2026-12-12", sourceRange: null })]);
  });

  it("prefers the body when the title and the body both carry the quote", () => {
    const body = "Date: 12 dicembre 2026.";

    const located = locateQuotedFacts({ facts: [fact("12 dicembre 2026")], body, title: "Corso — 12 dicembre 2026" });

    expect(rangeText(body, located.facts[0]?.sourceRange)).toBe("12 dicembre 2026");
  });

  it("drops a quote found nowhere, and an empty one, and counts them", () => {
    const located = locateQuotedFacts({
      facts: [fact("15 gennaio 2027"), fact("   "), fact("12 dicembre")],
      body: "Sabato 12 dicembre, ore 10.",
      title: "Corso",
    });

    expect(located.unplacedCount).toBe(2);
    expect(located.facts).toHaveLength(1);
  });

  it("maps Italian text with accents and em-dashes to exact body offsets", () => {
    const body = "# Settimana\n\n### Meditazione guidata\nMartedì 8 dicembre 2026 — ore 19:00\nCon Luca, più tè.";

    const located = locateQuotedFacts({ facts: [fact("Martedì 8 dicembre 2026 — ore 19:00", "2026-12-08")], body, title: "Settimana" });

    expect(rangeText(body, located.facts[0]?.sourceRange)).toBe("Martedì 8 dicembre 2026 — ore 19:00");
  });

  it("matches a quote whose whitespace, dashes, apostrophes, accents, case, or emphasis differ from the body", () => {
    const body = "Ayurveda:  alimentazione dell’inverno\n\n**Mercoledì** 9 dicembre 2026, 20:30–22:00";
    const decomposed = "Mercoledì 9 dicembre 2026, 20:30-22:00";

    const located = locateQuotedFacts({
      facts: [fact("alimentazione dell'inverno", "2026-12-09"), fact(decomposed, "2026-12-09"), fact("MERCOLEDÌ 9 DICEMBRE", "2026-12-09")],
      body,
      title: "Ayurveda",
    });

    expect(located.unplacedCount).toBe(0);
    expect(rangeText(body, located.facts[0]?.sourceRange)).toBe("alimentazione dell’inverno");
    expect(rangeText(body, located.facts[1]?.sourceRange)).toBe("Mercoledì** 9 dicembre 2026, 20:30–22:00");
    expect(rangeText(body, located.facts[2]?.sourceRange)).toBe("Mercoledì** 9 dicembre");
  });

  it("matches a quote that spans a line break as a single space", () => {
    const body = "Arrivo lunedì 2 agosto\n2027 dopo le 15:00.";

    const located = locateQuotedFacts({ facts: [fact("lunedì 2 agosto 2027", "2027-08-02")], body, title: "Ritiro" });

    expect(rangeText(body, located.facts[0]?.sourceRange)).toBe("lunedì 2 agosto\n2027");
  });
});
