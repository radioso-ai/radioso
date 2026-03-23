import { loadDependency } from "./loadDependency.js";

const XLSX = loadDependency("xlsx");

const renderSheet = (workbook, sheetName) => {
  const worksheet = workbook.Sheets[sheetName];
  if (!worksheet) {
    return "";
  }

  const rows = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    raw: false,
    blankrows: false,
    defval: "",
  });

  const renderedRows = rows
    .map((row) => row.map((cell) => String(cell).trim()).filter(Boolean).join(" | "))
    .filter(Boolean);

  if (renderedRows.length === 0) {
    return "";
  }

  return [`## ${sheetName}`, ...renderedRows].join("\n");
};

export const parseXlsx = async ({ buffer }) => {
  const workbook = XLSX.read(buffer, {
    type: "buffer",
    cellText: true,
    cellDates: true,
  });

  const renderedSheets = workbook.SheetNames.map((sheetName) => renderSheet(workbook, sheetName)).filter(Boolean);
  const text = renderedSheets.join("\n\n");

  return {
    text,
    markdown: text,
    sourceHints: {
      sheetNames: workbook.SheetNames,
    },
  };
};
