import { describe, expect, it, vi } from "vitest";

import type { ConnectorSourcesPort } from "@radioso/connector-api";
import {
  connectedSiteForPush,
  normalizeWordpressSiteUrl,
  wordpressConnectedSites,
  wordpressPushHost,
  wordpressUrlBelongsToSite,
  type WordpressConnectedSite,
} from "../../../../src/modules/connectors/plugins/wordpress/wordpressSource.js";

describe("WordPress source URLs", () => {
  it("normalizes equivalent site URLs to one source identity", () => {
    expect(normalizeWordpressSiteUrl(" HTTPS://Example.COM/blog/// ")).toBe(
      "https://example.com/blog",
    );
  });

  it("accepts post permalinks under the configured site path", () => {
    expect(
      wordpressUrlBelongsToSite(
        "https://example.com/blog",
        "https://example.com/blog/posts/welcome",
      ),
    ).toBe(true);
  });

  it("rejects sibling paths, foreign origins, and invalid URLs", () => {
    expect(
      wordpressUrlBelongsToSite(
        "https://example.com/blog",
        "https://example.com/blogger/welcome",
      ),
    ).toBe(false);
    expect(
      wordpressUrlBelongsToSite(
        "https://example.com/blog",
        "https://other.example/blog/welcome",
      ),
    ).toBe(false);
    expect(wordpressUrlBelongsToSite("https://example.com/blog", "not a URL")).toBe(
      false,
    );
  });
});

const siteAt = (siteUrl: string, sourceId: string): WordpressConnectedSite => ({ sourceId, siteUrl });

describe("WordPress connected sites", () => {
  it("reads the workspace's WordPress sources from the host and keeps their site URLs", async () => {
    const listSources = vi.fn<ConnectorSourcesPort["listSources"]>(async () => [
      {
        id: "src-1",
        source: {
          externalId: "wordpress:https://one.example.org",
          name: "one.example.org",
          config: { siteUrl: "https://one.example.org" },
          metadata: { connectorId: "wordpress" },
        },
      },
      // A source with no usable site URL can never match a push, so it is dropped.
      { id: "src-2", source: { externalId: "wordpress:broken", name: "broken", config: {} } },
    ]);

    const sites = await wordpressConnectedSites({ listSources }).listConnectedSites("ws-1");

    expect(listSources).toHaveBeenCalledWith("ws-1");
    expect(sites).toEqual([siteAt("https://one.example.org", "src-1")]);
  });

  it("matches a push by its signed site URL and its permalink", () => {
    const one = siteAt("https://one.example.org", "src-1");
    const two = siteAt("https://two.example.org", "src-2");

    expect(
      connectedSiteForPush([one, two], {
        siteUrl: "https://two.example.org/",
        link: "https://two.example.org/about",
      }),
    ).toBe(two);
    expect(
      connectedSiteForPush([one, two], {
        siteUrl: "https://two.example.org/",
        link: "https://one.example.org/about",
      }),
    ).toBeNull();
    expect(
      connectedSiteForPush([one, two], {
        siteUrl: "https://three.example.org/",
        link: "https://three.example.org/about",
      }),
    ).toBeNull();
  });

  it("picks the most specific site when a push names no site URL and the sites nest", () => {
    const root = siteAt("https://example.org", "src-root");
    const blog = siteAt("https://example.org/blog", "src-blog");

    expect(connectedSiteForPush([root, blog], { link: "https://example.org/blog/welcome" })).toBe(blog);
    expect(connectedSiteForPush([blog, root], { link: "https://example.org/blog/welcome" })).toBe(blog);
    expect(connectedSiteForPush([root, blog], { link: "https://example.org/contact" })).toBe(root);
  });

  it("names the push's host from its signed site URL, else from its permalink", () => {
    expect(
      wordpressPushHost({ siteUrl: "https://one.example.org:8443/", link: "https://cdn.example.net/a" }),
    ).toBe("one.example.org:8443");
    expect(wordpressPushHost({ link: "https://two.example.org/about?p=1" })).toBe("two.example.org");
  });
});
