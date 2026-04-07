import { spawn } from "node:child_process";
import { extname } from "node:path";

import type {
  ProviderKind,
  ProviderSubscription,
  ServerCreateProviderSubscriptionInput,
  ServerCreateProviderSubscriptionResult,
  ServerSettings,
} from "@t3tools/contracts";
import { Effect, FileSystem, Path, Schema } from "effect";

import { ServerConfig } from "../config";
import { ServerSettingsError, ServerSettingsService } from "../serverSettings";
import {
  normalizeCopilotCliPathOverride,
  resolveBundledCopilotCliPath,
} from "./Layers/copilotCliPath";

export class ProviderSubscriptionProvisioningError extends Schema.TaggedErrorClass<ProviderSubscriptionProvisioningError>()(
  "ProviderSubscriptionProvisioningError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

function slugifySegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function makeSubscriptionId(provider: ProviderKind, name: string): string {
  const normalized = slugifySegment(name);
  return `${provider}-${normalized || "account"}-${Date.now().toString(36)}`;
}

function getSubscriptions(
  settings: ServerSettings,
  provider: ProviderKind,
): ReadonlyArray<ProviderSubscription> {
  switch (provider) {
    case "codex":
      return settings.providers.codex.subscriptions;
    case "claudeAgent":
      return settings.providers.claudeAgent.subscriptions;
    case "copilot":
      return settings.providers.copilot.subscriptions;
  }
}

function getProviderBinaryPath(settings: ServerSettings, provider: ProviderKind): string {
  switch (provider) {
    case "codex":
      return settings.providers.codex.binaryPath;
    case "claudeAgent":
      return settings.providers.claudeAgent.binaryPath;
    case "copilot":
      return (
        normalizeCopilotCliPathOverride(settings.providers.copilot.binaryPath) ??
        resolveBundledCopilotCliPath() ??
        "copilot"
      );
  }
}

function isNodeScriptPath(command: string): boolean {
  const extension = extname(command).toLowerCase();
  return extension === ".js" || extension === ".mjs" || extension === ".cjs";
}

export function buildLoginLaunch(
  provider: ProviderKind,
  settings: ServerSettings,
  configPath: string,
): {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: boolean;
} {
  const binaryPath = getProviderBinaryPath(settings, provider);
  let command = binaryPath;
  let args: ReadonlyArray<string>;
  const env: NodeJS.ProcessEnv = { ...process.env };

  switch (provider) {
    case "codex":
      args = ["login", "--device-auth"];
      env.CODEX_HOME = configPath;
      break;
    case "claudeAgent":
      args = ["auth", "login"];
      env.CLAUDE_CONFIG_DIR = configPath;
      break;
    case "copilot":
      args = ["login", "--config-dir", configPath];
      env.COPILOT_HOME = configPath;
      break;
  }

  if (isNodeScriptPath(binaryPath)) {
    command = process.execPath;
    args = [binaryPath, ...args];
  }

  return {
    command,
    args,
    env,
    shell: process.platform === "win32" && command !== process.execPath,
  };
}

function buildUpdatedSettings(
  settings: ServerSettings,
  provider: ProviderKind,
  subscriptions: ReadonlyArray<ProviderSubscription>,
): ServerSettings {
  switch (provider) {
    case "codex":
      return {
        ...settings,
        providers: {
          ...settings.providers,
          codex: {
            ...settings.providers.codex,
            subscriptions: [...subscriptions],
          },
        },
      };
    case "claudeAgent":
      return {
        ...settings,
        providers: {
          ...settings.providers,
          claudeAgent: {
            ...settings.providers.claudeAgent,
            subscriptions: [...subscriptions],
          },
        },
      };
    case "copilot":
      return {
        ...settings,
        providers: {
          ...settings.providers,
          copilot: {
            ...settings.providers.copilot,
            subscriptions: [...subscriptions],
          },
        },
      };
  }
}

function toSubscriptionPatch(subscriptions: ReadonlyArray<ProviderSubscription>): Array<{
  readonly id: string;
  readonly name: string;
  readonly configPath: string;
  readonly priority: number;
  readonly isActive: boolean;
  readonly rateLimitedUntil?: number;
}> {
  return subscriptions.map((subscription) => ({
    id: subscription.id,
    name: subscription.name,
    configPath: subscription.configPath,
    priority: subscription.priority,
    isActive: subscription.isActive,
    ...(subscription.rateLimitedUntil !== undefined
      ? { rateLimitedUntil: subscription.rateLimitedUntil }
      : {}),
  }));
}

export const createProviderSubscriptionAndStartLogin = (
  input: ServerCreateProviderSubscriptionInput,
): Effect.Effect<
  ServerCreateProviderSubscriptionResult,
  ProviderSubscriptionProvisioningError | ServerSettingsError,
  FileSystem.FileSystem | Path.Path | ServerConfig | ServerSettingsService
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const serverSettings = yield* ServerSettingsService;
    const settings = yield* serverSettings.getSettings;
    const providerSubscriptions = getSubscriptions(settings, input.provider);
    const nextIndex = providerSubscriptions.length + 1;
    const baseName = input.name?.trim() || `Account ${nextIndex}`;
    const baseSlug = slugifySegment(baseName) || `account-${nextIndex}`;
    const subscriptionsRoot = path.join(serverConfig.stateDir, "provider-accounts", input.provider);

    let candidateSlug = baseSlug;
    let candidatePath = path.join(subscriptionsRoot, candidateSlug);
    let suffix = 2;
    const existingPaths = new Set(
      providerSubscriptions.map((subscription) => subscription.configPath),
    );
    while (existingPaths.has(candidatePath)) {
      candidateSlug = `${baseSlug}-${suffix}`;
      candidatePath = path.join(subscriptionsRoot, candidateSlug);
      suffix += 1;
    }

    yield* fileSystem.makeDirectory(candidatePath, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderSubscriptionProvisioningError({
            message: `Failed to prepare provider account directory '${candidatePath}'.`,
            cause,
          }),
      ),
    );

    const subscription: ProviderSubscription = {
      id: makeSubscriptionId(input.provider, baseName),
      name: baseName,
      configPath: candidatePath,
      priority: providerSubscriptions.length,
      isActive: false,
    };

    const nextSettings = buildUpdatedSettings(settings, input.provider, [
      ...providerSubscriptions,
      subscription,
    ]);
    const nextSubscriptionsPatch = toSubscriptionPatch(
      getSubscriptions(nextSettings, input.provider),
    );
    const persistedSettings = yield* serverSettings.updateSettings({
      providers:
        input.provider === "codex"
          ? {
              codex: {
                subscriptions: nextSubscriptionsPatch,
              },
            }
          : input.provider === "claudeAgent"
            ? {
                claudeAgent: {
                  subscriptions: nextSubscriptionsPatch,
                },
              }
            : {
                copilot: {
                  subscriptions: nextSubscriptionsPatch,
                },
              },
    });

    const launch = buildLoginLaunch(input.provider, persistedSettings, candidatePath);
    yield* Effect.try({
      try: () => {
        const child = spawn(launch.command, [...launch.args], {
          detached: true,
          stdio: "ignore",
          shell: launch.shell,
          env: launch.env,
        });
        child.unref();
      },
      catch: (cause) =>
        new ProviderSubscriptionProvisioningError({
          message: `Failed to start ${input.provider} login flow.`,
          cause,
        }),
    });

    return {
      subscription,
      settings: persistedSettings,
    };
  });
