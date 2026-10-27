import { describe, expect, it } from "vitest";

import { isPubliclyReachableHostname } from "../../src/shared/domain/publicNetwork.js";

describe("isPubliclyReachableHostname", () => {
  it.each([
    "api.example.com",
    "example.com",
    "api.radioso.ai",
    "api-us.radioso.ai",
    "8.8.8.8",
    "93.184.216.34",
    "2606:4700:4700::1111",
  ])("reads %s as reachable from the public internet", (hostname) => {
    expect(isPubliclyReachableHostname(hostname)).toBe(true);
  });

  it.each([
    "localhost",
    "foo.localhost",
    "127.0.0.1",
    "127.255.255.255",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.1.1",
    "::1",
    "[::1]",
    "fe80::1",
    "my-service.local",
    "backend.internal",
    "sub.backend.internal",
    "backend",
    "frontend",
    "radioso",
  ])("reads %s as not reachable from the public internet", (hostname) => {
    expect(isPubliclyReachableHostname(hostname)).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isPubliclyReachableHostname("LOCALHOST")).toBe(false);
    expect(isPubliclyReachableHostname("Backend.Internal")).toBe(false);
    expect(isPubliclyReachableHostname("API.EXAMPLE.COM")).toBe(true);
  });
});
