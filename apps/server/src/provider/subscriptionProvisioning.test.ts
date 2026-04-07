import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";

import { buildLoginLaunch } from "./subscriptionProvisioning";

function makeSettings(): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      codex: {
        ...DEFAULT_SERVER_SETTINGS.providers.codex,
        binaryPath: "codex",
      },
    },
  };
}

describe("buildLoginLaunch", () => {
  it("uses device auth for codex subscription sign-in flows", () => {
    const launch = buildLoginLaunch("codex", makeSettings(), "/tmp/codex-subscription");

    expect(launch.command).toBe("codex");
    expect(launch.args).toEqual(["login", "--device-auth"]);
    expect(launch.env.CODEX_HOME).toBe("/tmp/codex-subscription");
  });
});
