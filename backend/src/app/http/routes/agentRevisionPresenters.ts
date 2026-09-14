import type { AgentRevision, AgentRevisionSnapshot, AgentRevisionState } from "../../../modules/agents/public.js";

type RevisionSummary = { id: string; label: string; kind: "candidate" | "published"; versionNumber: number | null; createdAt: string; publishedAt?: string };
type RevisionSummaryInput = Pick<AgentRevision, "id" | "createdAt" | "publishedAt" | "publishedVersion">;
type ScopedChange = "added" | "removed" | "changed";
type DirectiveChange = { id: string; change: ScopedChange; before?: AgentRevisionSnapshot["directives"][number]; after?: AgentRevisionSnapshot["directives"][number] };
type RoutineChange = { definitionId: string; change: ScopedChange; before?: AgentRevisionSnapshot["routines"][number]; after?: AgentRevisionSnapshot["routines"][number] };
type ContextVariableEnablementChange = { contextVariableId: string; change: ScopedChange; before?: AgentRevisionSnapshot["contextVariableEnablements"][number]; after?: AgentRevisionSnapshot["contextVariableEnablements"][number] };

const revisionKind = (revision: RevisionSummaryInput): "candidate" | "published" => revision.publishedAt ? "published" : "candidate";

/** Presents an immutable revision consistently wherever an operator sees it. */
export const presentRevisionSummary = (revision: RevisionSummaryInput): RevisionSummary => {
  const kind = revisionKind(revision);
  const versionNumber = revision.publishedVersion ?? null;
  return {
    id: revision.id,
    label: kind === "published" && versionNumber !== null ? `v${versionNumber}` : `Draft · ${revision.createdAt.toISOString()}`,
    kind,
    versionNumber,
    createdAt: revision.createdAt.toISOString(),
    ...(revision.publishedAt ? { publishedAt: revision.publishedAt.toISOString() } : {}),
  };
};

const stableJson = (value: unknown): string => {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, entryValue]) => entryValue !== undefined).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
};

const changed = <T extends { createdAt: Date; updatedAt: Date }>(before: T, after: T): boolean => {
  const omitTimestamps = (value: T): Omit<T, "createdAt" | "updatedAt"> => { const { createdAt: _createdAt, updatedAt: _updatedAt, ...comparable } = value; return comparable; };
  return stableJson(omitTimestamps(before)) !== stableJson(omitTimestamps(after));
};

const diffDirectives = (before: AgentRevisionSnapshot["directives"], after: AgentRevisionSnapshot["directives"]): DirectiveChange[] => {
  const beforeById = new Map(before.map((directive) => [directive.id, directive])); const afterById = new Map(after.map((directive) => [directive.id, directive])); const changes: DirectiveChange[] = [];
  for (const id of [...new Set([...beforeById.keys(), ...afterById.keys()])].sort()) { const previous = beforeById.get(id); const next = afterById.get(id); if (!previous && next) changes.push({ id, change: "added", after: next }); else if (previous && !next) changes.push({ id, change: "removed", before: previous }); if (previous && next && changed(previous, next)) changes.push({ id, change: "changed", before: previous, after: next }); }
  return changes;
};

const diffRoutines = (before: AgentRevisionSnapshot["routines"], after: AgentRevisionSnapshot["routines"]): RoutineChange[] => {
  const beforeByLineage = new Map(before.map((routine) => [routine.lineageId, routine])); const afterByLineage = new Map(after.map((routine) => [routine.lineageId, routine])); const changes: RoutineChange[] = [];
  for (const lineageId of [...new Set([...beforeByLineage.keys(), ...afterByLineage.keys()])].sort()) { const previous = beforeByLineage.get(lineageId); const next = afterByLineage.get(lineageId); if (!previous && next) changes.push({ definitionId: next.id, change: "added", after: next }); else if (previous && !next) changes.push({ definitionId: previous.id, change: "removed", before: previous }); if (previous && next && changed(previous, next)) changes.push({ definitionId: next.id, change: "changed", before: previous, after: next }); }
  return changes;
};

const diffContextVariableEnablements = (before: AgentRevisionSnapshot, after: AgentRevisionSnapshot): ContextVariableEnablementChange[] => {
  const beforeById = new Map(before.contextVariableEnablements.filter((enablement) => enablement.enabled).map((enablement) => [enablement.variableId, enablement])); const afterById = new Map(after.contextVariableEnablements.filter((enablement) => enablement.enabled).map((enablement) => [enablement.variableId, enablement])); const changes: ContextVariableEnablementChange[] = [];
  for (const contextVariableId of [...new Set([...beforeById.keys(), ...afterById.keys()])].sort()) { const previous = beforeById.get(contextVariableId); const next = afterById.get(contextVariableId); if (!previous && next) changes.push({ contextVariableId, change: "added", after: next }); else if (previous && !next) changes.push({ contextVariableId, change: "removed", before: previous }); else if (previous && next && stableJson({ source: previous.source, resolverSkillId: previous.resolverSkillId, maxAgeSeconds: previous.maxAgeSeconds, resolverTimeoutMs: previous.resolverTimeoutMs, surfacing: previous.surfacing, enabled: previous.enabled }) !== stableJson({ source: next.source, resolverSkillId: next.resolverSkillId, maxAgeSeconds: next.maxAgeSeconds, resolverTimeoutMs: next.resolverTimeoutMs, surfacing: next.surfacing, enabled: next.enabled })) changes.push({ contextVariableId, change: "changed", before: previous, after: next }); }
  return changes;
};

const emptySnapshot: AgentRevisionSnapshot = { customInstruction: null, directives: [], routines: [], contextVariableEnablements: [] };

/** Revision review compares recorded immutable snapshots, never the mutable draft. */
export const presentRevisionDetail = (revision: AgentRevision, baseRevision: AgentRevision | null) => {
  const before = baseRevision?.snapshot ?? emptySnapshot;
  return { ...presentRevisionSummary(revision), snapshotFormatVersion: 1, scope: { customInstructions: true, directives: true, routines: true, contextVariableEnablements: true }, dependencyWarnings: [], enabledContextVariableIds: revision.snapshot.contextVariableEnablements.filter((enablement) => enablement.enabled).map((enablement) => enablement.variableId).sort(), scopedChanges: { customInstruction: { before: before.customInstruction, after: revision.snapshot.customInstruction, changed: before.customInstruction !== revision.snapshot.customInstruction }, directives: diffDirectives(before.directives, revision.snapshot.directives), routines: diffRoutines(before.routines, revision.snapshot.routines), contextVariableEnablements: diffContextVariableEnablements(before, revision.snapshot) } };
};

export const presentRevisionState = (state: AgentRevisionState, canPublish: boolean, proactiveGreetingEnabled = false) => ({ agentId: state.agentId, status: state.status, draft: { generation: state.draft.generation, basePublishedRevisionId: state.draft.basePublishedRevisionId, updatedAt: state.draft.updatedAt.toISOString() }, publishedRevision: state.publishedRevision ? presentRevisionSummary(state.publishedRevision) : null, canPublish, proactiveGreetingEnabled });
