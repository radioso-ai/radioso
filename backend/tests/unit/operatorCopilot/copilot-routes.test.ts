import { describe, expect, it } from "vitest";

import { createCopilotRoutes } from "../../../src/modules/operatorCopilot/routes.js";

describe("createCopilotRoutes", () => {
  it("mounts the fixed copilot endpoint set", () => {
    const router = createCopilotRoutes({
      env: { SESSION_COOKIE_NAME: "session" },
      authService: {},
      workspaceSessionService: {},
      accountAccessService: {},
      llmCapabilityResolver: {},
      operatorCopilotService: {},
    } as never);

    const paths = router.stack
      .flatMap((layer: { route?: { path?: string } }) => layer.route?.path ? [layer.route.path] : []);
    expect(paths).toEqual(expect.arrayContaining(["/availability", "/conversations", "/turns"]));
  });
});
