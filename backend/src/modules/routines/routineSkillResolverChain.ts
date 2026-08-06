import { routineDispatchableBuiltInSkills } from "../skills/public.js";
import { RetrieveRoutineSkillResolver, type RetrieveRoutineSkillRecord } from "../retrieval/public.js";
import { NotifyRoutineSkillResolver, type NotifyRoutineSkillRecord } from "../notify/public.js";
import { ExternalSkillRoutineSkillResolver } from "../externalSkills/public.js";
import { CustomerEmailRoutineSkillResolver } from "../customerEmail/public.js";
import { SlackRoutineSkillResolver } from "../slackSkills/public.js";
import { WebhookRoutineSkillResolver } from "../webhookSkills/public.js";
import { StaticRoutineSkillResolver, type RoutineSkillResolver } from "./skillDispatcher.js";

export interface RoutineSkillResolverChainInputs {
  webhookSkillNames: readonly string[];
  emailSkillNames: readonly string[];
  slackSkillNames: readonly string[];
  retrieveSkills: readonly RetrieveRoutineSkillRecord[];
  notifySkills: readonly NotifyRoutineSkillRecord[];
}

/**
 * Assembles the routine tool-step skill resolver chain: the ordered, delegate-nested
 * resolvers a routine `tool` step's authored `toolRef` is checked against, ending in
 * the external-MCP tail that resolves any remaining name. This is the one production
 * assembly of that chain — `createRoutineTurnProvider.forTurn` calls it, and so does
 * the authoring/runtime parity regression test, so a resolver added, reordered, or
 * dropped here is caught by both instead of only by a hand-copy.
 *
 * It knows only the per-agent skill inputs each resolver needs to build its lookup
 * table. It does not know about turn plans, model gateways, prompt templates, or
 * anything else `forTurn` assembles alongside it.
 */
export const createRoutineSkillResolverChain = ({
  webhookSkillNames,
  emailSkillNames,
  slackSkillNames,
  retrieveSkills,
  notifySkills,
}: RoutineSkillResolverChainInputs): RoutineSkillResolver =>
  new StaticRoutineSkillResolver(
    routineDispatchableBuiltInSkills,
    new WebhookRoutineSkillResolver(
      webhookSkillNames,
      new CustomerEmailRoutineSkillResolver(
        emailSkillNames,
        new SlackRoutineSkillResolver(
          slackSkillNames,
          new RetrieveRoutineSkillResolver(
            retrieveSkills,
            new NotifyRoutineSkillResolver(notifySkills, new ExternalSkillRoutineSkillResolver()),
          ),
        ),
      ),
    ),
  );
