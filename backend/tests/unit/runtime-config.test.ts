import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

describe("runtime configuration", () => {
  it("defines explicit API and worker backend scripts", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts["dev:http"]).toBeTruthy();
    expect(packageJson.scripts["dev:worker"]).toBeTruthy();
    expect(packageJson.scripts["dev:worker-server"]).toBeTruthy();
    expect(packageJson.scripts["start:http"]).toBeTruthy();
    expect(packageJson.scripts["start:worker"]).toBeTruthy();
    expect(packageJson.scripts["start:worker-server"]).toBeTruthy();
  });

  it("defines a dedicated backend-worker service in local and compose orchestration", async () => {
    const devCompose = YAML.parse(await readFile(new URL("../../../infra/docker-compose.dev.yml", import.meta.url), "utf8")) as {
      services?: Record<string, unknown>;
    };
    const prodCompose = YAML.parse(await readFile(new URL("../../../infra/docker-compose.yml", import.meta.url), "utf8")) as {
      services?: Record<string, unknown>;
    };

    expect(devCompose.services?.["backend-worker"]).toBeTruthy();
    expect(prodCompose.services?.["backend-worker"]).toBeTruthy();
    expect((devCompose.services?.["backend-worker"] as { depends_on?: Record<string, { condition?: string }> })?.depends_on?.backend?.condition).toBe("service_healthy");
    expect((prodCompose.services?.["backend-worker"] as { depends_on?: Record<string, { condition?: string }> })?.depends_on?.backend?.condition).toBe("service_healthy");
  });
});
