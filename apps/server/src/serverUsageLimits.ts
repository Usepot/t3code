import type { ServerUsageLimitBucket, ServerUsageLimitsSnapshot } from "@t3tools/contracts";

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asNonNegativeInt(value: unknown): number | undefined {
  const number = asNumber(value);
  return number !== undefined && Number.isInteger(number) && number >= 0 ? number : undefined;
}

function toIsoDateTimeFromUnixSeconds(value: unknown): string | undefined {
  const seconds = asNonNegativeInt(value);
  return seconds !== undefined ? new Date(seconds * 1_000).toISOString() : undefined;
}

function toBucket(id: string, label: string, value: unknown): ServerUsageLimitBucket | null {
  const record = asObject(value);
  if (!record) {
    return null;
  }

  const bucket: ServerUsageLimitBucket = {
    id,
    label,
    ...(asNonNegativeInt(record.limit) !== undefined
      ? { limit: asNonNegativeInt(record.limit) }
      : {}),
    ...(asNonNegativeInt(record.remaining) !== undefined
      ? { remaining: asNonNegativeInt(record.remaining) }
      : {}),
    ...(asNonNegativeInt(record.used) !== undefined ? { used: asNonNegativeInt(record.used) } : {}),
    ...(asNumber(record.usedPercent) !== undefined
      ? { usedPercent: asNumber(record.usedPercent) }
      : {}),
    ...(toIsoDateTimeFromUnixSeconds(record.reset) !== undefined
      ? { resetsAt: toIsoDateTimeFromUnixSeconds(record.reset) }
      : toIsoDateTimeFromUnixSeconds(record.resetsAt) !== undefined
        ? { resetsAt: toIsoDateTimeFromUnixSeconds(record.resetsAt) }
        : {}),
    ...(asNonNegativeInt(record.windowDurationMins) !== undefined
      ? { windowDurationMins: asNonNegativeInt(record.windowDurationMins) }
      : {}),
  };

  return bucket;
}

function titleCaseLimitId(value: string): string {
  return value
    .split(/[_-]+/g)
    .filter((part) => part.length > 0)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

export function createUnavailableUsageSnapshot(input: {
  source: "codex" | "github";
  checkedAt: string;
  message: string;
}): ServerUsageLimitsSnapshot {
  return {
    source: input.source,
    available: false,
    checkedAt: input.checkedAt,
    message: input.message,
    buckets: [],
  };
}

export function normalizeCodexUsageLimits(
  raw: unknown,
  checkedAt: string,
): ServerUsageLimitsSnapshot {
  const root = asObject(raw);
  const buckets: ServerUsageLimitBucket[] = [];
  const byLimitId = asObject(root?.rateLimitsByLimitId);

  if (byLimitId) {
    for (const [id, value] of Object.entries(byLimitId)) {
      const bucket = toBucket(id, titleCaseLimitId(id), value);
      if (bucket) {
        buckets.push(bucket);
      }
    }
  }

  if (buckets.length === 0) {
    const legacyBucket = toBucket("default", "Default", root?.rateLimits);
    if (legacyBucket) {
      buckets.push(legacyBucket);
    }
  }

  return {
    source: "codex",
    available: buckets.length > 0,
    checkedAt,
    ...(buckets.length === 0
      ? { message: "Codex did not return any rate-limit buckets yet." }
      : {}),
    buckets,
  };
}

const GITHUB_RATE_LIMIT_LABELS: Record<string, string> = {
  core: "REST API",
  graphql: "GraphQL API",
  search: "Search API",
  integration_manifest: "Integration Manifest",
  code_scanning_upload: "Code Scanning Upload",
  source_import: "Source Import",
  actions_runner_registration: "Actions Runner Registration",
  scim: "SCIM",
  dependency_snapshots: "Dependency Snapshots",
  code_search: "Code Search",
};

export function normalizeGitHubUsageLimits(
  raw: unknown,
  checkedAt: string,
): ServerUsageLimitsSnapshot {
  const root = asObject(raw);
  const resources = asObject(root?.resources);
  const buckets: ServerUsageLimitBucket[] = [];

  if (resources) {
    for (const [id, value] of Object.entries(resources)) {
      const bucket = toBucket(id, GITHUB_RATE_LIMIT_LABELS[id] ?? titleCaseLimitId(id), value);
      if (bucket) {
        buckets.push(bucket);
      }
    }
  }

  if (buckets.length === 0) {
    const fallback = toBucket("core", "REST API", root?.rate);
    if (fallback) {
      buckets.push(fallback);
    }
  }

  return {
    source: "github",
    available: buckets.length > 0,
    checkedAt,
    ...(buckets.length === 0
      ? { message: "GitHub CLI did not return any rate-limit resources." }
      : {}),
    buckets,
  };
}
