import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { copilotCapabilityProvenance } from "../../../src/modules/operatorCopilot/capabilityProvenance.js";
import { operatorMcpDispositions } from "../../../src/modules/operatorCopilot/operatorMcpDisposition.js";

/**
 * Pins `docs/operator-mcp.md`'s "Tool boundary" section to the disposition map so the doc can
 * never describe an eligible tool without naming it, or advertise a tool the disposition map has
 * actually excluded. `operator-mcp-disposition.test.ts` already pins the disposition map itself
 * (the bijection with the descriptor registry, the admitted eligible set, the reason requirement);
 * this test is the doc's own drift gate against that already-pinned map.
 */

const knownDescriptorNames = new Set(Object.keys(copilotCapabilityProvenance));
const eligibleToolNames = Object.entries(operatorMcpDispositions)
  .filter(([, disposition]) => disposition.status === "eligible")
  .map(([name]) => name);

const backtickTokens = (text: string): ReadonlyArray<string> =>
  [...text.matchAll(/`([a-zA-Z0-9_:.-]+)`/g)].map((match) => match[1]);

const toolBoundarySection = (doc: string): string => {
  const start = doc.indexOf("## Tool boundary");
  if (start === -1) throw new Error('docs/operator-mcp.md has no "## Tool boundary" section to pin.');
  const rest = doc.slice(start + "## Tool boundary".length);
  const nextHeading = rest.indexOf("\n## ");
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
};

describe("operator MCP doc pinned to the disposition map", () => {
  it("names every eligible tool somewhere in docs/operator-mcp.md", async () => {
    const doc = await readFile(new URL("../../../../docs/operator-mcp.md", import.meta.url), "utf8");
    const documented = new Set(backtickTokens(doc));

    const undocumented = eligibleToolNames.filter((name) => !documented.has(name));
    expect(undocumented).toEqual([]);
  });

  it("never names an excluded tool in the Tool boundary section", async () => {
    const doc = await readFile(new URL("../../../../docs/operator-mcp.md", import.meta.url), "utf8");
    const section = toolBoundarySection(doc);
    const mentionedDescriptorNames = backtickTokens(section).filter((token) => knownDescriptorNames.has(token));

    const advertisedButExcluded = mentionedDescriptorNames.filter((name) => operatorMcpDispositions[name]?.status !== "eligible");
    expect(advertisedButExcluded).toEqual([]);
  });
});
