import type { AgentRevisionSnapshot } from "./agentRevision.js";

export interface CandidateReleaseChange { readonly field: string; readonly id: string; readonly before: string | null; readonly after: string | null; readonly truncated: boolean; }

const text = (value: unknown): { value: string | null; truncated: boolean } => {
  if (value == null) return { value: null, truncated: false };
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return raw.length > 240 ? { value: `${raw.slice(0, 240)}…`, truncated: true } : { value: raw, truncated: false };
};
const safe = (value: unknown): unknown => value && typeof value === "object" && "config" in value
  ? (() => { const { config, ...metadata } = value as Record<string, unknown>; return { configRedacted: config !== undefined, ...metadata }; })()
  : value;

const changesFor = (field: "directives" | "routines" | "contextVariableEnablements" | "agentSkills", before: ReadonlyArray<{ id: string }>, after: ReadonlyArray<{ id: string }>): CandidateReleaseChange[] => {
  const ids = new Set([...before.map((item) => item.id), ...after.map((item) => item.id)]);
  return [...ids].flatMap((id) => {
    const left = before.find((item) => item.id === id) ?? null; const right = after.find((item) => item.id === id) ?? null;
    if (JSON.stringify(left) === JSON.stringify(right)) return [];
    const a = text(field === "agentSkills" ? safe(left) : left); const b = text(field === "agentSkills" ? safe(right) : right); return [{ field, id, before: a.value, after: b.value, truncated: a.truncated || b.truncated }];
  });
};

export const describeCandidateReleaseDiff = (base: AgentRevisionSnapshot | null, candidate: AgentRevisionSnapshot, page: { offset?: number; limit?: number } = {}): { changes: ReadonlyArray<CandidateReleaseChange>; truncated: boolean; nextOffset: number | null } => {
  const instructionBefore = text(base?.customInstruction ?? null); const instructionAfter = text(candidate.customInstruction ?? null);
  const instruction = (base?.customInstruction ?? null) === (candidate.customInstruction ?? null) ? [] : [{ field: "customInstruction", id: "agent", before: instructionBefore.value, after: instructionAfter.value, truncated: instructionBefore.truncated || instructionAfter.truncated }];
  const changes = [...instruction, ...changesFor("directives", base?.directives ?? [], candidate.directives), ...changesFor("routines", base?.routines ?? [], candidate.routines), ...changesFor("contextVariableEnablements", base?.contextVariableEnablements ?? [], candidate.contextVariableEnablements), ...changesFor("agentSkills", base?.agentSkills ?? [], candidate.agentSkills ?? [])];
  const offset = page.offset ?? 0; const limit = page.limit ?? 40; const visible = changes.slice(offset, offset + limit);
  return { changes: visible, truncated: changes.some((change) => change.truncated), nextOffset: offset + limit < changes.length ? offset + limit : null };
};
