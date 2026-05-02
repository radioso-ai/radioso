import { describe, expect, it, vi } from "vitest";

import { loadConfiguredApplicationModules } from "../../src/runtime/loadApplicationModules.js";

describe("application module loader", () => {
  it("loads application modules from configured module specifiers", async () => {
    const logger = { info: vi.fn() };
    const moduleSpecifier = new URL("../fixtures/application-module.fixture.mjs", import.meta.url).href;

    const modules = await loadConfiguredApplicationModules({
      RADIOSO_APPLICATION_MODULES: moduleSpecifier,
    }, logger);

    expect(modules.map((module) => module.id)).toEqual(["enterprise-module"]);
    expect(logger.info).toHaveBeenCalledWith(
      {
        moduleSpecifier,
        moduleIds: ["enterprise-module"],
      },
      "Loaded Radioso application module",
    );
  });
});
