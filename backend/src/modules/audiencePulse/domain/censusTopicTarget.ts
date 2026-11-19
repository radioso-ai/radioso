/** Fewest operator-visible topics a census aims for, however little traffic a workspace has. */
export const TOPIC_TARGET_MIN = 10;
/** Most topics a census aims for, so a very busy workspace still gets a list an operator can read. */
export const TOPIC_TARGET_MAX = 40;
/** `sqrt(n) / TOPIC_TARGET_DIVISOR` topics: about 20 at 5,000 questions, about 34 at 14,000. */
const TOPIC_TARGET_DIVISOR = 3.5;

/**
 * How many topics the census agglomerates its base clusters into, given how many
 * facet-ready questions it clusters: `clamp(round(sqrt(n) / 3.5), 10, 40)`.
 *
 * Topic count grows with the square root of volume because breadth grows slower than
 * traffic -- a workspace with ten times the questions asks about more things, not ten
 * times as many. A fixed target makes a busy workspace's topics too broad to act on.
 * `@radioso/census` stays a generic library that takes `topicTarget` as an option;
 * what a good target is for visitor questions is decided here.
 */
export const deriveTopicTarget = (clusteredQuestionCount: number): number => {
  if (!(clusteredQuestionCount > 0)) {
    return TOPIC_TARGET_MIN;
  }
  const scaled = Math.round(Math.sqrt(clusteredQuestionCount) / TOPIC_TARGET_DIVISOR);
  return Math.min(Math.max(scaled, TOPIC_TARGET_MIN), TOPIC_TARGET_MAX);
};
