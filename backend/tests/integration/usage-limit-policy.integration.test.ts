import request from "supertest";
import { describe, expect, it } from "vitest";

import type { UsageLimitPolicy, UsageLimitReservation } from "../../src/shared/domain/usageLimitPolicy.js";
import { AppError } from "../../src/shared/domain/errors.js";
import { createTestApp, issueTestToken } from "../support/testApp.js";

type BlockedResource =
  | "monthly_answers"
  | "stored_documents"
  | "stored_indexed_bytes"
  | "monthly_indexed_bytes";

class BlockingUsageLimitPolicy implements UsageLimitPolicy {
  constructor(private readonly blockedResource: BlockedResource) {}

  async reserveAnswer(): Promise<UsageLimitReservation> {
    if (this.blockedResource === "monthly_answers") {
      throw usageLimitExceeded("monthly_answers");
    }
    return noopReservation;
  }

  async reserveDocument(): Promise<UsageLimitReservation> {
    if (this.blockedResource === "stored_documents") {
      throw usageLimitExceeded("stored_documents");
    }
    return noopReservation;
  }

  async reserveIndexedStorage(): Promise<UsageLimitReservation> {
    if (this.blockedResource === "stored_indexed_bytes") {
      throw usageLimitExceeded("stored_indexed_bytes");
    }
    return noopReservation;
  }

  async reserveMonthlyIndexedContent(): Promise<UsageLimitReservation> {
    if (this.blockedResource === "monthly_indexed_bytes") {
      throw usageLimitExceeded("monthly_indexed_bytes");
    }
    return noopReservation;
  }
}

const noopReservation: UsageLimitReservation = {
  async commit() {},
  async release() {},
};

const usageLimitExceeded = (resource: BlockedResource) => new AppError(429, "usage_limit_exceeded", "Usage limit exceeded", {
  profileKey: "starter_250",
  resource,
  limit:
    resource === "stored_indexed_bytes" || resource === "monthly_indexed_bytes"
      ? 1_000_000
      : 250,
  used:
    resource === "stored_indexed_bytes" || resource === "monthly_indexed_bytes"
      ? 1_000_000
      : 250,
  ...(resource === "monthly_answers"
    ? {
        periodStart: "2026-05-01",
        resetAt: "2026-06-01T00:00:00.000Z",
      }
    : {}),
});

describe("usage limit policy integration", () => {
  it("hard-blocks assistant chat and streaming chat when answer usage is exhausted", async () => {
    const { app } = createTestApp({
      usageLimitPolicy: new BlockingUsageLimitPolicy("monthly_answers"),
    });
    const { token } = await issueTestToken(app, "assistant-limit@example.com");
    const authorization = `Bearer ${token}`;

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ message: "What changed?", stream: false })
      .expect(429);

    expect(response.body.error).toEqual(expect.objectContaining({
      code: "usage_limit_exceeded",
      details: expect.objectContaining({
        profileKey: "starter_250",
        resource: "monthly_answers",
        limit: 250,
        used: 250,
      }),
    }));

    await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ message: "Stream it", stream: true })
      .expect(429);
  });

  it("hard-blocks retrieval answer calls when answer usage is exhausted", async () => {
    const { app } = createTestApp({
      usageLimitPolicy: new BlockingUsageLimitPolicy("monthly_answers"),
    });
    const { token } = await issueTestToken(app, "retrieval-limit@example.com");

    const response = await request(app)
      .post("/api/v1/retrieval/answer")
      .set("Authorization", `Bearer ${token}`)
      .send({ query: "What do the documents say?" })
      .expect(429);

    expect(response.body.error.details).toEqual(expect.objectContaining({
      resource: "monthly_answers",
    }));
  });

  it("hard-blocks inline document creation and file import when document usage is exhausted", async () => {
    const { app } = createTestApp({
      usageLimitPolicy: new BlockingUsageLimitPolicy("stored_documents"),
    });
    const { token } = await issueTestToken(app, "document-limit@example.com");
    const authorization = `Bearer ${token}`;

    const inlineResponse = await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "Blocked",
        content: "This should not be stored.",
      })
      .expect(429);

    expect(inlineResponse.body.error.details).toEqual(expect.objectContaining({
      resource: "stored_documents",
    }));

    await request(app)
      .post("/api/v1/document/import")
      .set("Authorization", authorization)
      .attach("file", Buffer.from("blocked import"), {
        filename: "blocked.txt",
        contentType: "text/plain",
      })
      .expect(429);

    const { app: sizeLimitedApp } = createTestApp({
      usageLimitPolicy: new BlockingUsageLimitPolicy("stored_documents"),
      envOverrides: {
        DOCUMENT_UPLOAD_MAX_BYTES: 1,
      },
    });
    const { token: sizeLimitedToken } = await issueTestToken(sizeLimitedApp, "document-limit-before-upload@example.com");

    await request(sizeLimitedApp)
      .post("/api/v1/document/import")
      .set("Authorization", `Bearer ${sizeLimitedToken}`)
      .attach("file", Buffer.from("blocked import"), {
        filename: "blocked.txt",
        contentType: "text/plain",
      })
      .expect(429);
  });

  it("hard-blocks inline document creation and file import when indexed storage bytes are exhausted", async () => {
    const { app } = createTestApp({
      usageLimitPolicy: new BlockingUsageLimitPolicy("stored_indexed_bytes"),
    });
    const { token } = await issueTestToken(app, "indexed-bytes-limit@example.com");
    const authorization = `Bearer ${token}`;

    const inlineResponse = await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "Blocked",
        content: "This should not be stored.",
      })
      .expect(429);

    expect(inlineResponse.body.error.details).toEqual(expect.objectContaining({
      resource: "stored_indexed_bytes",
    }));

    await request(app)
      .post("/api/v1/document/import")
      .set("Authorization", authorization)
      .attach("file", Buffer.from("blocked import"), {
        filename: "blocked.txt",
        contentType: "text/plain",
      })
      .expect(429);
  });
});
