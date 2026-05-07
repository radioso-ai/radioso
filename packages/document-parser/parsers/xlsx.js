import { loadDependency } from "./loadDependency.js";

const ExcelJS = loadDependency("exceljs");

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

const renderSheet = (worksheet) => {
  const renderedRows = [];

  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    const rendered = values
      .map((cell) => renderCellValue(cell))
      .filter(Boolean)
      .join(" | ");

    if (rendered) {
      renderedRows.push(rendered);
    }
  });

  if (renderedRows.length === 0) {
    return "";
  }

  return [`## ${worksheet.name}`, ...renderedRows].join("\n");
};

export const parseXlsx = async ({ buffer }) => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const renderedSheets = workbook.worksheets
    .map((worksheet) => renderSheet(worksheet))
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
