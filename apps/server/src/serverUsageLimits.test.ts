import { describe, expect, it } from "vitest";

import {
  createUnavailableUsageSnapshot,
  normalizeCodexUsageLimits,
  normalizeGitHubUsageLimits,
} from "./serverUsageLimits";

describe("serverUsageLimits", () => {
  it("normalizes Codex multi-bucket rate limits", () => {
    const snapshot = normalizeCodexUsageLimits(
      {
        rateLimitsByLimitId: {
          codex: {
            usedPercent: 42,
            windowDurationMins: 10080,
            resetsAt: 1_775_526_400,
          },
        },
      },
      "2026-04-06T00:00:00.000Z",
    );

    expect(snapshot).toEqual({
      source: "codex",
      available: true,
      checkedAt: "2026-04-06T00:00:00.000Z",
      buckets: [
        {
          id: "codex",
          label: "Codex",
          usedPercent: 42,
          windowDurationMins: 10080,
          resetsAt: "2026-04-10T18:00:00.000Z",
        },
      ],
    });
  });

  it("normalizes GitHub resource rate limits", () => {
    const snapshot = normalizeGitHubUsageLimits(
      {
        resources: {
          core: {
            limit: 5000,
            remaining: 4975,
            used: 25,
            reset: 1_775_526_400,
          },
          graphql: {
            limit: 5000,
            remaining: 4990,
            used: 10,
            reset: 1_775_526_400,
          },
        },
      },
      "2026-04-06T00:00:00.000Z",
    );

    expect(snapshot).toEqual({
      source: "github",
      available: true,
      checkedAt: "2026-04-06T00:00:00.000Z",
      buckets: [
        {
          id: "core",
          label: "REST API",
          limit: 5000,
          remaining: 4975,
          used: 25,
          resetsAt: "2026-04-10T18:00:00.000Z",
        },
        {
          id: "graphql",
          label: "GraphQL API",
          limit: 5000,
          remaining: 4990,
          used: 10,
          resetsAt: "2026-04-10T18:00:00.000Z",
        },
      ],
    });
  });

  it("creates unavailable snapshots", () => {
    expect(
      createUnavailableUsageSnapshot({
        source: "github",
        checkedAt: "2026-04-06T00:00:00.000Z",
        message: "GitHub CLI is not authenticated.",
      }),
    ).toEqual({
      source: "github",
      available: false,
      checkedAt: "2026-04-06T00:00:00.000Z",
      message: "GitHub CLI is not authenticated.",
      buckets: [],
    });
  });
});
