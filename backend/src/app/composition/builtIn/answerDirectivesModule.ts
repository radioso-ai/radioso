import {
  conciseReadableFormattingDirective,
  inlineSupportedLinksDirective,
  representOrganizationDirective,
} from "../../../modules/directives/public.js";
import type { ApplicationModule } from "../applicationModule.js";

export const createAnswerDirectivesApplicationModule = (): ApplicationModule => ({
  id: "radioso-answer-directives",
  name: "Radioso Answer Directives",
  register(context) {
    context.registerDirective(conciseReadableFormattingDirective);
    context.registerDirective(representOrganizationDirective);
    context.registerDirective(inlineSupportedLinksDirective);
  },
});
