import { describe, expect, it } from "vitest";

import { buildFetchedHtmlPage } from "../../src/transport/htmlContentExtraction.js";

const LOADED_URL = "https://shop.example/books/alpine-flowers";

const crawl = (head: string, body: string) =>
  buildFetchedHtmlPage({
    loadedUrl: LOADED_URL,
    originalHtml: `<html><head><title>A Field Guide to Alpine Flowers</title>${head}</head><body>${body}</body></html>`,
    statusCode: 200,
    headers: {},
  });

const LONG_PARAGRAPH = "The guide walks through every meadow above the tree line, season by season, with notes on where each flower grows and when it opens.";

describe("page images", () => {
  it("takes the page's metadata picture as its primary image, once per address", () => {
    const page = crawl(
      `<meta property="og:image" content="https://cdn.shop.example/covers/alpine.jpg">
       <meta name="twitter:image" content="https://cdn.shop.example/covers/alpine.jpg">`,
      `<main><p>${LONG_PARAGRAPH}</p></main>`,
    );

    expect(page.images).toEqual([
      { url: "https://cdn.shop.example/covers/alpine.jpg", role: "primary", alt: "", caption: null, textOffset: null },
    ]);
  });

  it("reads a JSON-LD image after the social tags, resolving a graph reference and skipping the site's logo", () => {
    const graph = {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "Organization", "@id": "https://shop.example/#org", logo: "https://shop.example/logo.png", image: "https://shop.example/logo.png" },
        { "@type": "WebPage", "@id": `${LOADED_URL}#page`, primaryImageOfPage: { "@id": `${LOADED_URL}#cover` } },
        { "@type": "ImageObject", "@id": `${LOADED_URL}#cover`, contentUrl: "/media/alpine-cover.webp" },
      ],
    };
    const page = crawl(
      `<meta property="og:image" content="https://cdn.shop.example/share/banner.jpg">
       <script type="application/ld+json">${JSON.stringify(graph)}</script>`,
      `<main><p>${LONG_PARAGRAPH}</p></main>`,
    );

    expect(page.images?.map((image) => [image.url, image.role])).toEqual([
      ["https://cdn.shop.example/share/banner.jpg", "primary"],
      ["https://shop.example/media/alpine-cover.webp", "primary"],
    ]);
  });

  it("reads a top-level JSON-LD image, and ignores a block that does not parse", () => {
    const product = { "@context": "https://schema.org", "@type": "Product", name: "Alpine Flowers", image: ["https://cdn.shop.example/p/1.jpg", "https://cdn.shop.example/p/2.jpg"] };
    const page = crawl(
      `<script type="application/ld+json">{ not json</script>
       <script type="application/ld+json">${JSON.stringify(product)}</script>`,
      `<main><p>${LONG_PARAGRAPH}</p></main>`,
    );

    expect(page.images?.map((image) => image.url)).toEqual(["https://cdn.shop.example/p/1.jpg"]);
  });

  it("captures images inside the main content with their alt text, caption and place in the text", () => {
    const page = crawl(
      "",
      `<header><img src="/logo.png" alt="Shop logo"></header>
       <main>
         <h1>A Field Guide to Alpine Flowers</h1>
         <p>${LONG_PARAGRAPH}</p>
         <figure>
           <img src="/media/gentians.jpg" alt="Gentians in bloom">
           <figcaption>Gentians on the ridge above the village</figcaption>
         </figure>
         <p>Edelweiss grows on limestone ledges and opens late in the summer.</p>
         <img data-src="https://cdn.shop.example/edelweiss.jpg" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="">
         <p>The last chapter covers the autumn crocus.</p>
       </main>`,
    );

    const inline = page.images?.filter((image) => image.role === "inline") ?? [];
    expect(inline.map(({ url, alt, caption }) => ({ url, alt, caption }))).toEqual([
      { url: "https://shop.example/media/gentians.jpg", alt: "Gentians in bloom", caption: "Gentians on the ridge above the village" },
      { url: "https://cdn.shop.example/edelweiss.jpg", alt: "", caption: null },
    ]);
    const [gentians, edelweiss] = inline;
    expect(page.text.slice(0, gentians.textOffset ?? -1)).toMatch(/opens\.$/);
    expect(page.text.slice(gentians.textOffset ?? 0)).toMatch(/^\s*Gentians on the ridge/);
    expect(page.text.slice(0, edelweiss.textOffset ?? -1)).toMatch(/late in the summer\.$/);
    expect(page.images?.some((image) => image.url.endsWith("/logo.png"))).toBe(false);
  });

  it("anchors an image after a link by the text that follows the link", () => {
    const page = crawl(
      "",
      `<main>
         <p>${LONG_PARAGRAPH} Read the <a href="https://shop.example/blog/meadows">meadow notes</a> first.</p>
         <img src="https://cdn.shop.example/meadow.jpg" alt="A meadow">
         <p>${LONG_PARAGRAPH}</p>
       </main>`,
    );

    const [meadow] = page.images ?? [];
    expect(page.text.slice(0, meadow.textOffset ?? -1)).toMatch(/first\.$/);
  });

  it("picks the smallest source of a srcset that is still at least 640 wide", () => {
    const page = crawl(
      "",
      `<main><p>${LONG_PARAGRAPH}</p>
        <img src="/s.jpg" srcset="/w320.jpg 320w, /w800.jpg 800w, /w1600.jpg 1600w" alt="Cover">
        <img srcset="/only-small.jpg 300w, /small2.jpg 500w" alt="Back">
      </main>`,
    );

    expect(page.images?.map((image) => image.url)).toEqual([
      "https://shop.example/w800.jpg",
      "https://shop.example/small2.jpg",
    ]);
  });

  it("refuses inline data URIs, SVG files and addresses that are not http(s)", () => {
    const page = crawl(
      `<meta property="og:image" content="https://cdn.shop.example/share.svg">`,
      `<main><p>${LONG_PARAGRAPH}</p>
        <img src="data:image/png;base64,iVBORw0KGgo=" alt="Embedded">
        <img src="/icons/star.svg?v=2" alt="Star">
        <img src="ftp://files.shop.example/cover.jpg" alt="Old">
        <img src="javascript:alert(1)" alt="Script">
      </main>`,
    );

    expect(page.images).toEqual([]);
  });

  it("keeps the first 24 inline images of a long gallery", () => {
    const gallery = Array.from({ length: 30 }, (_value, index) => `<img src="/g/${index}.jpg" alt="Photo ${index}">`).join("");
    const page = crawl("", `<main><p>${LONG_PARAGRAPH}</p>${gallery}</main>`);

    expect(page.images).toHaveLength(24);
    expect(page.images?.at(-1)?.url).toBe("https://shop.example/g/23.jpg");
  });
});
