import { describe, expect, it } from "vitest";

import { NotifyRoutineSkillResolver } from "../../../src/modules/notify/routineSkillResolver.js";
import { NOTIFY_SKILLS_ADAPTER } from "../../../src/modules/notify/public.js";

describe("NotifyRoutineSkillResolver", () => {
  it("resolves an enabled routine_named notify skill to a NOTIFY_SKILLS_ADAPTER definition", () => {
    const resolver = new NotifyRoutineSkillResolver([
      { skillName: "contact_dmitri", enabled: true, invocationMode: "routine_named" },
    ]);

    expect(resolver.resolve("contact_dmitri")).toMatchObject({
      name: "contact_dmitri",
      execution: { kind: "internal", adapter: NOTIFY_SKILLS_ADAPTER, enqueue: false },
      requiredCapabilities: [],
    });
  });

  it("delegates a disabled notify skill instead of resolving it", () => {
    const delegate = { resolve: (name: string) => ({ name, delegated: true }) as never };
    const resolver = new NotifyRoutineSkillResolver(
      [{ skillName: "contact_dmitri", enabled: false, invocationMode: "routine_named" }],
      delegate,
    );

    expect(resolver.resolve("contact_dmitri")).toEqual({ name: "contact_dmitri", delegated: true });
  });

  it("delegates an agent_selectable notify skill instead of resolving it", () => {
    // The whole point of this resolver is to mirror the authoring catalog's own
    // enabled && routine_named filter, so an agent_selectable-only skill must not
    // be name-dispatchable from a routine step.
    const delegate = { resolve: (name: string) => ({ name, delegated: true }) as never };
    const resolver = new NotifyRoutineSkillResolver(
      [{ skillName: "contact_dmitri", enabled: true, invocationMode: "agent_selectable" }],
      delegate,
    );

    expect(resolver.resolve("contact_dmitri")).toEqual({ name: "contact_dmitri", delegated: true });
  });

  it("delegates an unknown skill name", () => {
    const delegate = { resolve: (name: string) => ({ name, delegated: true }) as never };
    const resolver = new NotifyRoutineSkillResolver(
      [{ skillName: "contact_dmitri", enabled: true, invocationMode: "routine_named" }],
      delegate,
    );

    expect(resolver.resolve("not_authored_here")).toEqual({ name: "not_authored_here", delegated: true });
  });

  it("returns null for an unknown skill name with no delegate", () => {
    const resolver = new NotifyRoutineSkillResolver([]);

    expect(resolver.resolve("not_authored_here")).toBeNull();
  });
});
