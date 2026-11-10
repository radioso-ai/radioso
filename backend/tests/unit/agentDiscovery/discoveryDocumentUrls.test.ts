import { describe, expect, it } from "vitest";

import {
  A2A_ENDPOINT_MOUNT_PATH,
  agentA2aEndpointUrl,
} from "../../../src/modules/agentDiscovery/public.js";

describe("agentA2aEndpointUrl", () => {
  it("hangs the A2A path on the public API base", () => {
    expect(agentA2aEndpointUrl("https://api.example.com", "ag_pub")).toBe("https://api.example.com/a2a/ag_pub");
  });

  it("keeps the path prefix the base is served under, as the dashboard's /backend proxy needs", () => {
    expect(agentA2aEndpointUrl("https://app.example.com/backend", "ag_pub")).toBe(
      "https://app.example.com/backend/a2a/ag_pub",
    );
  });

  it("drops trailing slashes on the base rather than doubling them", () => {
    expect(agentA2aEndpointUrl("https://app.example.com/backend//", "ag_pub")).toBe(
      "https://app.example.com/backend/a2a/ag_pub",
    );
  });

  it("agrees with the path the route is mounted at, so the URL a card names is the URL the router answers", () => {
    const url = new URL(agentA2aEndpointUrl("https://api.example.com", "ag_pub"));

    expect(url.pathname).toBe(A2A_ENDPOINT_MOUNT_PATH.replace(":publicId", "ag_pub"));
  });
});
