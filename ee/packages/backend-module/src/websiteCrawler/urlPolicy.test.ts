import { describe, expect, it } from "vitest";

import { assertPublicWebsiteUrl } from "./urlPolicy.js";
import { WebsiteCrawlerBadRequestError } from "./errors.js";

describe("enterprise website crawler URL policy", () => {
  it("blocks localhost and private IP crawl targets", async () => {
    await expect(assertPublicWebsiteUrl("http://localhost:3000")).rejects.toThrow(WebsiteCrawlerBadRequestError);
    await expect(assertPublicWebsiteUrl("http://127.0.0.1")).rejects.toThrow(WebsiteCrawlerBadRequestError);
    await expect(assertPublicWebsiteUrl("http://10.0.0.5")).rejects.toThrow(WebsiteCrawlerBadRequestError);
    await expect(assertPublicWebsiteUrl("http://169.254.169.254")).rejects.toThrow(WebsiteCrawlerBadRequestError);
  });

  it("blocks special-use IPv4 crawl targets", async () => {
    await expect(assertPublicWebsiteUrl("http://192.0.0.1")).rejects.toThrow("publicly routable");
    await expect(assertPublicWebsiteUrl("http://192.0.2.1")).rejects.toThrow("publicly routable");
    await expect(assertPublicWebsiteUrl("http://198.18.0.1")).rejects.toThrow("publicly routable");
    await expect(assertPublicWebsiteUrl("http://198.51.100.1")).rejects.toThrow("publicly routable");
    await expect(assertPublicWebsiteUrl("http://203.0.113.1")).rejects.toThrow("publicly routable");
  });

  it("blocks private IPv4 ranges represented as IPv4-mapped IPv6 addresses", async () => {
    await expect(assertPublicWebsiteUrl("http://[::ffff:10.0.0.5]")).rejects.toThrow("publicly routable");
    await expect(assertPublicWebsiteUrl("http://[::ffff:100.64.0.1]")).rejects.toThrow("publicly routable");
    await expect(assertPublicWebsiteUrl("http://[::ffff:172.16.0.1]")).rejects.toThrow("publicly routable");
    await expect(assertPublicWebsiteUrl("http://[::ffff:192.168.1.1]")).rejects.toThrow("publicly routable");
    await expect(assertPublicWebsiteUrl("http://[::ffff:224.0.0.1]")).rejects.toThrow("publicly routable");
    await expect(assertPublicWebsiteUrl("http://[::ffff:ac10:1]")).rejects.toThrow("publicly routable");
  });

  it("blocks private IPv4 ranges represented as standard NAT64 IPv6 addresses", async () => {
    await expect(assertPublicWebsiteUrl("http://[64:ff9b::a9fe:a9fe]")).rejects.toThrow("publicly routable");
    await expect(assertPublicWebsiteUrl("http://[64:ff9b::a00:5]")).rejects.toThrow("publicly routable");
    await expect(assertPublicWebsiteUrl("http://[64:ff9b::c0a8:101]")).rejects.toThrow("publicly routable");
  });

  it("blocks special-use IPv6 crawl targets", async () => {
    await expect(assertPublicWebsiteUrl("http://[100::1]")).rejects.toThrow("publicly routable");
    await expect(assertPublicWebsiteUrl("http://[64:ff9b:1::1]")).rejects.toThrow("publicly routable");
    await expect(assertPublicWebsiteUrl("http://[2001:2::1]")).rejects.toThrow("publicly routable");
    await expect(assertPublicWebsiteUrl("http://[2001:db8::1]")).rejects.toThrow("publicly routable");
    await expect(assertPublicWebsiteUrl("http://[ff00::1]")).rejects.toThrow("publicly routable");
    await expect(assertPublicWebsiteUrl("http://[ff02::1]")).rejects.toThrow("publicly routable");
  });

  it("blocks hostnames that resolve to private addresses", async () => {
    await expect(assertPublicWebsiteUrl("https://internal.example", {
      lookup: async () => [{ address: "192.168.1.10", family: 4 }],
    })).rejects.toThrow("publicly routable");

    await expect(assertPublicWebsiteUrl("https://internal.example", {
      lookup: async () => [{ address: "198.51.100.10", family: 4 }],
    })).rejects.toThrow("publicly routable");

    await expect(assertPublicWebsiteUrl("https://internal.example", {
      lookup: async () => [{ address: "::ffff:172.16.0.1", family: 6 }],
    })).rejects.toThrow("publicly routable");

    await expect(assertPublicWebsiteUrl("https://internal.example", {
      lookup: async () => [{ address: "64:ff9b::a9fe:a9fe", family: 6 }],
    })).rejects.toThrow("publicly routable");

    await expect(assertPublicWebsiteUrl("https://internal.example", {
      lookup: async () => [{ address: "2001:db8::1", family: 6 }],
    })).rejects.toThrow("publicly routable");
  });

  it("allows hostnames that resolve only to public addresses", async () => {
    await expect(assertPublicWebsiteUrl("https://example.com", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    })).resolves.toBeUndefined();

    await expect(assertPublicWebsiteUrl("https://nat64.example", {
      lookup: async () => [{ address: "64:ff9b::5db8:d822", family: 6 }],
    })).resolves.toBeUndefined();
  });
});
