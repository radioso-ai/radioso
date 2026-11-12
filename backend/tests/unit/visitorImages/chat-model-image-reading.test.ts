import { describe, expect, it, vi } from "vitest";

import { createChatModelImageReading, createVisitorImageAvailability } from "../../../src/app/composition/visitorImages.js";
import type { LlmCapabilitySelection } from "../../../src/shared/infra/llm/providerTypes.js";

const WORKSPACE_ID = "8d2b8f0e-6a1e-4c1a-9a43-0c1b2b5f9a01";
const AGENT_ID = "1f0e0c7c-2b8e-4a55-8e3b-7d8f7f0c8a11";

const selecting = (selection: LlmCapabilitySelection | Error) => {
  const resolveSelection = vi.fn(async () => {
    if (selection instanceof Error) throw selection;
    return selection;
  });
  const warn = vi.fn();
  return { resolveSelection, warn, reading: createChatModelImageReading({ resolver: { resolveSelection }, logger: { warn } }) };
};

const agent = { id: AGENT_ID, workspaceId: WORKSPACE_ID, chatModelOverride: null };

describe("whether an agent's chat model reads images", () => {
  it("reads with a model in the catalogue", async () => {
    const { reading } = selecting({ provider: "claude", model: "claude-sonnet-4-5", resolvedBy: "workspace_preference" });

    expect(await reading.readsImages(agent)).toBe(true);
  });

  it("cannot tell for an openai-compatible endpoint, which serves whatever model it names", async () => {
    const { reading } = selecting({ provider: "openai-compatible", model: "llava", resolvedBy: "agent_override" });

    expect(await reading.readsImages(agent)).toBe(false);
  });

  it("does not trust a model outside the catalogue", async () => {
    const { reading } = selecting({ provider: "openai", model: "a-fine-tune", resolvedBy: "workspace_preference" });

    expect(await reading.readsImages(agent)).toBe(false);
  });

  it("asks the resolver for the chat capability as the agent's turns do: its override, in its workspace", async () => {
    const { reading, resolveSelection } = selecting({ provider: "openai", model: "gpt-5.4-mini", resolvedBy: "agent_override" });
    const override = { provider: "openai" as const, model: "gpt-5.4-mini" };

    await reading.readsImages({ ...agent, chatModelOverride: override });

    expect(resolveSelection).toHaveBeenCalledWith("chat", { workspaceId: WORKSPACE_ID, capabilityOverride: override });
  });

  it("reads as a model that cannot read when the selection cannot be decided, and logs ids and the error class only", async () => {
    const { reading, warn } = selecting(new TypeError("settings unavailable"));

    expect(await reading.readsImages(agent)).toBe(false);

    expect(warn).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, agentId: AGENT_ID, errorClass: "TypeError" }, "visitor_image_model_unresolved");
  });
});

describe("whether an agent takes photos", () => {
  const availability = (stored: { visitorImagesEnabled: boolean } | null, readsImages: boolean) => {
    const modelReading = { readsImages: vi.fn(async () => readsImages) };
    return {
      modelReading,
      forAgent: () => createVisitorImageAvailability({
        agents: { findByIdAndWorkspaceId: async () => (stored ? { id: AGENT_ID, workspaceId: WORKSPACE_ID, chatModelOverride: null, ...stored } as never : null) },
        modelReading,
      }).forAgent({ workspaceId: WORKSPACE_ID, agentId: AGENT_ID }),
    };
  };

  it("takes them when the operator turned them on and the model reads images", async () => {
    expect(await availability({ visitorImagesEnabled: true }, true).forAgent()).toBe("available");
  });

  it("says the model cannot read when it is on and the model does not read images", async () => {
    expect(await availability({ visitorImagesEnabled: true }, false).forAgent()).toBe("model_cannot_read");
  });

  it("is off whatever the model, without resolving it", async () => {
    const off = availability({ visitorImagesEnabled: false }, true);

    expect(await off.forAgent()).toBe("disabled");
    expect(off.modelReading.readsImages).not.toHaveBeenCalled();
  });

  it("does not know an agent that is not there", async () => {
    expect(await availability(null, true).forAgent()).toBe("agent_not_found");
  });
});
