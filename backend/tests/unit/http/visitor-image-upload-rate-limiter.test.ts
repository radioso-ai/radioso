import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

import {
  apiVisitorImageUploadRateLimiter,
  publicVisitorImageUploadRateLimiter,
} from "../../../src/app/http/middleware/visitorImageUploadRateLimiter.js";
import { countingRateLimitRefusals } from "../../../src/app/http/shared/visitorImageUpload.js";
import { AbuseControlService } from "../../../src/modules/security/services/abuseControlService.js";
import { InMemoryAbuseControlRepository } from "../../support/fakes.js";

type Middleware = (req: Request, res: Response, next: NextFunction) => unknown;

const respond = async (middlewares: readonly Middleware[], locals: Record<string, unknown>): Promise<unknown> => {
  const req = { socket: {} } as Request;
  const res = { locals, setHeader: () => undefined } as unknown as Response;
  let error: unknown;
  for (const middleware of middlewares) {
    let advanced = false;
    await middleware(req, res, (nextError?: unknown) => {
      advanced = true;
      error = nextError;
    });
    if (!advanced || error) break;
  }
  return error;
};

const auditService = { record: vi.fn().mockResolvedValue(undefined) };

describe("visitor image upload rate limits", () => {
  it("spends a public upload's session, source and workspace budgets together, and counts a refusal", async () => {
    const repository = new InMemoryAbuseControlRepository();
    const metrics = { incrementCounter: vi.fn() };
    const limiter = countingRateLimitRefusals(
      publicVisitorImageUploadRateLimiter({ abuseControlService: new AbuseControlService(repository), auditService }),
      metrics,
    );
    const upload = () => respond(limiter, {
      workspaceId: "workspace-1",
      chatSessionId: "session-1",
      requestSource: { address: "203.0.113.7", digest: "source-1" },
    });

    for (let attempt = 0; attempt < 20; attempt += 1) expect(await upload()).toBeUndefined();
    expect(await upload()).toMatchObject({ statusCode: 429 });

    expect(await repository.find("public.visitor_image.upload", "workspace-1:session:session-1:source:source-1")).toMatchObject({ attemptCount: 20 });
    expect(await repository.find("public.visitor_image.upload.source", "workspace-1:source:source-1")).toMatchObject({ attemptCount: 20 });
    expect(await repository.find("public.visitor_image.upload.workspace", "workspace-1:global")).toMatchObject({ attemptCount: 20 });
    expect(metrics.incrementCounter).toHaveBeenCalledWith("visitor_image_uploads_total", expect.objectContaining({ labels: { outcome: "rate_limited" } }));
  });

  it("refuses a public upload with no session rather than letting it through unlimited", async () => {
    const limiter = publicVisitorImageUploadRateLimiter({ abuseControlService: new AbuseControlService(new InMemoryAbuseControlRepository()), auditService });

    expect(await respond(limiter, { workspaceId: "workspace-1" })).toMatchObject({ statusCode: 404 });
  });

  it("counts an API upload against its credential and its workspace", async () => {
    const repository = new InMemoryAbuseControlRepository();
    const limiter = apiVisitorImageUploadRateLimiter({ abuseControlService: new AbuseControlService(repository), auditService });

    expect(await respond([limiter], {
      workspaceId: "workspace-1",
      accountId: "account-1",
      authPrincipal: { type: "personal_api_credential", userId: "user-1", credentialId: "credential-1", role: "admin", workspaceId: "workspace-1" },
    })).toBeUndefined();

    expect(await repository.find("api.visitor_image.upload", "workspace-1:credential:credential-1")).toMatchObject({ attemptCount: 1 });
    expect(await repository.find("api.visitor_image.upload.workspace", "workspace-1:global")).toMatchObject({ attemptCount: 1 });
  });
});
