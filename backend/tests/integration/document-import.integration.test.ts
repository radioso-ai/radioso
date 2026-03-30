import ExcelJS from "exceljs";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

const buildWorkbookBuffer = async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Quarterly Report");
  sheet.addRow(["Quarter", "Revenue"]);
  sheet.addRow(["Q1", 1200]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
};

describe("document import integration", () => {
  it("accepts a supported spreadsheet import on the remediated parser path", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "spreadsheet-import@example.com");
    const workbookBuffer = await buildWorkbookBuffer();

    const response = await request(app)
      .post("/api/v1/document/import")
      .set(adminSessionHeaders(session))
      .attach("file", workbookBuffer, {
        filename: "quarterly-report.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      documentId: expect.any(String),
      status: "queued",
    });
  });
});
