import { describe, expect, it } from "vitest";

import { placeApiRequest } from "../../../src/modules/apiRequestSkills/requestPlacement.js";

describe("placeApiRequest", () => {
  const baseUrl = "https://api.example.com/v1/";

  it("fills a path placeholder URL-encoded and sends the rest of a GET as the query string", () => {
    const placed = placeApiRequest({
      baseUrl,
      method: "GET",
      path: "/orders/{order_number}",
      params: { order_number: "A 1?2", expand: "items", limit: 5, active: true, tags: ["a", "b"], skipped: null },
    });

    expect(placed).toEqual({
      kind: "placed",
      url: "https://api.example.com/v1/orders/A%201%3F2?expand=items&limit=5&active=true&tags=a&tags=b",
    });
  });

  it("sends an object query value as JSON text", () => {
    const placed = placeApiRequest({ baseUrl, method: "DELETE", path: "/sessions", params: { filter: { a: 1 } } });

    expect(placed).toEqual({
      kind: "placed",
      url: `https://api.example.com/v1/sessions?filter=${encodeURIComponent('{"a":1}')}`,
    });
  });

  it("sends the rest of a POST, PUT or PATCH as a JSON body, nesting dotted keys", () => {
    for (const method of ["POST", "PUT", "PATCH"] as const) {
      const placed = placeApiRequest({
        baseUrl,
        method,
        path: "/customers/{id}/tickets",
        params: { id: 42, subject: "Late order", "customer.email": "visitor@example.com", "customer.name": "Ada" },
      });

      expect(placed).toEqual({
        kind: "placed",
        url: "https://api.example.com/v1/customers/42/tickets",
        body: JSON.stringify({ subject: "Late order", customer: { email: "visitor@example.com", name: "Ada" } }),
      });
    }
  });

  it("sends an empty JSON object when a body method has nothing left to send", () => {
    expect(placeApiRequest({ baseUrl, method: "POST", path: "/ping", params: {} }))
      .toEqual({ kind: "placed", url: "https://api.example.com/v1/ping", body: "{}" });
  });

  it("refuses a path value that is not a scalar, is empty, is a dot segment, or carries a slash or backslash", () => {
    for (const value of [{ a: 1 }, ["a"], "", ".", "..", "../../admin/users/7", "a/b", "..\\admin", "a\\b", "x/..", "%2e%2e"]) {
      expect(placeApiRequest({ baseUrl, method: "GET", path: "/orders/{id}", params: { id: value } }))
        .toEqual({ kind: "invalid_input", param: "id" });
    }
  });

  it("never leaves the base URL's origin", () => {
    expect(placeApiRequest({ baseUrl: "https://api.example.com", method: "GET", path: "//evil.example/x", params: {} }))
      .toMatchObject({ kind: "placed", url: "https://api.example.com//evil.example/x" });
  });
});
