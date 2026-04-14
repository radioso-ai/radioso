const VALID_FAMILIES = new Set(["api", "chat", "ingestion", "mixed", "stress", "soak"]);
const VALID_SAFETY_TIERS = new Set(["safe", "guarded", "restricted"]);
const BACKLOG_AWARE_WORKLOADS = new Set(["document-ingest", "mixed"]);

const PROFILE_DEFINITIONS = [
  {
    id: "api-smoke",
    name: "API Smoke",
    family: "api",
    safetyTier: "safe",
    allowedEnvironmentClasses: ["local", "ci", "staging"],
    durationSeconds: 30,
    concurrency: 6,
    workloads: [{ kind: "health", concurrency: 6 }],
    requiredCollectors: [],
    budgets: [
      { metric: "latency.p95", type: "max", threshold: 400, unit: "ms", severity: "fail" },
      { metric: "errorRate", type: "max", threshold: 0.02, unit: "ratio", severity: "fail" },
    ],
  },
  {
    id: "ingestion-smoke",
    name: "Ingestion Smoke",
    family: "ingestion",
    safetyTier: "guarded",
    allowedEnvironmentClasses: ["local", "staging", "pre_release"],
    durationSeconds: 45,
    concurrency: 2,
    workloads: [{ kind: "document-ingest", concurrency: 2 }],
    requiredCollectors: ["queue-snapshot"],
    budgets: [
      { metric: "latency.p95", type: "max", threshold: 2500, unit: "ms", severity: "fail" },
      { metric: "queue.oldestQueuedAgeMsPeak", type: "max", threshold: 30000, unit: "ms", severity: "fail" },
    ],
  },
  {
    id: "chat-smoke",
    name: "Chat Smoke",
    family: "chat",
    safetyTier: "guarded",
    allowedEnvironmentClasses: ["local", "staging", "pre_release"],
    durationSeconds: 45,
    concurrency: 2,
    workloads: [{ kind: "public-chat", concurrency: 2 }],
    requiredCollectors: [],
    budgets: [
      { metric: "latency.p95", type: "max", threshold: 12000, unit: "ms", severity: "warn" },
      { metric: "errorRate", type: "max", threshold: 0.05, unit: "ratio", severity: "fail" },
    ],
  },
  {
    id: "mixed-smoke",
    name: "Mixed Smoke",
    family: "mixed",
    safetyTier: "guarded",
    allowedEnvironmentClasses: ["local", "staging", "pre_release"],
    durationSeconds: 60,
    concurrency: 5,
    workloads: [
      { kind: "health", concurrency: 2 },
      { kind: "document-ingest", concurrency: 1 },
      { kind: "public-chat", concurrency: 2 },
    ],
    requiredCollectors: ["queue-snapshot"],
    budgets: [
      { metric: "latency.p95", type: "max", threshold: 10000, unit: "ms", severity: "warn" },
      { metric: "errorRate", type: "max", threshold: 0.08, unit: "ratio", severity: "fail" },
      { metric: "queue.oldestQueuedAgeMsPeak", type: "max", threshold: 45000, unit: "ms", severity: "fail" },
    ],
  },
  {
    id: "api-stress",
    name: "API Stress",
    family: "stress",
    safetyTier: "restricted",
    allowedEnvironmentClasses: ["staging", "pre_release"],
    durationSeconds: 120,
    concurrency: 40,
    workloads: [{ kind: "health", concurrency: 40 }],
    requiredCollectors: [],
    budgets: [
      { metric: "latency.p95", type: "max", threshold: 1500, unit: "ms", severity: "warn" },
      { metric: "errorRate", type: "max", threshold: 0.1, unit: "ratio", severity: "fail" },
    ],
  },
  {
    id: "mixed-soak",
    name: "Mixed Soak",
    family: "soak",
    safetyTier: "restricted",
    allowedEnvironmentClasses: ["staging", "pre_release"],
    durationSeconds: 600,
    concurrency: 6,
    workloads: [
      { kind: "health", concurrency: 2 },
      { kind: "document-ingest", concurrency: 2 },
      { kind: "public-chat", concurrency: 2 },
    ],
    requiredCollectors: ["queue-snapshot"],
    budgets: [
      { metric: "errorRate", type: "max", threshold: 0.05, unit: "ratio", severity: "fail" },
      { metric: "queue.oldestQueuedAgeMsPeak", type: "max", threshold: 120000, unit: "ms", severity: "fail" },
    ],
  },
];

export const validateProfileDefinition = (profile) => {
  if (!profile || typeof profile !== "object") {
    throw new Error("Profile definition must be an object.");
  }

  if (!profile.id || typeof profile.id !== "string") {
    throw new Error("Profile id is required.");
  }

  if (!VALID_FAMILIES.has(profile.family)) {
    throw new Error(`Profile ${profile.id} uses an unsupported family.`);
  }

  if (!VALID_SAFETY_TIERS.has(profile.safetyTier)) {
    throw new Error(`Profile ${profile.id} uses an unsupported safety tier.`);
  }

  if (!Array.isArray(profile.allowedEnvironmentClasses) || profile.allowedEnvironmentClasses.length === 0) {
    throw new Error(`Profile ${profile.id} must allow at least one environment class.`);
  }

  if (!Array.isArray(profile.workloads) || profile.workloads.length === 0) {
    throw new Error(`Profile ${profile.id} must declare at least one workload.`);
  }

  const requiresBacklogMetrics = profile.workloads.some((workload) => BACKLOG_AWARE_WORKLOADS.has(workload.kind))
    || profile.family === "mixed"
    || profile.family === "ingestion"
    || profile.family === "soak";

  if (requiresBacklogMetrics && !profile.requiredCollectors.includes("queue-snapshot")) {
    throw new Error(`Profile ${profile.id} requires a backlog-aware collector such as queue-snapshot.`);
  }

  return profile;
};

export const listProfiles = () => PROFILE_DEFINITIONS.map((profile) => validateProfileDefinition({ ...profile }));

export const getProfileById = (profileId) => {
  const profile = PROFILE_DEFINITIONS.find((candidate) => candidate.id === profileId);
  if (!profile) {
    throw new Error(`Unknown benchmark profile: ${profileId}`);
  }

  return validateProfileDefinition({ ...profile });
};

export const resolveProfileExecution = ({ profileId, environmentClass, allowRestricted = false }) => {
  const profile = getProfileById(profileId);

  if (profile.safetyTier === "restricted" && !allowRestricted) {
    throw new Error(`Profile ${profile.id} is restricted and requires --allow-restricted.`);
  }

  if (!profile.allowedEnvironmentClasses.includes(environmentClass)) {
    throw new Error(
      `Profile ${profile.id} does not allow environment class ${environmentClass}. Allowed: ${profile.allowedEnvironmentClasses.join(", ")}`,
    );
  }

  return profile;
};
