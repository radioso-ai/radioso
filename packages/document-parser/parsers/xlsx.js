import { loadDependency } from "./loadDependency.js";
import { DocumentParserError } from "../errors.js";
import { enforceOfficeZipLimits } from "./officeZipLimits.js";

const ExcelJS = loadDependency("exceljs");
const MAX_XLSX_CELLS = 250_000;
const MAX_XLSX_OUTPUT_CHARS = 2_000_000;
const MAX_XLSX_ROWS = 50_000;
const MAX_XLSX_WORKSHEETS = 50;

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const escapeMarkdownLinkText = (value) => value.replace(/[\\[\]]/g, "\\$&");

const escapeMarkdownLinkTarget = (value) => value.replace(/[\\()]/g, "\\$&");

const formatLinkedText = (text, hyperlink) => {
  const trimmedText = text.trim();
  const trimmedHyperlink = hyperlink.trim();

  if (!trimmedText) {
    return trimmedHyperlink;
  }

  if (!trimmedHyperlink || trimmedText === trimmedHyperlink) {
    return trimmedText;
  }

  return `[${escapeMarkdownLinkText(trimmedText)}](${escapeMarkdownLinkTarget(trimmedHyperlink)})`;
};

const renderRichText = (richText) =>
  richText
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();

const renderCellValue = (cell) => {
  if (cell === null || cell === undefined) {
    return "";
  }

  if (typeof cell === "string" || typeof cell === "number" || typeof cell === "boolean") {
    return String(cell).trim();
  }

  if (cell instanceof Date) {
    return String(cell).trim();
  }

  if (Array.isArray(cell)) {
    return cell.map((item) => renderCellValue(item)).filter(Boolean).join(" ").trim();
  }

  if (!isRecord(cell)) {
    return String(cell).trim();
  }

  const hyperlink = typeof cell.hyperlink === "string" ? cell.hyperlink : "";

  if (typeof cell.text === "string") {
    return formatLinkedText(cell.text, hyperlink);
  }

  if (Array.isArray(cell.richText)) {
    return formatLinkedText(renderRichText(cell.richText), hyperlink);
  }

  if ("result" in cell) {
    return formatLinkedText(renderCellValue(cell.result), hyperlink);
  }

  if (hyperlink) {
    return hyperlink.trim();
  }

  if (typeof cell.error === "string") {
    return cell.error.trim();
  }

  return Object.values(cell).map((value) => renderCellValue(value)).filter(Boolean).join(" ").trim();
};

const assertWithinLimit = (condition, message) => {
  if (!condition) {
    throw new DocumentParserError("document_too_large", message);
  }
};

const renderSheet = (worksheet, counters) => {
  const renderedRows = [];

  worksheet.eachRow({ includeEmpty: false }, (row) => {
    counters.rows += 1;
    assertWithinLimit(counters.rows <= MAX_XLSX_ROWS, `XLSX exceeds the ${MAX_XLSX_ROWS} row parsing limit.`);

    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    counters.cells += values.length;
    assertWithinLimit(counters.cells <= MAX_XLSX_CELLS, `XLSX exceeds the ${MAX_XLSX_CELLS} cell parsing limit.`);

    const rendered = values
      .map((cell) => renderCellValue(cell))
      .filter(Boolean)
      .join(" | ");

    if (rendered) {
      counters.outputChars += rendered.length + 1;
      assertWithinLimit(
        counters.outputChars <= MAX_XLSX_OUTPUT_CHARS,
        `XLSX extracted text exceeds the ${MAX_XLSX_OUTPUT_CHARS} character limit.`,
      );
      renderedRows.push(rendered);
    }
  });

  if (renderedRows.length === 0) {
    return "";
  }

  return [`## ${worksheet.name}`, ...renderedRows].join("\n");
};

export const parseXlsx = async ({ buffer }) => {
  enforceOfficeZipLimits(buffer);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  assertWithinLimit(
    workbook.worksheets.length <= MAX_XLSX_WORKSHEETS,
    `XLSX exceeds the ${MAX_XLSX_WORKSHEETS} worksheet parsing limit.`,
  );

  const counters = {
    cells: 0,
    outputChars: 0,
    rows: 0,
  };

  const renderedSheets = workbook.worksheets
    .map((worksheet) => renderSheet(worksheet, counters))
    .filter(Boolean);
  const text = renderedSheets.join("\n\n");

  return {
    text,
    markdown: text,
    sourceHints: {
      sheetNames: workbook.worksheets.map((worksheet) => worksheet.name),
    },
  };
};
