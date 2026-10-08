import type { RoutineTurnEffects } from "@radioso/conversation-contract";

import type { PreparedSession } from "../chatSessionPreparer.js";
import { routineEndingEffectsForTurn } from "../routineEndingEffects.js";
import { routineReplyDelivery } from "./routineReplyDelivery.js";

/**
 * A turn a routine claimed, before its reply exists, as both {@link routineReplyFor} callers
 * receive it: `ChatTurnAssembly.claimRoutineTurn`'s result. `TTurn` is each caller's own
 * settled-turn shape (`ChatTurnAssemblyRoutineResult`); this module never names it, since the
 * delivery rule reads only `effects`, never the rendered reply.
 */
interface RoutineReplyClaim<TTurn> {
  effects: RoutineTurnEffects;
  reply: {
    render(): Promise<TTurn>;
    stream?(): AsyncGenerator<string, TTurn>;
  };
}

type RoutineReplyOutcome<TTurn> =
  | { delivery: "stream"; stream: () => AsyncGenerator<string, TTurn> }
  | { delivery: "whole"; turn: TTurn };

/**
 * How a claimed routine turn's reply reaches the caller ({@link routineReplyDelivery}), shared
 * by live chat (`ChatService`) and Test Chat replay (`WorkbenchReplayRunner`) so both apply the
 * identical rule from the identical inputs. `whole` renders the reply here, before the caller
 * does anything public with it; `stream` hands back the claim's own stream untouched, so the
 * caller controls emission and settlement timing.
 */
export const routineReplyFor = async <TTurn>(input: {
  session: PreparedSession;
  workspaceId: string;
  claim: RoutineReplyClaim<TTurn>;
}): Promise<RoutineReplyOutcome<TTurn>> => {
  const stream = input.claim.reply.stream?.bind(input.claim.reply);
  const delivery = routineReplyDelivery({
    effects: input.claim.effects,
    ending: routineEndingEffectsForTurn({
      session: input.session,
      workspaceId: input.workspaceId,
      turn: input.claim.effects,
    }),
    replyStreams: stream !== undefined,
  });
  if (delivery === "stream" && stream) {
    return { delivery, stream };
  }
  return { delivery: "whole", turn: await input.claim.reply.render() };
};
