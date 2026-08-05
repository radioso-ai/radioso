/**
 * Maximum-weight bipartite matching, by the Hungarian algorithm.
 *
 * This module knows nothing about topics: it takes a weight matrix and returns
 * a pairing. The only thing it promises the caller beyond optimality is
 * determinism, which matters because a matching problem is exactly where ties
 * hide -- two pairings of identical total weight are equally optimal, and an
 * arbitrary choice between them would make a run's output depend on hash order
 * or on the order the caller happened to build the matrix in.
 *
 * The implementation is the O(n^3) shortest-augmenting-path form with dual
 * potentials (Jonker-Volgenant's refinement of Kuhn-Munkres). A greedy
 * heaviest-edge-first pass is not a substitute: it takes the single best pair
 * and can then be left with no legal partner for the rest, for a strictly worse
 * total than the optimum.
 */

/**
 * Pairs rows with columns so the total weight of the chosen pairs is as large
 * as possible. Returns, for each row, the column it was paired with, or `-1`
 * when the row is left unpaired.
 *
 * Only strictly positive weights are edges; a cell at or below zero means the
 * pair is not allowed, and a row with no allowed pair is left unmatched rather
 * than forced onto a column. Callers therefore pass zero for pairs that failed
 * a threshold, and the matching is free to leave vertices out -- which is what
 * makes "this topic matched nothing" expressible.
 *
 * Ties resolve to the lowest column index, and every scan runs in ascending
 * index order, so the result is a pure function of the matrix.
 */
export const maxWeightBipartiteMatching = (
  weights: readonly (readonly number[])[],
  rowCount: number,
  columnCount: number,
): number[] => {
  const matched = new Array<number>(rowCount).fill(-1);
  if (rowCount === 0 || columnCount === 0) {
    return matched;
  }

  // The solver below assigns every row to a column, so the matrix is padded to
  // a square with zero-cost cells. A padded cell costs the same as a forbidden
  // one, which is why an unmatched vertex is never worse than a bad match.
  const size = Math.max(rowCount, columnCount);
  const cost = (row: number, column: number): number => {
    if (row >= rowCount || column >= columnCount) {
      return 0;
    }
    const weight = weights[row][column];
    // Minimizing negated weight maximizes weight. Non-edges cost zero, so the
    // solver drops them in favour of leaving a vertex unpaired.
    return weight > 0 ? -weight : 0;
  };

  // One-indexed throughout; index 0 is the virtual source the augmenting path
  // starts from. `potentialRow`/`potentialColumn` are the duals, `assignedRow`
  // maps a column to the row that holds it, and `predecessor` records the
  // column an alternating path arrived from.
  const potentialRow = new Array<number>(size + 1).fill(0);
  const potentialColumn = new Array<number>(size + 1).fill(0);
  const assignedRow = new Array<number>(size + 1).fill(0);
  const predecessor = new Array<number>(size + 1).fill(0);

  for (let row = 1; row <= size; row += 1) {
    assignedRow[0] = row;
    let column = 0;
    const slack = new Array<number>(size + 1).fill(Number.POSITIVE_INFINITY);
    const visited = new Array<boolean>(size + 1).fill(false);

    do {
      visited[column] = true;
      const currentRow = assignedRow[column];
      let delta = Number.POSITIVE_INFINITY;
      let nextColumn = 0;

      for (let candidate = 1; candidate <= size; candidate += 1) {
        if (visited[candidate]) {
          continue;
        }
        const reduced = cost(currentRow - 1, candidate - 1)
          - potentialRow[currentRow]
          - potentialColumn[candidate];
        // Strict comparisons scanning ascending: an equally good candidate
        // never displaces the one with the lower index.
        if (reduced < slack[candidate]) {
          slack[candidate] = reduced;
          predecessor[candidate] = column;
        }
        if (slack[candidate] < delta) {
          delta = slack[candidate];
          nextColumn = candidate;
        }
      }

      for (let candidate = 0; candidate <= size; candidate += 1) {
        if (visited[candidate]) {
          potentialRow[assignedRow[candidate]] += delta;
          potentialColumn[candidate] -= delta;
        } else {
          slack[candidate] -= delta;
        }
      }
      column = nextColumn;
    } while (assignedRow[column] !== 0);

    // Walk the augmenting path back to the source, shifting each column to the
    // row that reached it.
    do {
      const previous = predecessor[column];
      assignedRow[column] = assignedRow[previous];
      column = previous;
    } while (column !== 0);
  }

  for (let column = 1; column <= size; column += 1) {
    const row = assignedRow[column] - 1;
    if (row < 0 || row >= rowCount || column - 1 >= columnCount) {
      continue;
    }
    // Drop pairings the solver only made because the square needed filling.
    if (weights[row][column - 1] > 0) {
      matched[row] = column - 1;
    }
  }
  return matched;
};
