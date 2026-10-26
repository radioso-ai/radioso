import { describe, expect, it, vi } from "vitest";

import { createDocumentSearchCopilotTools, documentSearchInputSchema } from "../../../src/modules/operatorCopilot/tools/documents.js";
import type { CopilotDocumentSearchPort } from "../../../src/modules/operatorCopilot/tools/documents.js";
import { context } from "./copilot-tools-test-helpers.js";

const toolFor = (search: CopilotDocumentSearchPort["search"]) => {
  const [descriptor] = createDocumentSearchCopilotTools({ documentSearchService: { search } });
  return descriptor;
};

/** The runtime supplies the tool context; these tests exercise projection, not the runtime. */
const toolContext = {} as never;

describe("document_search input validation", () => {
  it("accepts a query with no date range", () => {
    expect(() => documentSearchInputSchema.parse({ query: "course listings" })).not.toThrow();
  });

  it("accepts a valid date range", () => {
    const parsed = documentSearchInputSchema.parse({
      query: "course listings",
      dateFrom: "2027-01-03",
      dateTo: "2027-01-06",
    });
    expect(parsed).toEqual({ query: "course listings", dateFrom: "2027-01-03", dateTo: "2027-01-06" });
  });

  it("rejects dateFrom without dateTo", () => {
    expect(() => documentSearchInputSchema.parse({ query: "course listings", dateFrom: "2027-01-03" })).toThrow();
  });

  it("rejects dateTo without dateFrom", () => {
    expect(() => documentSearchInputSchema.parse({ query: "course listings", dateTo: "2027-01-06" })).toThrow();
  });

  it("rejects an inverted range the same way readRequestedDateRange would", () => {
    expect(() => documentSearchInputSchema.parse({
      query: "course listings",
      dateFrom: "2027-01-06",
      dateTo: "2027-01-03",
    })).toThrow();
  });

  it("rejects a range longer than readRequestedDateRange's day cap", () => {
    expect(() => documentSearchInputSchema.parse({
      query: "course listings",
      dateFrom: "2020-01-01",
      dateTo: "2027-01-01",
    })).toThrow();
  });
});

describe("document_search descriptor", () => {
  it("searches without a date range when none is given", async () => {
    const search = vi.fn(async () => ({ results: [] }));
    const descriptor = toolFor(search);

    await descriptor.createTool(context("agent-1")).invoke({ query: "course listings" }, toolContext);

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: "course listings" }));
    expect(search).not.toHaveBeenCalledWith(expect.objectContaining({ dateFrom: expect.anything() }));
  });

  it("passes an explicit date range through to the backing search", async () => {
    const search = vi.fn(async () => ({ results: [] }));
    const descriptor = toolFor(search);

    await descriptor.createTool(context("agent-1")).invoke({
      query: "which courses run from 3 to 6 January 2027",
      dateFrom: "2027-01-03",
      dateTo: "2027-01-06",
    }, toolContext);

    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      query: "which courses run from 3 to 6 January 2027",
      dateFrom: "2027-01-03",
      dateTo: "2027-01-06",
    }));
  });
});
