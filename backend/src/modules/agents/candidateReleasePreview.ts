import type { AgentRevisionSnapshot } from "./agentRevision.js";
import { revisionTakesPhotos } from "../visitorImages/contracts/revisionSwitch.js";
import { visitorImagesSwitchChanged } from "./agentRevisionVisitorImages.js";
import { canonicalGreeting, readAgentRevisionGreeting } from "./agentRevisionGreeting.js";
import { diffAgentRevisionSkills } from "./agentRevisionSkills.js";

/** One thing publishing changes, named and valued for a person: a missing side means it is added or removed. */
interface CandidatePreviewRow {
  readonly label: string;
  readonly before: unknown;
  readonly after: unknown;
}

const clip = (value: unknown): string => {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return raw.length > 240 ? `${raw.slice(0, 240)}…` : raw;
};
const onOff = (value: boolean) => (value ? "on" : "off");

/** Collection items by id; an item whose readable form is the same on both sides is not a change. */
const itemRows = <T extends { readonly id: string }>(
  kind: string,
  before: ReadonlyArray<T>,
  after: ReadonlyArray<T>,
  name: (item: T) => string,
  view: (item: T) => Record<string, unknown>,
): CandidatePreviewRow[] => [...new Set([...before.map((item) => item.id), ...after.map((item) => item.id)])].flatMap((id) => {
  const left = before.find((item) => item.id === id);
  const right = after.find((item) => item.id === id);
  if (JSON.stringify(left) === JSON.stringify(right)) return [];
  return [{ label: `${kind}: ${name((right ?? left)!)}`, before: left ? view(left) : null, after: right ? view(right) : null }];
});

const stringField = (item: object, key: string): string => {
  const value = (item as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : "Untitled";
};

/**
 * The changes publishing a candidate makes, labelled by what they are (a directive's or routine's
 * name, never its id) and valued with the content an operator reads, not the stored JSON.
 * Same comparison as the release review the digest binds; this is its readable face.
 */
export const describeCandidateReleasePreview = (
  base: AgentRevisionSnapshot | null,
  candidate: AgentRevisionSnapshot,
  limit: number,
): { readonly rows: ReadonlyArray<CandidatePreviewRow>; readonly hidden: number } => {
  const rows: CandidatePreviewRow[] = [];
  if ((base?.customInstruction ?? null) !== (candidate.customInstruction ?? null)) {
    rows.push({ label: "Custom instruction", before: base?.customInstruction ?? null, after: candidate.customInstruction ?? null });
  }
  if (canonicalGreeting(base ?? {}) !== canonicalGreeting(candidate)) {
    rows.push({
      label: "Greeting",
      before: base ? `Exact words ${onOff(readAgentRevisionGreeting(base).exactWordsEnabled)}` : null,
      after: `Exact words ${onOff(readAgentRevisionGreeting(candidate).exactWordsEnabled)}`,
    });
  }
  if (visitorImagesSwitchChanged(base, candidate)) {
    rows.push({ label: "Visitor photos", before: base ? onOff(revisionTakesPhotos(base)) : null, after: onOff(revisionTakesPhotos(candidate)) });
  }
  rows.push(
    ...itemRows("Directive", base?.directives ?? [], candidate.directives, (item) => stringField(item, "name"), (item) => ({
      when: item.condition.kind === "contextual" ? clip(item.condition.description) : "Always", then: clip(item.action), enabled: item.enabled,
    })),
    ...itemRows("Routine", base?.routines ?? [], candidate.routines, (item) => stringField(item, "name"), (item) => ({
      enabled: item.enabled, steps: item.steps.length,
    })),
    ...itemRows("Attribute enablement", base?.contextVariableEnablements ?? [], candidate.contextVariableEnablements, (item) => item.source, (item) => ({
      source: item.source, surfacing: item.surfacing, enabled: item.enabled,
    })),
    ...diffAgentRevisionSkills(base, candidate).map((change) => {
      const view = (skill: NonNullable<typeof change.before>) => ({ enabled: skill.enabled, kind: skill.kind, invocationMode: skill.invocationMode });
      return { label: `Skill: ${(change.after ?? change.before)!.skillName}`, before: change.before ? view(change.before) : null, after: change.after ? view(change.after) : null };
    }),
  );
  return { rows: rows.slice(0, limit), hidden: Math.max(0, rows.length - limit) };
};
