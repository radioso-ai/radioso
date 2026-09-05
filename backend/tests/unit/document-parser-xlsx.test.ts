import { parseDocument } from "@radioso/document-parser";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

const buildLinkedWorkbookBuffer = async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Knowledge Links");

  sheet.addRow(["Question", "Answer"]);
  sheet.addRow([
    "Come fare quando non riesco a entrare nel mio account?",
    { text: "Guida recupero account", hyperlink: "https://example.com/account-recovery" },
  ]);
  sheet.addRow(["Rich text answer", ""]);
  sheet.getCell("B3").value = {
    richText: [{ text: "Apri la guida completa" }],
    hyperlink: "https://example.com/rich-account-recovery",
  };

  return Buffer.from(await workbook.xlsx.writeBuffer());
};

describe("xlsx document parser", () => {
  it("renders linked spreadsheet cells as useful text instead of object placeholders", async () => {
    const parsed = await parseDocument({
      buffer: await buildLinkedWorkbookBuffer(),
      filename: "knowledge-links.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    expect(parsed.markdown).not.toContain("[object Object]");
    expect(parsed.markdown).toContain(
      "| Come fare quando non riesco a entrare nel mio account? | [Guida recupero account](https://example.com/account-recovery) |",
    );
    expect(parsed.markdown).toContain("Rich text answer | Apri la guida completa");
  });

  it("renders FAQ spreadsheets as markdown tables with row boundaries", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Foglio1");
    sheet.addRow(["DOMANDE FREQUENTI", "RISPOSTE"]);
    sheet.addRow([
      "Come posso accedere ai corsi online?",
      "Per accedere ai nostri corsi online, e necessario registrarsi sul nostro sito.",
    ]);
    sheet.addRow([
      "Come fare ad avere una registrazione?",
      [
        "Clicca su I miei corsi",
        "Seleziona il corso che vuoi vedere",
        "Premi play",
      ].join("\n"),
    ]);

    const parsed = await parseDocument({
      buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
      filename: "chatbot-online.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    expect(parsed.markdown).toContain("| DOMANDE FREQUENTI | RISPOSTE |");
    expect(parsed.markdown).toContain("| --- | --- |");
    expect(parsed.markdown).toContain(
      "| Come posso accedere ai corsi online? | Per accedere ai nostri corsi online, e necessario registrarsi sul nostro sito. |",
    );
    expect(parsed.markdown).toContain(
      "| Come fare ad avere una registrazione? | Clicca su I miei corsi<br>Seleziona il corso che vuoi vedere<br>Premi play |",
    );
  });
});
