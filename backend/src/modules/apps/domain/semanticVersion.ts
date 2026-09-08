/**
 * The semantic-version subset the App contract's `SemanticVersionRange` can express,
 * evaluated here rather than pulled in as a dependency: the grammar the contract accepts
 * is fixed and small, and a release's compatibility answer is a decision the Apps domain
 * records evidence about, so it must be reproducible from this repository alone.
 *
 * Build metadata is ignored for ordering, as the specification requires. A prerelease
 * version only satisfies a comparator whose own operand carries a prerelease of the same
 * `major.minor.patch`, which is what stops `>=1.0.0` from quietly admitting `2.0.0-rc.1`.
 */

const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

interface SemanticVersionParts {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

const parseSemanticVersion = (value: string): SemanticVersionParts | null => {
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
};

const comparePrereleaseIdentifier = (left: string, right: string): number => {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
};

const comparePrerelease = (left: readonly string[], right: readonly string[]): number => {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const ordered = comparePrereleaseIdentifier(leftPart, rightPart);
    if (ordered !== 0) return ordered;
  }
  return 0;
};

const compare = (left: SemanticVersionParts, right: SemanticVersionParts): number =>
  left.major - right.major
  || left.minor - right.minor
  || left.patch - right.patch
  || comparePrerelease(left.prerelease, right.prerelease);

type Operator = "<" | "<=" | ">" | ">=" | "=" | "^" | "~";

const OPERATOR_PATTERN = /^(<=|>=|<|>|=|\^|~)?(.*)$/u;

const isWildcard = (part: string | undefined): boolean =>
  part === undefined || part === "" || part === "x" || part === "X" || part === "*";

interface PartialOperand {
  readonly major: number | null;
  readonly minor: number | null;
  readonly patch: number | null;
  readonly prerelease: readonly string[];
}

const parseOperand = (value: string): PartialOperand | null => {
  if (isWildcard(value)) return { major: null, minor: null, patch: null, prerelease: [] };
  const [core, ...rest] = value.split("+");
  const [numbers, ...prereleaseParts] = (core ?? "").split("-");
  const prerelease = prereleaseParts.length > 0 ? prereleaseParts.join("-").split(".") : [];
  if (rest.length > 1) return null;
  const segments = (numbers ?? "").split(".");
  if (segments.length > 3) return null;
  const [major, minor, patch] = segments;
  if (isWildcard(major)) return { major: null, minor: null, patch: null, prerelease: [] };
  if (!/^\d+$/u.test(major)) return null;
  if (isWildcard(minor)) return { major: Number(major), minor: null, patch: null, prerelease };
  if (!/^\d+$/u.test(minor)) return null;
  if (isWildcard(patch)) return { major: Number(major), minor: Number(minor), patch: null, prerelease };
  if (!/^\d+$/u.test(patch)) return null;
  return { major: Number(major), minor: Number(minor), patch: Number(patch), prerelease };
};

const lowerBound = (operand: PartialOperand): SemanticVersionParts => ({
  major: operand.major ?? 0,
  minor: operand.minor ?? 0,
  patch: operand.patch ?? 0,
  prerelease: operand.prerelease,
});

/** The first version the operand's wildcard no longer covers, or `null` when it covers everything above. */
const exclusiveUpperBound = (operand: PartialOperand, operator: Operator): SemanticVersionParts | null => {
  const zero = (major: number, minor = 0, patch = 0): SemanticVersionParts =>
    ({ major, minor, patch, prerelease: [] });
  if (operand.major === null) return null;
  if (operator === "^") {
    if (operand.major > 0) return zero(operand.major + 1);
    if (operand.minor === null) return zero(1);
    if (operand.minor > 0) return zero(0, operand.minor + 1);
    if (operand.patch === null) return zero(0, 1);
    return zero(0, 0, operand.patch + 1);
  }
  if (operator === "~") {
    if (operand.minor === null) return zero(operand.major + 1);
    return zero(operand.major, operand.minor + 1);
  }
  if (operand.minor === null) return zero(operand.major + 1);
  if (operand.patch === null) return zero(operand.major, operand.minor + 1);
  return null;
};

/**
 * A prerelease version is only comparable against an operand that names the same
 * `major.minor.patch` prerelease line. Everything else is refused, so an unreleased
 * build never satisfies a range written for stable versions.
 */
const prereleaseComparable = (version: SemanticVersionParts, operand: PartialOperand): boolean => {
  if (version.prerelease.length === 0) return true;
  return operand.prerelease.length > 0
    && operand.major === version.major
    && operand.minor === version.minor
    && operand.patch === version.patch;
};

const satisfiesComparator = (version: SemanticVersionParts, comparator: string): boolean => {
  const match = OPERATOR_PATTERN.exec(comparator.trim());
  if (!match) return false;
  const operator = (match[1] ?? "=") as Operator;
  const operand = parseOperand(match[2] ?? "");
  if (!operand) return false;
  if (operand.major === null) return version.prerelease.length === 0;
  if (!prereleaseComparable(version, operand)) return false;

  const lower = lowerBound(operand);
  const upper = exclusiveUpperBound(operand, operator);

  switch (operator) {
    case "<":
      return compare(version, lower) < 0;
    case "<=":
      return upper === null ? compare(version, lower) <= 0 : compare(version, upper) < 0;
    case ">":
      return upper === null ? compare(version, lower) > 0 : compare(version, upper) >= 0;
    case ">=":
      return compare(version, lower) >= 0;
    default:
      // A fully specified operand means exactly this version; a wildcard one means the
      // range it stands for.
      return upper === null
        ? compare(version, lower) === 0
        : compare(version, lower) >= 0 && compare(version, upper) < 0;
  }
};

/**
 * `false` for an unparseable version or range: a compatibility answer that cannot be
 * computed is not a compatible one.
 */
export const satisfiesSemanticVersionRange = (version: string, range: string): boolean => {
  const parsed = parseSemanticVersion(version);
  if (!parsed) return false;
  return range
    .split("||")
    .some((conjunction) => {
      const comparators = conjunction.trim().split(/ +/u).filter((part) => part.length > 0);
      return comparators.length > 0 && comparators.every((comparator) => satisfiesComparator(parsed, comparator));
    });
};
