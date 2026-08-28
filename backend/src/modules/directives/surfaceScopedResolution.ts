import { GENERATION_SURFACE, type GenerationSurface } from "../../shared/domain/generationSurface.js";
import { addressesSurface } from "../../shared/domain/steeringRule.js";

import { resolveDirectiveRelationships, type DirectiveMatch, type DirectiveOmission } from "./domain.js";
import { boundSteeringMatches, type SteeringBoundConfig, type SteeringBoundDrop } from "./steeringBound.js";

const ALL_SURFACES: GenerationSurface[] = Object.values(GENERATION_SURFACE);

const withSurfaces = (match: DirectiveMatch, surfaces: GenerationSurface[]): DirectiveMatch => {
  const authored = match.directive.surfaces;
  const unchanged = authored?.length
    ? authored.length === surfaces.length && authored.every((surface) => surfaces.includes(surface))
    : surfaces.length === 1 && surfaces[0] === GENERATION_SURFACE.ANSWER;
  return unchanged ? match : { ...match, directive: { ...match.directive, surfaces } };
};

interface SurfacePass {
  kept: DirectiveMatch[];
  lost: Array<{ directiveName: string; reason: string }>;
}

/**
 * Runs one decision independently for each generator and unions the results.
 *
 * Every decision that narrows what a generator renders — replacing a directive,
 * satisfying a dependency, fitting a prompt budget — is a decision about that one
 * generator. Run globally, an unrelated rule aimed elsewhere silently changes the
 * outcome: a reply rule cancels a suggestion rule it never competes with, or eight
 * reply rules exhaust a budget and push a suggestion rule out of a block it was the
 * only occupant of.
 *
 * A directive that survives on some of its surfaces and loses on others keeps the
 * ones it survived on, so it still steers where it won. One that loses everywhere is
 * reported, carrying the reason from its last losing pass.
 */
const perSurface = (
  allowed: DirectiveMatch[],
  run: (scoped: DirectiveMatch[]) => SurfacePass,
): { kept: DirectiveMatch[]; lost: Array<{ directiveName: string; reason: string }> } => {
  const survivingSurfaces = new Map<string, GenerationSurface[]>();
  const lossReasons = new Map<string, string>();

  for (const surface of ALL_SURFACES) {
    const scoped = allowed.filter((match) => addressesSurface(match.directive.surfaces, surface));
    if (scoped.length === 0) {
      continue;
    }
    const pass = run(scoped);
    for (const match of pass.kept) {
      const name = match.directive.name;
      survivingSurfaces.set(name, [...(survivingSurfaces.get(name) ?? []), surface]);
    }
    for (const loss of pass.lost) {
      lossReasons.set(loss.directiveName, loss.reason);
    }
  }

  const kept: DirectiveMatch[] = [];
  const lost: Array<{ directiveName: string; reason: string }> = [];
  for (const match of allowed) {
    const surfaces = survivingSurfaces.get(match.directive.name);
    if (surfaces?.length) {
      kept.push(withSurfaces(match, surfaces));
    } else {
      lost.push({
        directiveName: match.directive.name,
        reason: lossReasons.get(match.directive.name) ?? "relationship_resolved",
      });
    }
  }
  return { kept, lost };
};

/** Resolves `excludes` / `dependsOn` per generator. See {@link perSurface}. */
export const resolveRelationshipsPerSurface = (
  allowed: DirectiveMatch[],
): { kept: DirectiveMatch[]; omissions: DirectiveOmission[] } => {
  const { kept, lost } = perSurface(allowed, (scoped) => {
    const { kept: passKept, omissions } = resolveDirectiveRelationships(scoped);
    return {
      kept: passKept,
      lost: omissions.map((omission) => ({ directiveName: omission.directiveName, reason: omission.reason })),
    };
  });
  return { kept, omissions: lost };
};

/**
 * Fits the top-k and token caps per generator. Each generator renders its own prompt
 * block, so each gets the whole budget rather than competing for one shared with
 * rules it never appears beside. See {@link perSurface}.
 */
export const boundSteeringPerSurface = (
  kept: DirectiveMatch[],
  config: SteeringBoundConfig,
): { rendered: DirectiveMatch[]; dropped: SteeringBoundDrop[] } => {
  const { kept: rendered, lost } = perSurface(kept, (scoped) => {
    const { kept: passKept, dropped } = boundSteeringMatches(scoped, config);
    return {
      kept: passKept,
      lost: dropped.map((drop) => ({ directiveName: drop.directiveName, reason: drop.reason })),
    };
  });
  return {
    rendered,
    dropped: lost.map((loss) => ({
      directiveName: loss.directiveName,
      reason: loss.reason as SteeringBoundDrop["reason"],
    })),
  };
};
