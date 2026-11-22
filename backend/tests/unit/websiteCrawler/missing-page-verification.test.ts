import { describe, expect, it } from "vitest";

import {
  decideVerifiedRemoval,
  fetchablePageUrl,
  judgePageAnswer,
  type WebsitePageAnswer,
} from "../../../src/modules/websiteCrawler/missingPageVerification.js";

const site = "https://docs.example";
const idOf = (path: string) => `website:${site}:${site}${path}`;
const answered = (status: number, path: string): WebsitePageAnswer => ({ kind: "answered", status, url: `${site}${path}` });
const judge = (answer: WebsitePageAnswer, path = "/pricing") =>
  judgePageAnswer({ websiteBaseUrl: site, externalDocumentId: idOf(path), answer });

describe("what a site's answer says about a page a crawl did not find", () => {
  it("is gone when the site answers 404 or 410, after any redirect", () => {
    expect(judge(answered(404, "/pricing"))).toBe("gone");
    expect(judge(answered(410, "/pricing"))).toBe("gone");
    expect(judge(answered(404, "/somewhere-else"))).toBe("gone");
  });

  it("is gone when the site sends it to a different page that answers", () => {
    expect(judge(answered(200, "/plans"))).toBe("gone");
    expect(judge(answered(200, ""))).toBe("gone");
  });

  it("is alive when the page itself answers, however its address is spelled", () => {
    expect(judge(answered(200, "/pricing"))).toBe("alive");
    expect(judge(answered(204, "/pricing/"))).toBe("alive");
    expect(judge(answered(200, "/pricing#plans"))).toBe("alive");
  });

  it("is unknown when the answer proves nothing", () => {
    expect(judge(answered(503, "/pricing"))).toBe("unknown");
    expect(judge(answered(500, "/maintenance"))).toBe("unknown");
    expect(judge(answered(403, "/pricing"))).toBe("unknown");
    expect(judge(answered(429, "/pricing"))).toBe("unknown");
    expect(judge(answered(301, "/loop"))).toBe("unknown");
    expect(judge({ kind: "unreachable" })).toBe("unknown");
    expect(judge({ kind: "answered", status: 200, url: "ftp://docs.example/pricing" })).toBe("unknown");
  });
});

describe("the address a missing page is asked about at", () => {
  it("is the address it was published under, when that names the page", () => {
    expect(fetchablePageUrl({ websiteBaseUrl: site, externalDocumentId: idOf("/pricing"), pageUrl: `${site}/pricing` }))
      .toBe(`${site}/pricing`);
  });

  it("is none when the page has no address, one naming another page, or one with a part redacted", () => {
    expect(fetchablePageUrl({ websiteBaseUrl: site, externalDocumentId: idOf("/pricing"), pageUrl: null })).toBeNull();
    expect(fetchablePageUrl({ websiteBaseUrl: site, externalDocumentId: idOf("/pricing"), pageUrl: `${site}/other` })).toBeNull();
    expect(fetchablePageUrl({ websiteBaseUrl: site, externalDocumentId: idOf("/pricing"), pageUrl: "not a url" })).toBeNull();
    const redacted = `${site}/download?token=%5Bredacted%5D`;
    expect(fetchablePageUrl({ websiteBaseUrl: site, externalDocumentId: `website:${site}:${redacted}`, pageUrl: redacted })).toBeNull();
  });
});

describe("which missing pages a crawl removes", () => {
  it("removes only the pages the site said are gone, and counts every verdict", () => {
    expect(decideVerifiedRemoval([
      { documentId: "doc-404", verdict: "gone" },
      { documentId: "doc-moved", verdict: "gone" },
      { documentId: "doc-200", verdict: "alive" },
      { documentId: "doc-503", verdict: "unknown" },
      { documentId: "doc-no-address", verdict: "unknown" },
    ])).toEqual({
      removeDocumentIds: ["doc-404", "doc-moved"],
      gone: 2,
      alive: 1,
      unknown: 2,
    });
  });
});
