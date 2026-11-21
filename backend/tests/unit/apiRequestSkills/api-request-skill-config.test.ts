import { describe, expect, it } from "vitest";

import {
  apiConnectionCreateSchema,
  apiRequestSkillConfigSchema,
} from "../../../src/modules/apiRequestSkills/public.js";

const issuesOf = (result: { success: boolean; error?: { issues: Array<{ message: string }> } }): string =>
  (result.error?.issues ?? []).map((issue) => issue.message).join(" | ");

describe("apiRequestSkillConfigSchema", () => {
  it("accepts a GET with a typed path param and typed outputs, filling defaults", () => {
    const parsed = apiRequestSkillConfigSchema.parse({
      method: "GET",
      path: "/orders/{order_number}",
      exposedParams: { order_number: { type: "text", description: "The order number", slotBinding: "order" } },
      outputs: {
        order_status: { path: "order.status", type: "text" },
        items: { path: "items", type: "list", fields: { title: { path: "title", type: "text", role: "title" } } },
      },
    });

    expect(parsed).toEqual({
      method: "GET",
      path: "/orders/{order_number}",
      boundParams: {},
      exposedParams: {
        order_number: { type: "text", description: "The order number", slotBinding: "order", required: true, verifiedOnly: false },
      },
      outputs: {
        order_status: { path: "order.status", type: "text", required: false },
        items: {
          path: "items",
          type: "list",
          required: false,
          maxItems: 10,
          fields: { title: { path: "title", type: "text", role: "title" } },
        },
      },
    });
  });

  it("requires every exposed param to name its type", () => {
    expect(apiRequestSkillConfigSchema.safeParse({ method: "POST", path: "/x", exposedParams: { subject: {} } }).success).toBe(false);
    expect(apiRequestSkillConfigSchema.safeParse({ method: "POST", path: "/x", exposedParams: { subject: { type: "item" } } }).success).toBe(false);
  });

  it("refuses a placeholder no param declares", () => {
    const result = apiRequestSkillConfigSchema.safeParse({ method: "GET", path: "/orders/{order_number}" });

    expect(result.success).toBe(false);
    expect(issuesOf(result)).toContain("order_number");
  });

  it("refuses a key that is both bound and exposed", () => {
    const result = apiRequestSkillConfigSchema.safeParse({
      method: "POST",
      path: "/tickets",
      boundParams: { priority: "high" },
      exposedParams: { priority: { type: "text" } },
    });

    expect(result.success).toBe(false);
    expect(issuesOf(result)).toContain("disjoint");
  });

  it("refuses param keys that reach an object's prototype or have empty segments", () => {
    for (const key of ["customer.__proto__", "constructor", "customer..email", "1st"]) {
      const result = apiRequestSkillConfigSchema.safeParse({ method: "POST", path: "/x", boundParams: { [key]: "v" } });
      expect(result.success, key).toBe(false);
    }
    // A JSON `__proto__` key is an own property; the record schema drops it rather than keeping it.
    const proto = apiRequestSkillConfigSchema.safeParse(JSON.parse('{"method":"POST","path":"/x","boundParams":{"__proto__":"v"}}'));
    expect(proto.success ? Object.keys(proto.data.boundParams) : []).toEqual([]);
  });

  it("refuses a body key that is also the parent of another dotted key", () => {
    const result = apiRequestSkillConfigSchema.safeParse({
      method: "POST",
      path: "/tickets",
      boundParams: { customer: "x" },
      exposedParams: { "customer.email": { type: "email" } },
    });

    expect(result.success).toBe(false);
    expect(issuesOf(result)).toContain("customer");
  });

  it("refuses a path that is not absolute, carries a query or fragment, or has an unbalanced brace", () => {
    for (const path of ["orders", "//orders", "/orders?x=1", "/orders#top", "/orders/{id", "/orders/ id", "/orders/{}"]) {
      const result = apiRequestSkillConfigSchema.safeParse({
        method: "GET",
        path,
        exposedParams: { id: { type: "text" } },
      });
      expect(result.success, path).toBe(false);
    }
  });

  it("refuses a bound path placeholder that is not a scalar", () => {
    const result = apiRequestSkillConfigSchema.safeParse({
      method: "GET",
      path: "/orders/{id}",
      boundParams: { id: { nested: true } },
    });

    expect(result.success).toBe(false);
  });

  it("holds outputs to the skill data contract", () => {
    expect(apiRequestSkillConfigSchema.safeParse({ method: "GET", path: "/x", outputs: { status: { path: "a" } } }).success).toBe(false);
    expect(apiRequestSkillConfigSchema.safeParse({ method: "GET", path: "/x", outputs: { status: { path: "a.__proto__", type: "text" } } }).success).toBe(false);
  });

  it("refuses an unknown method and unknown fields", () => {
    expect(apiRequestSkillConfigSchema.safeParse({ method: "HEAD", path: "/x" }).success).toBe(false);
    expect(apiRequestSkillConfigSchema.safeParse({ method: "GET", path: "/x", template: "{}" }).success).toBe(false);
  });
});

describe("apiConnectionCreateSchema", () => {
  it("accepts a bearer connection with non-secret default headers", () => {
    const parsed = apiConnectionCreateSchema.parse({
      name: "Orders API",
      baseUrl: "https://api.example.com/v1",
      authScheme: "bearer",
      credential: "token-123",
      defaultHeaders: { "X-Api-Version": "2024-01" },
    });

    expect(parsed).toMatchObject({ authScheme: "bearer", defaultHeaders: { "X-Api-Version": "2024-01" } });
  });

  it("requires a header name for the header scheme and a credential for every scheme but none", () => {
    expect(apiConnectionCreateSchema.safeParse({ name: "a", baseUrl: "https://api.example.com", authScheme: "header", credential: "k" }).success).toBe(false);
    expect(apiConnectionCreateSchema.safeParse({ name: "a", baseUrl: "https://api.example.com", authScheme: "bearer" }).success).toBe(false);
    expect(apiConnectionCreateSchema.safeParse({ name: "a", baseUrl: "https://api.example.com", authScheme: "none", credential: "k" }).success).toBe(false);
    expect(apiConnectionCreateSchema.safeParse({ name: "a", baseUrl: "https://api.example.com", authScheme: "header", authHeaderName: "X-Api-Key", credential: "k" }).success).toBe(true);
  });

  it("requires a basic credential to be user:password", () => {
    expect(apiConnectionCreateSchema.safeParse({ name: "a", baseUrl: "https://api.example.com", authScheme: "basic", credential: "nocolon" }).success).toBe(false);
    expect(apiConnectionCreateSchema.safeParse({ name: "a", baseUrl: "https://api.example.com", authScheme: "basic", credential: "user:pass" }).success).toBe(true);
  });

  it("refuses default headers that carry transport, cookie or credential meaning, or the auth header", () => {
    for (const name of ["Host", "content-length", "Authorization", "Cookie", "Connection", "Transfer-Encoding"]) {
      const result = apiConnectionCreateSchema.safeParse({
        name: "a",
        baseUrl: "https://api.example.com",
        defaultHeaders: { [name]: "x" },
      });
      expect(result.success, name).toBe(false);
    }
    expect(apiConnectionCreateSchema.safeParse({
      name: "a",
      baseUrl: "https://api.example.com",
      authScheme: "header",
      authHeaderName: "X-Api-Key",
      credential: "k",
      defaultHeaders: { "x-api-key": "other" },
    }).success).toBe(false);
  });

  it("refuses header values and credentials with line breaks", () => {
    expect(apiConnectionCreateSchema.safeParse({ name: "a", baseUrl: "https://api.example.com", defaultHeaders: { "X-A": "a\r\nb" } }).success).toBe(false);
    expect(apiConnectionCreateSchema.safeParse({ name: "a", baseUrl: "https://api.example.com", authScheme: "bearer", credential: "a\nb" }).success).toBe(false);
  });
});
