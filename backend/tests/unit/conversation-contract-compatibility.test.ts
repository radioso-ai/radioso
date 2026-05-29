import { describe, expect, it } from "vitest";

import type {
  Directive as ContractDirective,
  DirectiveMatch as ContractDirectiveMatch,
  SkillOutcome as ContractSkillOutcome,
  SkillOutcomeStatus as ContractSkillOutcomeStatus,
  SkillTransientGuidance as ContractSkillTransientGuidance,
  SteeringRule as ContractSteeringRule,
} from "@radioso/conversation-contract";
import type { Directive, DirectiveMatch } from "../../src/modules/directives/public.js";
import type { SkillOutcome, SkillOutcomeStatus, SkillTransientGuidance } from "../../src/modules/skills/public.js";
import type { SteeringRule } from "../../src/shared/domain/steeringRule.js";

type Extends<Actual, Expected> = [Actual] extends [Expected] ? true : false;
type Assert<T extends true> = T;

type _SteeringRuleMatchesContract = Assert<Extends<SteeringRule, ContractSteeringRule>>;
type _ContractSteeringRuleMatchesBackend = Assert<Extends<ContractSteeringRule, SteeringRule>>;

type _SkillGuidanceMatchesContract = Assert<Extends<SkillTransientGuidance, ContractSkillTransientGuidance>>;
type _ContractSkillGuidanceMatchesBackend = Assert<Extends<ContractSkillTransientGuidance, SkillTransientGuidance>>;

type _SkillOutcomeStatusMatchesContract = Assert<Extends<SkillOutcomeStatus, ContractSkillOutcomeStatus>>;
type _ContractSkillOutcomeStatusMatchesBackend = Assert<Extends<ContractSkillOutcomeStatus, SkillOutcomeStatus>>;

type _SkillOutcomeMatchesContract = Assert<Extends<SkillOutcome, ContractSkillOutcome>>;
type _ContractSkillOutcomeMatchesBackend = Assert<Extends<ContractSkillOutcome, SkillOutcome>>;

type _DirectiveMatchesContract = Assert<Extends<Directive, ContractDirective>>;
type _ContractDirectiveMatchesBackend = Assert<Extends<ContractDirective, Directive>>;

type _DirectiveMatchMatchesContract = Assert<Extends<DirectiveMatch, ContractDirectiveMatch>>;
type _ContractDirectiveMatchMatchesBackend = Assert<Extends<ContractDirectiveMatch, DirectiveMatch>>;

describe("conversation contract compatibility", () => {
  it("keeps backend steering, directive, and skill outcome shapes aligned with the reusable contract", () => {
    expect(true).toBe(true);
  });
});
