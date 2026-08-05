/**
 * Vector arithmetic for the clustering core.
 *
 * Every operation here is float-deterministic: it uses only IEEE-754 exact
 * operations (`+`, `*`, `/`, `Math.sqrt`) and never `Math.pow`, `Math.hypot`,
 * or `**`, whose precision is implementation-defined and can therefore differ
 * between engines. Summation order is fixed by the caller-supplied index order,
 * because floating-point addition is not associative and a different order can
 * produce a different last bit.
 */

/**
 * Scales a vector to unit length. A zero vector has no direction and is
 * returned unchanged: it then has a dot product of 0 with every vector,
 * including itself, so `unitCosineDistance` places it at distance 1 —
 * orthogonal to everything, which is the closest thing to "no information"
 * the metric can express.
 */
export const toUnitVector = (vector: readonly number[]): number[] => {
  let sumOfSquares = 0;
  for (let axis = 0; axis < vector.length; axis += 1) {
    const value = vector[axis];
    sumOfSquares += value * value;
  }
  if (sumOfSquares === 0) {
    return vector.map(() => 0);
  }
  const norm = Math.sqrt(sumOfSquares);
  const unit = new Array<number>(vector.length);
  for (let axis = 0; axis < vector.length; axis += 1) {
    unit[axis] = vector[axis] / norm;
  }
  return unit;
};

/**
 * Cosine distance between two vectors that are already unit length: `1 - cos`,
 * in `[0, 2]`. Callers must pass vectors from `toUnitVector`; normalizing per
 * comparison would dominate the inner loop of k-means.
 *
 * The result is clamped at zero. Rounding in the dot product of a unit vector
 * with itself can land a couple of machine epsilons above 1, and a distance of
 * -2.2e-16 is not merely cosmetic: a cluster of identical members would get a
 * negative radius, every member would sit "outside" `radius * marginFactor`,
 * and the whole cluster would dissolve into unclassified.
 */
export const unitCosineDistance = (a: readonly number[], b: readonly number[]): number => {
  let dot = 0;
  for (let axis = 0; axis < a.length; axis += 1) {
    dot += a[axis] * b[axis];
  }
  const distance = 1 - dot;
  return distance > 0 ? distance : 0;
};

/**
 * Cosine similarity between two vectors that are already unit length, in
 * `[-1, 1]`. This is the dot product, left unclamped: unlike a distance, a
 * negative similarity is meaningful -- it says the two directions oppose -- and
 * clamping it would make every opposed pair look equally unrelated.
 */
export const unitCosineSimilarity = (a: readonly number[], b: readonly number[]): number => {
  let dot = 0;
  for (let axis = 0; axis < a.length; axis += 1) {
    dot += a[axis] * b[axis];
  }
  return dot;
};

/**
 * Mean direction of the vectors at `memberIndices`, as a unit vector.
 *
 * The sum is normalized directly rather than divided by the member count first:
 * scaling does not change direction, and skipping the division skips a rounding
 * step. Members are summed in the order given, so callers pass indices in a
 * canonical (ascending) order to keep the result independent of input order.
 * An empty membership, or one whose vectors cancel out, yields the zero vector.
 */
export const unitCentroid = (
  vectors: readonly (readonly number[])[],
  memberIndices: readonly number[],
  dimensions: number,
): number[] => {
  const sums = new Array<number>(dimensions).fill(0);
  for (let position = 0; position < memberIndices.length; position += 1) {
    const vector = vectors[memberIndices[position]];
    for (let axis = 0; axis < dimensions; axis += 1) {
      sums[axis] += vector[axis];
    }
  }
  return toUnitVector(sums);
};
