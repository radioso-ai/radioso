import { describe, expect, it, vi } from "vitest";

import { defaultAssistantBootstrapSettings, validateAssistantBootstrapSettings } from "../../src/modules/settings/domain/assistantBootstrapSettings.js";
import { defaultIngestionSettings } from "../../src/modules/settings/domain/ingestionSettings.js";
import { defaultRetrievalSettings } from "../../src/modules/settings/domain/retrievalSettings.js";
import { IngestionSettingsService } from "../../src/modules/settings/services/ingestionSettingsService.js";
import { RetrievalSettingsService } from "../../src/modules/settings/services/retrievalSettingsService.js";

describe("settings services", () => {
  it("returns saved retrieval settings even when success audit logging fails", async () => {
    const settings = defaultRetrievalSettings("workspace-1");
    const repository = {
      findByWorkspaceId: vi.fn(),
      upsert: vi.fn().mockResolvedValue(settings),
    };
    const auditService = {
      record: vi.fn().mockRejectedValue(new Error("audit down")),
    };
    const analyticsService = {
      track: vi.fn().mockResolvedValue(undefined),
    };
    const service = new RetrievalSettingsService(repository, auditService as never, undefined, analyticsService as never);

    await expect(service.updateForWorkspace("workspace-1", settings)).resolves.toEqual(settings);
    expect(repository.upsert).toHaveBeenCalledOnce();
    expect(auditService.record).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
        eventType: "settings.update",
        eventStatus: "success",
      });
    expect(analyticsService.track).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "retrieval_settings.updated",
        workspaceId: "workspace-1",
      }),
    );
  });

  it("rethrows the original retrieval save error when failure audit logging also fails", async () => {
    const writeError = new Error("write failed");
    const repository = {
      findByWorkspaceId: vi.fn(),
      upsert: vi.fn().mockRejectedValue(writeError),
    };
    const auditService = {
      record: vi.fn().mockRejectedValue(new Error("audit down")),
    };
    const analyticsService = {
      track: vi.fn(),
    };
    const service = new RetrievalSettingsService(repository, auditService as never, undefined, analyticsService as never);

    await expect(service.updateForWorkspace("workspace-1", defaultRetrievalSettings("workspace-1"))).rejects.toBe(
      writeError,
    );
    expect(auditService.record).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
        eventType: "settings.update",
        eventStatus: "failure",
      });
    expect(analyticsService.track).not.toHaveBeenCalled();
  });

  it("returns saved ingestion settings even when success audit logging fails", async () => {
    const settings = defaultIngestionSettings("workspace-1");
    const repository = {
      findByWorkspaceId: vi.fn(),
      upsert: vi.fn().mockResolvedValue(settings),
    };
    const auditService = {
      record: vi.fn().mockRejectedValue(new Error("audit down")),
    };
    const service = new IngestionSettingsService(repository, auditService as never);

    await expect(service.updateForWorkspace("workspace-1", settings)).resolves.toEqual(settings);
    expect(auditService.record).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      eventType: "ingestion_settings.update",
      eventStatus: "success",
    });
  });

  it("rethrows the original ingestion save error when failure audit logging also fails", async () => {
    const writeError = new Error("write failed");
    const repository = {
      findByWorkspaceId: vi.fn(),
      upsert: vi.fn().mockRejectedValue(writeError),
    };
    const auditService = {
      record: vi.fn().mockRejectedValue(new Error("audit down")),
    };
    const service = new IngestionSettingsService(repository, auditService as never);

    await expect(service.updateForWorkspace("workspace-1", defaultIngestionSettings("workspace-1"))).rejects.toBe(
      writeError,
    );
    expect(auditService.record).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      eventType: "ingestion_settings.update",
      eventStatus: "failure",
    });
  });

  it("normalizes assistant bootstrap settings and treats blank locale as null", () => {
    expect(
      validateAssistantBootstrapSettings({
        assistantName: "  Marta  ",
        assistantRole: " Museum guide ",
        greetingInstruction: " Warm and concise ",
        assistantDefaultLocale: " ",
        proactiveGreetingEnabled: true,
      }),
    ).toEqual({
      assistantName: "Marta",
      assistantRole: "Museum guide",
      greetingInstruction: "Warm and concise",
      assistantDefaultLocale: null,
      proactiveGreetingEnabled: true,
    });
  });

  it("exposes blank assistant bootstrap defaults", () => {
    expect(defaultAssistantBootstrapSettings()).toEqual({
      assistantName: "",
      assistantRole: "",
      greetingInstruction: "",
      assistantDefaultLocale: null,
      proactiveGreetingEnabled: false,
    });
  });
});
