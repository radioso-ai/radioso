import { readFileSync } from "node:fs";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

describe("sdk openapi snapshot", () => {
  it("keeps the sdk json snapshot aligned with the backend json artifact", () => {
    const backendJson = JSON.parse(
      readFileSync(new URL("../../openapi.json", import.meta.url), "utf8"),
    );
    const sdkJson = JSON.parse(
      readFileSync(new URL("../../../typescript-sdk/openapi/radioso.json", import.meta.url), "utf8"),
    );

    expect(sdkJson).toEqual(backendJson);
  });

  it("keeps the sdk yaml snapshot aligned with the backend yaml artifact", () => {
    const backendYaml = parse(readFileSync(new URL("../../openapi.yaml", import.meta.url), "utf8"));
    const sdkYaml = parse(
      readFileSync(new URL("../../../typescript-sdk/openapi/radioso.yaml", import.meta.url), "utf8"),
    );

    expect(sdkYaml).toEqual(backendYaml);
  });
});
