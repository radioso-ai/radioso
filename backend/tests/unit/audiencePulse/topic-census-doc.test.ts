import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  AUDIENCE_PULSE_NARRATIVE_MAX_CONSECUTIVE_REUSES,
  AUDIENCE_PULSE_NARRATIVE_REUSE_MAX_DRIFT,
  AUDIENCE_PULSE_NARRATIVE_REUSE_MIN_ABSOLUTE_MOVEMENT,
  AUDIENCE_PULSE_NARRATIVE_REUSE_MIN_MEMBERSHIP_OVERLAP,
} from "../../../src/modules/audiencePulse/services/audiencePulseService.js";
import { AUDIENCE_PULSE_SUMMARY_MAX_TOPICS } from "../../../src/modules/audiencePulse/services/prompt.js";

const topicCensusDocUrl = new URL(
  "../../../../docs/architecture/topic-census.md",
  import.meta.url,
);

const documentedNumber = (markdown: string, pattern: RegExp): number => {
  const match = markdown.match(pattern);
  expect(match, `Missing documented numeric policy matching ${String(pattern)}`).not.toBeNull();
  return Number(match![1]);
};

describe("topic census architecture documentation", () => {
  it("keeps its numeric narrative-reuse policy equal to the implementation", async () => {
    const markdown = await readFile(topicCensusDocUrl, "utf8");

    expect(documentedNumber(markdown, /relative movement reaches\s+([\d.]+)\s+percent/i))
      .toBe(AUDIENCE_PULSE_NARRATIVE_REUSE_MAX_DRIFT * 100);
    expect(documentedNumber(markdown, /underlying count moves by at least\s+([\d.]+)\s+questions/i))
      .toBe(AUDIENCE_PULSE_NARRATIVE_REUSE_MIN_ABSOLUTE_MOVEMENT);
    expect(documentedNumber(markdown, /membership overlap[^.]*more than\s+([\d.]+)\s+percent/i))
      .toBe(AUDIENCE_PULSE_NARRATIVE_REUSE_MIN_MEMBERSHIP_OVERLAP * 100);
    expect(documentedNumber(markdown, /reused for at most\s+([\d.]+)\s+consecutive refreshes/i))
      .toBe(AUDIENCE_PULSE_NARRATIVE_MAX_CONSECUTIVE_REUSES);
    expect(documentedNumber(markdown, /ordered ids of the\s+([\d.]+)\s+richest topics/i))
      .toBe(AUDIENCE_PULSE_SUMMARY_MAX_TOPICS);
  });
});
