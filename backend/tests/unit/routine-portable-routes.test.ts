import express from "express";
import { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { GRAMMAR_VERSION } from "@radioso/routine-markdown";

import { createAgentRoutes } from "../../src/app/http/routes/agentRoutes.js";
import { createRoutinePortableRoutes } from "../../src/app/http/routes/routinePortableRoutes.js";
import { createErrorHandler } from "../../src/app/http/middleware/errorHandler.js";
import type { AppDependencies } from "../../src/app/server/types.js";
import type { RoutineDefinition } from "../../src/modules/routines/public.js";
import { conflict } from "../../src/shared/domain/errors.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const routineId = "33333333-3333-4333-8333-333333333333";

const markdown = [
  "---",
  `grammar: ${GRAMMAR_VERSION}`,
  "name: support-intake",
  "trigger: When the user needs support",
  "priority: 3",
  "---",
  "# collect_topic",
  "Ask for @topic.",
].join("\n") + "\n";

const existingCompletionExport = {
  enabled: true as const,
  triggerKinds: ["complete" as const],
  destinationRef: "55555555-5555-4555-8555-555555555555",
};

const routine = (overrides: Partial<RoutineDefinition> = {}): RoutineDefinition => ({
  id: routineId,
  agentId,
  lineageId: "44444444-4444-4444-8444-444444444444",
  version: 1,
  status: "draft",
  name: "support-intake",
  activation: {
    triggerDescription: "When the user needs support",
    gateRef: "gate-preserved",
    priority: 3,
    reentryMode: "once_per_conversation",
  },
  slots: [{
    stableSlotId: "slot_topic",
    key: "topic",
    type: "text",
    required: true,
    description: "topic",
    ordinal: 0,
  }],
  steps: [{
    stableStepId: "collect_topic",
    kind: "chat",
    instruction: "Ask for {{slot.topic}}.",
    toolRef: null,
    actionType: null,
    ordinal: 0,
    metadata: { outlineLabel: "collect_topic" },
  }],
  transitions: [{
    fromStep: "collect_topic",
    toRef: "done",
    guardKind: "default",
    guardText: null,
    outcomeStatus: null,
    counterLimit: null,
    ordinal: 0,
  }],
  terminals: [{
    stableStepId: "done",
    kind: "complete",
    instruction: null,
    ordinal: 0,
  }],
  createdAt: new Date("2026-07-13T10:00:00.000Z"),
  updatedAt: new Date("2026-07-13T10:00:00.000Z"),
  ...overrides,
});

const createDependencies = (overrides: Partial<AppDependencies> = {}): AppDependencies => {
  const baseRoutine = routine();
  return {
    env: { SESSION_COOKIE_NAME: "radioso_session" },
    authService: {
      authenticateApiToken: vi.fn().mockResolvedValue({
        accountId: "account-1",
        workspaceId,
        principal: { type: "workspace_api_token", role: "admin", tokenId: "token-1" },
      }),
    },
    accountAccessService: {
      requirePermission: vi.fn().mockResolvedValue(undefined),
    },
    workspaceSessionService: {},
    routineDefinitionService: {
      get: vi.fn().mockResolvedValue(baseRoutine),
      validate: vi.fn().mockResolvedValue({ ok: true, diagnostics: [] }),
      createDraft: vi.fn().mockResolvedValue({ routine: { ...baseRoutine, activation: { ...baseRoutine.activation, gateRef: null } }, validation: { ok: true, diagnostics: [] } }),
      updateDraft: vi.fn().mockImplementation(async (_workspaceId, _agentId, _routineId, input) => ({
        routine: { ...baseRoutine, ...input },
        validation: { ok: true, diagnostics: [] },
      })),
    },
    logger: {
      warn: vi.fn(),
    },
    metricsRegistry: {
      incrementCounter: vi.fn(),
    },
    ...overrides,
  } as unknown as AppDependencies;
};

const createApp = (dependencies = createDependencies()) => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/agents", createAgentRoutes(dependencies));
  app.use("/api/v1", createRoutinePortableRoutes(dependencies));
  app.use(createErrorHandler());
  return app;
};

class MockRequest extends Readable {
  url: string;
  method: string;
  headers: Record<string, string>;

  constructor(input: { method: string; url: string; headers?: Record<string, string>; body?: unknown }) {
    super();
    this.method = input.method;
    this.url = input.url;
    const body = input.body === undefined ? "" : JSON.stringify(input.body);
    this.headers = {
      ...(body ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } : {}),
      ...(input.headers ?? {}),
    };
    this.push(body);
    this.push(null);
  }

  override _read(): void {}
}

class MockResponse extends Writable {
  statusCode = 200;
  locals: Record<string, unknown> = {};
  readJson!: () => unknown;
  setHeader!: (name: string, value: number | string | string[]) => this;
  getHeader!: (name: string) => number | string | string[] | undefined;
  removeHeader!: (name: string) => void;
  private readonly chunks: Buffer[] = [];
  private readonly headers = new Map<string, number | string | string[]>();

  constructor() {
    super();
    this.setHeader = ((name: string, value: number | string | string[]) => {
      this.headers.set(name.toLowerCase(), value);
      return this;
    }) as typeof this.setHeader;
    this.getHeader = ((name: string) => this.headers.get(name.toLowerCase())) as typeof this.getHeader;
    this.removeHeader = ((name: string) => {
      this.headers.delete(name.toLowerCase());
    }) as typeof this.removeHeader;
    this.write = ((chunk: Buffer | string) => {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    }) as typeof this.write;
    this.end = ((chunk?: Buffer | string, _encoding?: BufferEncoding | (() => void), callback?: () => void) => {
      if (chunk) {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      if (typeof _encoding === "function") {
        _encoding();
      }
      callback?.();
      this.emit("finish");
      return this;
    }) as typeof this.end;
    this.readJson = (() => {
      const text = Buffer.concat(this.chunks).toString("utf8");
      return text ? JSON.parse(text) : undefined;
    }) as typeof this.readJson;
  }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }

}

const dispatch = async (
  app: express.Express,
  input: { method: string; url: string; body?: unknown; token?: string },
): Promise<{ status: number; body: unknown }> => {
  const req = new MockRequest({
    method: input.method,
    url: input.url,
    headers: input.token ? { authorization: `Bearer ${input.token}` } : {},
    body: input.body,
  });
  const res = new MockResponse();
  (res as unknown as { req: MockRequest }).req = req;
  await new Promise<void>((resolve, reject) => {
    res.on("finish", resolve);
    (app as unknown as { handle: (req: never, res: never, done: (error?: unknown) => void) => void })
      .handle(req as never, res as never, (error?: unknown) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return { status: res.statusCode, body: res.readJson() };
};

describe("portable routine routes", () => {
  it("returns the canonical portable document for a routine", async () => {
    const dependencies = createDependencies({
      routineDefinitionService: {
        ...createDependencies().routineDefinitionService,
        get: vi.fn().mockResolvedValue(routine({
          activation: {
            triggerDescription: "When the user needs support",
            gateRef: null,
            priority: 3,
            reentryMode: "once_per_conversation",
          },
        })),
      } as unknown as AppDependencies["routineDefinitionService"],
    });

    const response = await dispatch(createApp(dependencies), {
      method: "GET",
      url: `/api/v1/agents/${agentId}/routines/${routineId}/portable`,
      token: "token",
    });

    expect(dependencies.routineDefinitionService.get).toHaveBeenCalledWith(workspaceId, agentId, routineId);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      grammarVersion: GRAMMAR_VERSION,
      content: markdown,
    });
  });

  it("returns 422 diagnostics when an existing routine cannot be represented as portable markdown", async () => {
    const dependencies = createDependencies({
      routineDefinitionService: {
        ...createDependencies().routineDefinitionService,
        get: vi.fn().mockResolvedValue(routine({
          activation: {
            triggerDescription: "When the user needs support",
            gateRef: null,
            priority: 3,
            reentryMode: "once_per_conversation",
          },
          terminals: [
            { stableStepId: "done", kind: "complete", instruction: null, ordinal: 0 },
            { stableStepId: "handoff_sales", kind: "handoff", instruction: null, ordinal: 1 },
            { stableStepId: "handoff_support", kind: "handoff", instruction: null, ordinal: 2 },
          ],
        })),
      } as unknown as AppDependencies["routineDefinitionService"],
    });

    const response = await dispatch(createApp(dependencies), {
      method: "GET",
      url: `/api/v1/agents/${agentId}/routines/${routineId}/portable`,
      token: "token",
    });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      diagnostics: [{
        line: 1,
        code: "routine_not_portable",
        message: "Routine portable markdown v1 can represent at most one handoff terminal.",
      }],
    });
  });

  it("returns 422 diagnostics when GET portable is requested for a gated routine", async () => {
    const dependencies = createDependencies();

    const response = await dispatch(createApp(dependencies), {
      method: "GET",
      url: `/api/v1/agents/${agentId}/routines/${routineId}/portable`,
      token: "token",
    });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      diagnostics: [{
        line: 1,
        code: "routine_not_portable",
        message: "Routine portable markdown v1 cannot represent activation gate gate-preserved.",
      }],
    });
  });

  it("creates a routine from portable markdown and returns canonical content", async () => {
    const dependencies = createDependencies();

    const response = await dispatch(createApp(dependencies), {
      method: "POST",
      url: `/api/v1/agents/${agentId}/routines/portable`,
      token: "token",
      body: { grammarVersion: GRAMMAR_VERSION, content: markdown },
    });

    expect(dependencies.routineDefinitionService.validate).toHaveBeenCalledWith(workspaceId, agentId, {
      input: expect.objectContaining({
        name: "support-intake",
        activation: expect.objectContaining({ gateRef: null, priority: 3 }),
      }),
    });
    expect(dependencies.routineDefinitionService.createDraft).toHaveBeenCalledWith(
      workspaceId,
      agentId,
      expect.objectContaining({
        activation: expect.objectContaining({ gateRef: null, priority: 3 }),
      }),
    );
    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      routineId,
      grammarVersion: GRAMMAR_VERSION,
      content: markdown,
    });
  });

  it("returns a clear 409 when portable create duplicates an existing routine name and version", async () => {
    const dependencies = createDependencies({
      routineDefinitionService: {
        ...createDependencies().routineDefinitionService,
        createDraft: vi.fn().mockRejectedValue(
          conflict("A routine definition with this name and version already exists for this agent"),
        ),
      } as unknown as AppDependencies["routineDefinitionService"],
    });

    const response = await dispatch(createApp(dependencies), {
      method: "POST",
      url: `/api/v1/agents/${agentId}/routines/portable`,
      token: "token",
      body: { grammarVersion: GRAMMAR_VERSION, content: markdown },
    });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: {
        code: "conflict",
        message: "A routine definition with this name and version already exists for this agent",
      },
    });
  });

  it("updates a routine through the structured update path while preserving gateRef", async () => {
    const dependencies = createDependencies();

    const response = await dispatch(createApp(dependencies), {
      method: "PUT",
      url: `/api/v1/agents/${agentId}/routines/${routineId}/portable`,
      token: "token",
      body: { grammarVersion: GRAMMAR_VERSION, content: markdown },
    });

    expect(dependencies.routineDefinitionService.get).toHaveBeenCalledWith(workspaceId, agentId, routineId);
    expect(dependencies.routineDefinitionService.updateDraft).toHaveBeenCalledWith(
      workspaceId,
      agentId,
      routineId,
      expect.objectContaining({
        activation: expect.objectContaining({ gateRef: "gate-preserved" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ grammarVersion: GRAMMAR_VERSION, content: markdown });
  });

  it("preserves existing terminal config on portable update when terminal frontmatter is omitted", async () => {
    const existing = routine({
      activation: {
        triggerDescription: "When the user needs support",
        gateRef: "gate-preserved",
        priority: 3,
        reentryMode: "once_per_conversation",
      },
      transitions: [{
        fromStep: "collect_topic",
        toRef: "complete_support",
        guardKind: "default",
        guardText: null,
        outcomeStatus: null,
        counterLimit: null,
        ordinal: 0,
      }],
      terminals: [{
        stableStepId: "complete_support",
        kind: "complete",
        instruction: "Close with the support summary.",
        ordinal: 0,
      }],
    });
    const dependencies = createDependencies({
      routineDefinitionService: {
        ...createDependencies().routineDefinitionService,
        get: vi.fn().mockResolvedValue(existing),
        updateDraft: vi.fn().mockImplementation(async (_workspaceId, _agentId, _routineId, input) => ({
          routine: { ...existing, ...input, activation: { ...input.activation, gateRef: null } },
          validation: { ok: true, diagnostics: [] },
        })),
      } as unknown as AppDependencies["routineDefinitionService"],
    });

    const response = await dispatch(createApp(dependencies), {
      method: "PUT",
      url: `/api/v1/agents/${agentId}/routines/${routineId}/portable`,
      token: "token",
      body: { grammarVersion: GRAMMAR_VERSION, content: markdown },
    });

    expect(dependencies.routineDefinitionService.updateDraft).toHaveBeenCalledWith(
      workspaceId,
      agentId,
      routineId,
      expect.objectContaining({
        transitions: [expect.objectContaining({ toRef: "complete_support", guardKind: "default" })],
        terminals: [expect.objectContaining({
          stableStepId: "complete_support",
          kind: "complete",
          instruction: "Close with the support summary.",
        })],
      }),
    );
    expect(response.status).toBe(200);
  });

  it("returns 422 diagnostics when a portable update result cannot be projected back to markdown", async () => {
    const dependencies = createDependencies({
      routineDefinitionService: {
        ...createDependencies().routineDefinitionService,
        updateDraft: vi.fn().mockResolvedValue({
          routine: routine({
            terminals: [
              { stableStepId: "done", kind: "complete", instruction: null, ordinal: 0 },
              { stableStepId: "handoff_sales", kind: "handoff", instruction: null, ordinal: 1 },
              { stableStepId: "handoff_support", kind: "handoff", instruction: null, ordinal: 2 },
            ],
          }),
          validation: { ok: true, diagnostics: [] },
        }),
      } as unknown as AppDependencies["routineDefinitionService"],
    });

    const response = await dispatch(createApp(dependencies), {
      method: "PUT",
      url: `/api/v1/agents/${agentId}/routines/${routineId}/portable`,
      token: "token",
      body: { grammarVersion: GRAMMAR_VERSION, content: markdown },
    });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      diagnostics: [{
        line: 1,
        code: "routine_not_portable",
        message: "Routine portable markdown v1 can represent at most one handoff terminal.",
      }],
    });
  });

  it("preserves existing completionExport on portable update when export frontmatter is omitted", async () => {
    const dependencies = createDependencies({
      routineDefinitionService: {
        ...createDependencies().routineDefinitionService,
        get: vi.fn().mockResolvedValue(routine({ completionExport: existingCompletionExport })),
        updateDraft: vi.fn().mockResolvedValue({
          routine: routine({ completionExport: existingCompletionExport }),
          validation: { ok: true, diagnostics: [] },
        }),
      } as unknown as AppDependencies["routineDefinitionService"],
    });

    const response = await dispatch(createApp(dependencies), {
      method: "PUT",
      url: `/api/v1/agents/${agentId}/routines/${routineId}/portable`,
      token: "token",
      body: { grammarVersion: GRAMMAR_VERSION, content: markdown },
    });

    expect(dependencies.routineDefinitionService.updateDraft).toHaveBeenCalledWith(
      workspaceId,
      agentId,
      routineId,
      expect.objectContaining({
        completionExport: existingCompletionExport,
      }),
    );
    expect(response.status).toBe(200);
  });

  it("overrides completionExport on portable update when export frontmatter is present", async () => {
    const dependencies = createDependencies({
      routineDefinitionService: {
        ...createDependencies().routineDefinitionService,
        get: vi.fn().mockResolvedValue(routine({ completionExport: existingCompletionExport })),
        updateDraft: vi.fn().mockImplementation(async (_workspaceId, _agentId, _routineId, input) => ({
          routine: routine(input),
          validation: { ok: true, diagnostics: [] },
        })),
      } as unknown as AppDependencies["routineDefinitionService"],
    });
    const content = [
      "---",
      `grammar: ${GRAMMAR_VERSION}`,
      "name: support-intake",
      "trigger: When the user needs support",
      "priority: 3",
      "export: complete,handoff -> 66666666-6666-4666-8666-666666666666",
      "---",
      "# collect_topic",
      "Ask for @topic.",
    ].join("\n");

    const response = await dispatch(createApp(dependencies), {
      method: "PUT",
      url: `/api/v1/agents/${agentId}/routines/${routineId}/portable`,
      token: "token",
      body: { grammarVersion: GRAMMAR_VERSION, content },
    });

    expect(dependencies.routineDefinitionService.updateDraft).toHaveBeenCalledWith(
      workspaceId,
      agentId,
      routineId,
      expect.objectContaining({
        completionExport: {
          enabled: true,
          triggerKinds: ["complete", "handoff"],
          destinationRef: "66666666-6666-4666-8666-666666666666",
        },
      }),
    );
    expect(response.status).toBe(200);
  });

  it("canonicalizes markdown without touching routine persistence", async () => {
    const dependencies = createDependencies();

    const response = await dispatch(createApp(dependencies), {
      method: "POST",
      url: "/api/v1/routines/portable/canonicalize",
      token: "token",
      body: {
        grammarVersion: GRAMMAR_VERSION,
        content: "---\nname: Greeter\ntrigger: hi\n---\nAsk @email.",
      },
    });

    expect(dependencies.routineDefinitionService.get).not.toHaveBeenCalled();
    expect(dependencies.routineDefinitionService.createDraft).not.toHaveBeenCalled();
    expect(dependencies.routineDefinitionService.updateDraft).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      grammarVersion: GRAMMAR_VERSION,
      content: "---\ngrammar: 1\nname: Greeter\ntrigger: hi\n---\nAsk @email.\n",
    });
  });

  it("returns grammar diagnostics as a bare 400 diagnostics envelope and records safe observability", async () => {
    const dependencies = createDependencies();
    const content = "---\ngrammar: 1\nname: bad\ntrigger: bad\nreentry: later\n---\nAsk @topic.";

    const response = await dispatch(createApp(dependencies), {
      method: "POST",
      url: `/api/v1/agents/${agentId}/routines/portable`,
      token: "token",
      body: { grammarVersion: GRAMMAR_VERSION, content },
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      diagnostics: [{
        line: 5,
        code: "invalid_reentry",
        message: "Unsupported routine reentry mode: later",
      }],
    });
    expect(dependencies.routineDefinitionService.createDraft).not.toHaveBeenCalled();
    expect(dependencies.logger.warn).toHaveBeenCalledWith({
      operation: "create",
      diagnosticCodes: ["invalid_reentry"],
    }, "routine_portable_document_failed");
    expect(dependencies.metricsRegistry?.incrementCounter).toHaveBeenCalledWith("routine_portable_failures_total", {
      help: "Portable routine authoring failures by operation and diagnostic code.",
      labels: { operation: "create", code: "invalid_reentry" },
    });
    expect(JSON.stringify(vi.mocked(dependencies.logger.warn).mock.calls)).not.toContain(content);
  });

  it("returns semantic validator failures as the existing 422 validator response without persisting", async () => {
    const dependencies = createDependencies({
      routineDefinitionService: {
        ...createDependencies().routineDefinitionService,
        validate: vi.fn().mockResolvedValue({
          ok: false,
          diagnostics: [{
            code: "missing_terminal",
            location: "routine:support-intake",
            message: "missing terminal",
          }],
        }),
        createDraft: vi.fn(),
      } as unknown as AppDependencies["routineDefinitionService"],
    });

    const response = await dispatch(createApp(dependencies), {
      method: "POST",
      url: `/api/v1/agents/${agentId}/routines/portable`,
      token: "token",
      body: { grammarVersion: GRAMMAR_VERSION, content: markdown },
    });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      error: "Routine definition is invalid",
      validation: {
        ok: false,
        diagnostics: [{
          code: "missing_terminal",
          location: "routine:support-intake",
          message: "missing terminal",
        }],
      },
    });
    expect(dependencies.routineDefinitionService.createDraft).not.toHaveBeenCalled();
  });

  it("uses the same workspace manage permission as structured routine writes", async () => {
    const dependencies = createDependencies();

    const response = await dispatch(createApp(dependencies), {
      method: "POST",
      url: `/api/v1/agents/${agentId}/routines/portable`,
      token: "token",
      body: { grammarVersion: GRAMMAR_VERSION, content: markdown },
    });

    expect(response.status).toBe(201);
    expect(dependencies.accountAccessService.requirePermission).toHaveBeenCalledWith(expect.objectContaining({
      permission: "workspace.agents.manage",
      workspaceId,
    }));
  });
});
