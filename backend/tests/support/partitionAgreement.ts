/**
 * Agreement between a recovered partition and a reference partition.
 *
 * Adjusted Rand index and normalized mutual information are the two standard
 * measures for this, and both are a few dozen lines over a contingency table,
 * so they live here rather than pulling a statistics dependency into the
 * backend for one eval.
 *
 * Both take parallel arrays: `predicted[i]` and `reference[i]` are the cluster
 * and the reference class of the same item. Labels are opaque strings; neither
 * measure depends on how they are named or ordered.
 */

interface ContingencyTable {
  itemCount: number;
  /** Joint counts, indexed by predicted label then reference label. */
  joint: Map<string, Map<string, number>>;
  predictedTotals: Map<string, number>;
  referenceTotals: Map<string, number>;
}

const buildContingencyTable = (
  predicted: readonly string[],
  reference: readonly string[],
): ContingencyTable => {
  if (predicted.length !== reference.length) {
    throw new Error("Partition agreement needs parallel label arrays of equal length.");
  }

  const joint = new Map<string, Map<string, number>>();
  const predictedTotals = new Map<string, number>();
  const referenceTotals = new Map<string, number>();

  for (let index = 0; index < predicted.length; index += 1) {
    const predictedLabel = predicted[index];
    const referenceLabel = reference[index];
    const row = joint.get(predictedLabel) ?? new Map<string, number>();
    row.set(referenceLabel, (row.get(referenceLabel) ?? 0) + 1);
    joint.set(predictedLabel, row);
    predictedTotals.set(predictedLabel, (predictedTotals.get(predictedLabel) ?? 0) + 1);
    referenceTotals.set(referenceLabel, (referenceTotals.get(referenceLabel) ?? 0) + 1);
  }

  return { itemCount: predicted.length, joint, predictedTotals, referenceTotals };
};

const choosePairs = (count: number): number => (count * (count - 1)) / 2;

const sumOfPairs = (totals: Map<string, number>): number => {
  let sum = 0;
  for (const count of totals.values()) {
    sum += choosePairs(count);
  }
  return sum;
};

/**
 * Adjusted Rand index: agreement on co-membership of item pairs, corrected for
 * the agreement a random partition of the same shape would reach. 1 is an exact
 * match, 0 is chance, negative is worse than chance.
 */
export const adjustedRandIndex = (
  predicted: readonly string[],
  reference: readonly string[],
): number => {
  const table = buildContingencyTable(predicted, reference);
  if (table.itemCount < 2) {
    return 1;
  }

  let observedPairs = 0;
  for (const row of table.joint.values()) {
    for (const count of row.values()) {
      observedPairs += choosePairs(count);
    }
  }

  const predictedPairs = sumOfPairs(table.predictedTotals);
  const referencePairs = sumOfPairs(table.referenceTotals);
  const totalPairs = choosePairs(table.itemCount);
  const expectedPairs = (predictedPairs * referencePairs) / totalPairs;
  const maximumPairs = (predictedPairs + referencePairs) / 2;

  // Both partitions collapsed to the same trivial shape: perfect by definition.
  if (maximumPairs === expectedPairs) {
    return 1;
  }
  return (observedPairs - expectedPairs) / (maximumPairs - expectedPairs);
};

/**
 * Normalized mutual information with arithmetic-mean normalization: how much
 * knowing the cluster tells you about the reference class, scaled to [0, 1].
 * Unlike the adjusted Rand index it is not corrected for chance, so it reads
 * higher; the two are reported together for that reason.
 */
export const normalizedMutualInformation = (
  predicted: readonly string[],
  reference: readonly string[],
): number => {
  const table = buildContingencyTable(predicted, reference);
  if (table.itemCount === 0) {
    return 0;
  }

  const entropy = (totals: Map<string, number>): number => {
    let value = 0;
    for (const count of totals.values()) {
      const probability = count / table.itemCount;
      value -= probability * Math.log(probability);
    }
    return value;
  };

  let mutualInformation = 0;
  for (const [predictedLabel, row] of table.joint) {
    const predictedTotal = table.predictedTotals.get(predictedLabel)!;
    for (const [referenceLabel, count] of row) {
      const referenceTotal = table.referenceTotals.get(referenceLabel)!;
      const joint = count / table.itemCount;
      mutualInformation += joint * Math.log((count * table.itemCount) / (predictedTotal * referenceTotal));
    }
  }

  const normalizer = (entropy(table.predictedTotals) + entropy(table.referenceTotals)) / 2;
  // Either partition is a single block, so no information can be carried.
  if (normalizer <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(1, mutualInformation / normalizer));
};
