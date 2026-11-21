import { describe, expect, it } from "vitest";

import {
  outcomeForStatus,
  outcomeForTransportFailure,
} from "../../../src/modules/apiRequestSkills/outcomes.js";
import { previewJsonBody } from "../../../src/modules/apiRequestSkills/bodyPreview.js";

describe("previewJsonBody", () => {
  it("returns a body within the budget unchanged", () => {
    expect(previewJsonBody({ a: [1, 2] }, 1_000)).toEqual({ body: { a: [1, 2] }, truncated: false });
  });

  it("cuts a body down to fit the budget and says so", () => {
    const body = { items: Array.from({ length: 200 }, (_, index) => ({ id: index, title: `Item ${index}` })) };

    const preview = previewJsonBody(body, 500);

    expect(preview.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(preview.body), "utf8")).toBeLessThanOrEqual(500);
    expect((preview.body as { items: unknown[] }).items[0]).toEqual({ id: 0, title: "Item 0" });
  });

  it("shortens a long string rather than dropping it", () => {
    const preview = previewJsonBody({ text: "y".repeat(2_000) }, 300);

    expect(preview.truncated).toBe(true);
    expect(typeof (preview.body as { text: string }).text).toBe("string");
    expect(Buffer.byteLength(JSON.stringify(preview.body), "utf8")).toBeLessThanOrEqual(300);
  });
});

describe("outcome mapping", () => {
  it("maps each status to its outcome and reason", () => {
    expect(outcomeForStatus(200)).toEqual({ outcome: "completed" });
    expect(outcomeForStatus(204)).toEqual({ outcome: "completed" });
    expect(outcomeForStatus(404)).toEqual({ outcome: "not_found" });
    expect(outcomeForStatus(400)).toEqual({ outcome: "rejected" });
    expect(outcomeForStatus(409)).toEqual({ outcome: "rejected" });
    expect(outcomeForStatus(422)).toEqual({ outcome: "rejected" });
    expect(outcomeForStatus(401)).toEqual({ outcome: "failed", reason: "auth_rejected" });
    expect(outcomeForStatus(403)).toEqual({ outcome: "failed", reason: "auth_rejected" });
    expect(outcomeForStatus(429)).toEqual({ outcome: "failed", reason: "rate_limited" });
    expect(outcomeForStatus(500)).toEqual({ outcome: "failed", reason: "upstream_error" });
    expect(outcomeForStatus(503)).toEqual({ outcome: "failed", reason: "upstream_error" });
    expect(outcomeForStatus(302)).toEqual({ outcome: "failed", reason: "upstream_error" });
  });

  it("maps every transport failure to failed with its reason", () => {
    expect(outcomeForTransportFailure("blocked")).toEqual({ outcome: "failed", reason: "blocked" });
    expect(outcomeForTransportFailure("timeout")).toEqual({ outcome: "failed", reason: "timeout" });
    expect(outcomeForTransportFailure("too_large")).toEqual({ outcome: "failed", reason: "response_too_large" });
    expect(outcomeForTransportFailure("redirect_refused")).toEqual({ outcome: "failed", reason: "redirect_refused" });
    expect(outcomeForTransportFailure("too_many_redirects")).toEqual({ outcome: "failed", reason: "redirect_refused" });
    expect(outcomeForTransportFailure("unreachable")).toEqual({ outcome: "failed", reason: "network" });
  });
});
