import { Schema } from "effect";
import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";
import { KeybindingRule, ResolvedKeybindingsConfig } from "./keybindings";
import { EditorId } from "./editor";
import { ModelCapabilities } from "./model";
import { ProviderKind } from "./orchestration";
import { ProviderSubscription, ServerSettings } from "./settings";

const KeybindingsMalformedConfigIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.malformed-config"),
  message: TrimmedNonEmptyString,
});

const KeybindingsInvalidEntryIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.invalid-entry"),
  message: TrimmedNonEmptyString,
  index: Schema.Number,
});

export const ServerConfigIssue = Schema.Union([
  KeybindingsMalformedConfigIssue,
  KeybindingsInvalidEntryIssue,
]);
export type ServerConfigIssue = typeof ServerConfigIssue.Type;

const ServerConfigIssues = Schema.Array(ServerConfigIssue);

export const ServerProviderState = Schema.Literals(["ready", "warning", "error", "disabled"]);
export type ServerProviderState = typeof ServerProviderState.Type;

export const ServerProviderAuthStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type ServerProviderAuthStatus = typeof ServerProviderAuthStatus.Type;

export const ServerProviderModel = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  isCustom: Schema.Boolean,
  capabilities: Schema.NullOr(ModelCapabilities),
});
export type ServerProviderModel = typeof ServerProviderModel.Type;

export const ServerUsageLimitBucket = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  limit: Schema.optional(NonNegativeInt),
  remaining: Schema.optional(NonNegativeInt),
  used: Schema.optional(NonNegativeInt),
  usedPercent: Schema.optional(Schema.Number),
  resetsAt: Schema.optional(IsoDateTime),
  windowDurationMins: Schema.optional(NonNegativeInt),
});
export type ServerUsageLimitBucket = typeof ServerUsageLimitBucket.Type;

export const ServerUsageLimitSource = Schema.Literals(["codex", "github"]);
export type ServerUsageLimitSource = typeof ServerUsageLimitSource.Type;

export const ServerUsageLimitsSnapshot = Schema.Struct({
  source: ServerUsageLimitSource,
  available: Schema.Boolean,
  checkedAt: IsoDateTime,
  message: Schema.optional(TrimmedNonEmptyString),
  buckets: Schema.Array(ServerUsageLimitBucket),
});
export type ServerUsageLimitsSnapshot = typeof ServerUsageLimitsSnapshot.Type;

export const ServerUsageLimits = Schema.Struct({
  codex: ServerUsageLimitsSnapshot,
  github: ServerUsageLimitsSnapshot,
});
export type ServerUsageLimits = typeof ServerUsageLimits.Type;

export const ServerProvider = Schema.Struct({
  provider: ProviderKind,
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  version: Schema.NullOr(TrimmedNonEmptyString),
  status: ServerProviderState,
  authStatus: ServerProviderAuthStatus,
  checkedAt: IsoDateTime,
  message: Schema.optional(TrimmedNonEmptyString),
  models: Schema.Array(ServerProviderModel),
});
export type ServerProvider = typeof ServerProvider.Type;

const ServerProviders = Schema.Array(ServerProvider);

export const ServerConfig = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  keybindingsConfigPath: TrimmedNonEmptyString,
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
  providers: ServerProviders,
  availableEditors: Schema.Array(EditorId),
  settings: ServerSettings,
});
export type ServerConfig = typeof ServerConfig.Type;

export const ServerUpsertKeybindingInput = KeybindingRule;
export type ServerUpsertKeybindingInput = typeof ServerUpsertKeybindingInput.Type;

export const ServerUpsertKeybindingResult = Schema.Struct({
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
});
export type ServerUpsertKeybindingResult = typeof ServerUpsertKeybindingResult.Type;

export const ServerConfigUpdatedPayload = Schema.Struct({
  issues: ServerConfigIssues,
  settings: Schema.optional(ServerSettings),
});
export type ServerConfigUpdatedPayload = typeof ServerConfigUpdatedPayload.Type;

export const ServerUsageLimitsPayload = ServerUsageLimits;
export type ServerUsageLimitsPayload = typeof ServerUsageLimitsPayload.Type;

export const ServerProviderUpdatedPayload = Schema.Struct({
  providers: ServerProviders,
});
export type ServerProviderUpdatedPayload = typeof ServerProviderUpdatedPayload.Type;

export const ServerLogToastInput = Schema.Struct({
  createdAt: IsoDateTime,
  position: TrimmedNonEmptyString,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  type: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.optional(ThreadId),
  stackTrace: Schema.String,
});
export type ServerLogToastInput = typeof ServerLogToastInput.Type;

export const ServerCreateProviderSubscriptionInput = Schema.Struct({
  provider: ProviderKind,
  name: Schema.optional(TrimmedNonEmptyString),
});
export type ServerCreateProviderSubscriptionInput =
  typeof ServerCreateProviderSubscriptionInput.Type;

export const ServerCreateProviderSubscriptionResult = Schema.Struct({
  subscription: ProviderSubscription,
  settings: ServerSettings,
});
export type ServerCreateProviderSubscriptionResult =
  typeof ServerCreateProviderSubscriptionResult.Type;
