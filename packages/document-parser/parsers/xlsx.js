import { loadDependency } from "./loadDependency.js";

const ExcelJS = loadDependency("exceljs");

const renderSheet = (worksheet) => {
  const renderedRows = [];

  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    const rendered = values
      .map((cell) => {
        if (cell === null || cell === undefined) {
          return "";
        }

        if (typeof cell === "object" && cell !== null && "text" in cell && typeof cell.text === "string") {
          return cell.text.trim();
        }

        return String(cell).trim();
      })
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
