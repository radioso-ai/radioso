import type { AgentRevisionSnapshot } from "./agentRevision.js";
import { revisionTakesPhotos } from "../visitorImages/contracts/revisionSwitch.js";
import { visitorImagesSwitchChanged } from "./agentRevisionVisitorImages.js";
import { canonicalGreeting, readAgentRevisionGreeting } from "./agentRevisionGreeting.js";
import { diffAgentRevisionSkills, redactedRevisionSkill } from "./agentRevisionSkills.js";

export interface CandidateReleaseChange { readonly field: string; readonly id: string; readonly before: string | null; readonly after: string | null; readonly truncated: boolean; }

const text = (value: unknown): { value: string | null; truncated: boolean } => {
  if (value == null) return { value: null, truncated: false };
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return raw.length > 240 ? { value: `${raw.slice(0, 240)}…`, truncated: true } : { value: raw, truncated: false };
};
const changesFor = (field: "directives" | "routines" | "contextVariableEnablements", before: ReadonlyArray<{ id: string }>, after: ReadonlyArray<{ id: string }>): CandidateReleaseChange[] => {
  const ids = new Set([...before.map((item) => item.id), ...after.map((item) => item.id)]);
  return [...ids].flatMap((id) => {
    const left = before.find((item) => item.id === id) ?? null; const right = after.find((item) => item.id === id) ?? null;
    if (JSON.stringify(left) === JSON.stringify(right)) return [];
    const a = text(left); const b = text(right); return [{ field, id, before: a.value, after: b.value, truncated: a.truncated || b.truncated }];
  });
};

/** Skill changes by skill id, read from the same comparison as the draft-dirty check (`diffAgentRevisionSkills`). */
const skillChanges = (base: AgentRevisionSnapshot | null, candidate: AgentRevisionSnapshot): CandidateReleaseChange[] =>
  diffAgentRevisionSkills(base, candidate).map((change) => {
    const before = text(change.before ? redactedRevisionSkill(change.before) : null); const after = text(change.after ? redactedRevisionSkill(change.after) : null);
    return { field: "agentSkills", id: change.skillId, before: before.value, after: after.value, truncated: before.truncated || after.truncated };
  });

const greetingChange = (base: AgentRevisionSnapshot | null, candidate: AgentRevisionSnapshot): CandidateReleaseChange[] => {
  const unchanged = canonicalGreeting(base ?? {}) === canonicalGreeting(candidate);
  if (unchanged) return [];
  const before = text(base ? readAgentRevisionGreeting(base) : null);
  const after = text(readAgentRevisionGreeting(candidate));
  return [{ field: "greeting", id: "agent", before: before.value, after: after.value, truncated: before.truncated || after.truncated }];
};

/** The photo switch, when publishing the candidate changes it (see `visitorImagesSwitchChanged`). */
const visitorImagesChange = (base: AgentRevisionSnapshot | null, candidate: AgentRevisionSnapshot): CandidateReleaseChange[] => {
  if (!visitorImagesSwitchChanged(base, candidate)) return [];
  return [{ field: "visitorImagesEnabled", id: "agent", before: base ? String(revisionTakesPhotos(base)) : null, after: String(revisionTakesPhotos(candidate)), truncated: false }];
};

export const describeCandidateReleaseDiff = (base: AgentRevisionSnapshot | null, candidate: AgentRevisionSnapshot, page: { offset?: number; limit?: number } = {}): { changes: ReadonlyArray<CandidateReleaseChange>; truncated: boolean; nextOffset: number | null } => {
  const instructionBefore = text(base?.customInstruction ?? null); const instructionAfter = text(candidate.customInstruction ?? null);
  const instruction = (base?.customInstruction ?? null) === (candidate.customInstruction ?? null) ? [] : [{ field: "customInstruction", id: "agent", before: instructionBefore.value, after: instructionAfter.value, truncated: instructionBefore.truncated || instructionAfter.truncated }];
  const changes = [...instruction, ...greetingChange(base, candidate), ...visitorImagesChange(base, candidate), ...changesFor("directives", base?.directives ?? [], candidate.directives), ...changesFor("routines", base?.routines ?? [], candidate.routines), ...changesFor("contextVariableEnablements", base?.contextVariableEnablements ?? [], candidate.contextVariableEnablements), ...skillChanges(base, candidate)];
  const offset = page.offset ?? 0; const limit = page.limit ?? 40; const visible = changes.slice(offset, offset + limit);
  return { changes: visible, truncated: changes.some((change) => change.truncated), nextOffset: offset + limit < changes.length ? offset + limit : null };
};
