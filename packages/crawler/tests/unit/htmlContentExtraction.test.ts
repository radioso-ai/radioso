import { describe, expect, it } from "vitest";

import { buildFetchedHtmlPage } from "../../src/transport/htmlContentExtraction.js";

const page = (loadedUrl: string, body: string) =>
  buildFetchedHtmlPage({
    loadedUrl,
    originalHtml: `<html><head><title>Page</title></head><body>${body}</body></html>`,
    statusCode: 200,
    headers: {}
  });

describe("content quality gate", () => {
  it("keeps a short page whose extraction is otherwise clean", () => {
    const result = page(
      "https://example.com/contact-us",
      `<main>
        <p><a href="https://example.com/author/admin">Admin</a> 2026-02-27</p>
        <h1>Contact Us</h1>
        <h2>INFO:</h2><p>info@example.com</p>
        <h2>PRESS:</h2><p>For press events and interviews please contact us: info@example.com</p>
        <h2>OFFICE:</h2><p>+372 53 848 108</p>
      </main>`
    );

    expect(result.text.length).toBeLessThan(300);
    expect(result.skipReason).toBeNull();
  });

  it("still skips a short page that is mostly links", () => {
    const result = page(
      "https://example.com/related",
      `<main>
        <p>See also</p>
        <p><a href="https://example.com/articles/first-long-slug">First</a></p>
        <p><a href="https://example.com/articles/second-long-slug">Second</a></p>
        <p><a href="https://example.com/articles/third-long-slug">Third</a></p>
      </main>`
    );

    expect(result.skipReason).toBe("Skipped low-quality extracted content");
  });

  it("still skips a short page dominated by unrendered template markup", () => {
    const result = page(
      "https://example.com/shell",
      "<main><p>{{ page.title }}</p><p>{{ page.body | render }}</p><p>Loading</p></main>"
    );

    expect(result.skipReason).toBe("Skipped low-quality extracted content");
  });

  it("does not let a single byline link count as link-dense content", () => {
    const result = page(
      "https://example.com/note",
      `<main>
        <p><a href="https://example.com/author/some-long-author-slug">Author Name</a></p>
        <p>A brief note with a handful of words that stands on its own as content.</p>
      </main>`
    );

    expect(result.skipReason).toBeNull();
  });

  it("still skips an empty page", () => {
    expect(page("https://example.com/empty", "<main></main>").skipReason).toBe(
      "Page did not contain crawlable content"
    );
  });
});

describe("page title", () => {
  const titleOf = (html: string): string | null =>
    buildFetchedHtmlPage({
      loadedUrl: "https://example.com/retreats/yoga-weekend",
      originalHtml: html,
      statusCode: 200,
      headers: {}
    }).title;

  const BODY = "<main><h1>Yoga Retreat Weekend</h1><p>Two days of practice by the lake.</p></main>";

  it("takes the head title and ignores a second title inside an inline svg", () => {
    const title = titleOf(
      `<html><head><title>Yoga Retreat Weekend – Example Site</title></head>
       <body><svg width="0" height="0"><title>Template Page</title></svg>${BODY}</body></html>`
    );

    expect(title).toBe("Yoga Retreat Weekend – Example Site");
  });

  it("takes the first of two head titles", () => {
    const title = titleOf(
      `<html><head><title>Yoga Retreat Weekend – Example Site</title><title>Template Page</title></head>
       <body>${BODY}</body></html>`
    );

    expect(title).toBe("Yoga Retreat Weekend – Example Site");
  });

  it("takes the head title when a second title sits in the body", () => {
    const title = titleOf(
      `<html><head><title>Yoga Retreat Weekend – Example Site</title></head>
       <body><div><title>Template Page</title></div>${BODY}</body></html>`
    );

    expect(title).toBe("Yoga Retreat Weekend – Example Site");
  });

  it("takes the head title when a second head block opens in the body", () => {
    const title = titleOf(
      `<html><head><title>Yoga Retreat Weekend – Example Site</title></head>
       <body><head><title>Template Page</title></head>${BODY}</body></html>`
    );

    expect(title).toBe("Yoga Retreat Weekend – Example Site");
  });

  it("falls back to the first title outside the head when the head has none", () => {
    const title = titleOf(
      `<html><head><meta charset="utf-8"></head>
       <body><title>Yoga Retreat Weekend</title><title>Template Page</title>${BODY}</body></html>`
    );

    expect(title).toBe("Yoga Retreat Weekend");
  });

  it("does not take an svg label as the page title", () => {
    const title = titleOf(
      `<html><head><meta charset="utf-8"></head>
       <body><svg><title>Company logo</title></svg>${BODY}</body></html>`
    );

    expect(title).toBeNull();
  });

  it("trims and collapses whitespace inside the title", () => {
    const title = titleOf(
      `<html><head><title>
        Yoga   Retreat
        Weekend  </title></head><body>${BODY}</body></html>`
    );

    expect(title).toBe("Yoga Retreat Weekend");
  });

  it("is null when the title is empty or only whitespace", () => {
    expect(titleOf(`<html><head><title>   \n </title></head><body>${BODY}</body></html>`)).toBeNull();
    expect(titleOf(`<html><head><title></title></head><body>${BODY}</body></html>`)).toBeNull();
    expect(titleOf(`<html><head></head><body>${BODY}</body></html>`)).toBeNull();
  });

  it("skips an empty head title in favour of the next head title", () => {
    const title = titleOf(
      `<html><head><title> </title><title>Yoga Retreat Weekend</title></head><body>${BODY}</body></html>`
    );

    expect(title).toBe("Yoga Retreat Weekend");
  });
});
