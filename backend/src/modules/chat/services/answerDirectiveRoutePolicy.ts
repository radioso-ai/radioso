import type { Directive } from "../../directives/public.js";
import {
  conciseReadableFormattingDirective,
  inlineSupportedLinksDirective,
  representOrganizationDirective,
} from "../../directives/public.js";
import { CHAT_TURN_ROUTE } from "../../../shared/domain/chatTurnRoute.js";

const DEFAULT_ROUTES_BY_DIRECTIVE = new WeakMap<Directive, string[]>([
  [
    conciseReadableFormattingDirective,
    [
      CHAT_TURN_ROUTE.RETRIEVAL,
      CHAT_TURN_ROUTE.DIRECT,
    ],
  ],
  [representOrganizationDirective, [CHAT_TURN_ROUTE.RETRIEVAL]],
  [inlineSupportedLinksDirective, [CHAT_TURN_ROUTE.RETRIEVAL]],
]);

export const defaultAnswerDirectiveRoutes = (directive: Directive): string[] | undefined => {
  const routes = DEFAULT_ROUTES_BY_DIRECTIVE.get(directive);
  return routes ? [...routes] : undefined;
};
