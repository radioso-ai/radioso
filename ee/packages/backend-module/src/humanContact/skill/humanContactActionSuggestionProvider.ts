import type {
  ChatActionSuggestion,
  ChatActionSuggestionContext,
  ChatActionSuggestionProvider,
} from "../../radiosoModuleTypes.js";
import { HUMAN_CONTACT_SKILL_NAME } from "../humanContactTypes.js";
import type { HumanContactSettingsService } from "../contactSettingsService.js";
import { humanContactRequestSkillDefinition } from "./definition.js";
import type { DefinitionBackedIntakePrompts } from "./definitionBackedIntakePrompts.js";
import { resolveLanguageContext } from "./humanContactIntakeProvider.js";

export class HumanContactActionSuggestionProvider implements ChatActionSuggestionProvider {
  readonly name = "contact_human";

  constructor(private readonly input: {
    settingsService: Pick<HumanContactSettingsService, "findSettings">;
    intakePrompts: Pick<DefinitionBackedIntakePrompts, "composeChipLabel">;
  }) {}

  async evaluate(context: ChatActionSuggestionContext): Promise<ChatActionSuggestion | null> {
    const isRetrievalNoContext = context.skillName === "retrieval.answer" && context.skillOutcome === "no_context";
    if (!isRetrievalNoContext && context.answerOutcome !== "no_context_refusal") {
      return null;
    }
    const settings = await this.input.settingsService.findSettings(context.workspaceId);
    if (!settings.configured) {
      return null;
    }
    let text: string;
    try {
      text = await this.input.intakePrompts.composeChipLabel({
        languageContext: resolveLanguageContext({
          history: context.history,
          query: context.query,
        }),
        userExpectedLocale: context.userExpectedLocale ?? null,
      });
    } catch {
      return null;
    }
    return {
      text,
      kind: "contact_human",
      action: {
        kind: "start_intent",
        intent: {
          skillName: HUMAN_CONTACT_SKILL_NAME,
          intentName: "no_context_refusal",
          display: humanContactRequestSkillDefinition.display,
        },
      },
    };
  }
}
