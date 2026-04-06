/**
 * SubscriptionManagerLive - Layer implementation for SubscriptionManager service.
 *
 * Manages provider subscriptions with automatic rate limit failover.
 *
 * @module SubscriptionManagerLive
 */
import type { ProviderKind, ProviderSubscription, ServerSettings } from "@t3tools/contracts";
import { DEFAULT_RATE_LIMIT_COOLDOWN_MS } from "@t3tools/contracts";
import { Effect, Layer, PubSub, Ref, Stream } from "effect";

import { ServerSettingsError, ServerSettingsService } from "../../serverSettings";
import {
  SubscriptionManager,
  type SubscriptionManagerShape,
  type SubscriptionRateLimitEvent,
  selectBestSubscription,
  type SubscriptionSwitchEvent,
} from "../Services/SubscriptionManager";

type ProviderSubscriptionMap = Map<ProviderKind, string | undefined>;

const makeRateLimitKey = (provider: ProviderKind, subscriptionId: string) =>
  `${provider}:${subscriptionId}`;

function getProviderSubscriptions(
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
    default:
      return [];
  }
}

function getLegacyConfigPath(settings: ServerSettings, provider: ProviderKind): string | undefined {
  switch (provider) {
    case "codex":
      return settings.providers.codex.homePath || undefined;
    case "claudeAgent":
      return undefined; // Claude doesn't have a configurable home path yet
    case "copilot":
      return settings.providers.copilot.configDir || undefined;
    default:
      return undefined;
  }
}

export const SubscriptionManagerLive = Layer.effect(
  SubscriptionManager,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;

    // Track active subscription ID per provider (in-memory, not persisted)
    const activeSubscriptionsRef = yield* Ref.make<ProviderSubscriptionMap>(new Map());

    // Track rate limit status per subscription (subscriptionId -> rateLimitedUntil)
    const rateLimitsRef = yield* Ref.make<Map<string, number>>(new Map());

    // PubSub for subscription switch events
    const switchEventsPubSub = yield* PubSub.unbounded<SubscriptionSwitchEvent>();

    // PubSub for rate limit events
    const rateLimitEventsPubSub = yield* PubSub.unbounded<SubscriptionRateLimitEvent>();

    // Helper to get subscriptions with current rate limit status merged
    const getSubscriptionsWithStatus = (
      provider: ProviderKind,
    ): Effect.Effect<ReadonlyArray<ProviderSubscription>, ServerSettingsError> =>
      Effect.gen(function* () {
        const settings = yield* serverSettings.getSettings;
        const subscriptions = getProviderSubscriptions(settings, provider);
        const rateLimits = yield* Ref.get(rateLimitsRef);
        const activeMap = yield* Ref.get(activeSubscriptionsRef);
        const activeId = activeMap.get(provider);

        return subscriptions.map((sub) =>
          Object.assign({}, sub, {
            rateLimitedUntil:
              rateLimits.get(makeRateLimitKey(provider, sub.id)) ?? sub.rateLimitedUntil,
            isActive: sub.id === activeId,
          }),
        );
      });

    const service: SubscriptionManagerShape = {
      getActiveSubscription: (provider) =>
        Effect.gen(function* () {
          const activeMap = yield* Ref.get(activeSubscriptionsRef);
          const activeId = activeMap.get(provider);
          const subscriptions = yield* getSubscriptionsWithStatus(provider);

          if (activeId) {
            return subscriptions.find((s) => s.id === activeId);
          }

          // No active subscription set - select the best one
          const result = selectBestSubscription(subscriptions);
          if (result) {
            yield* Ref.update(activeSubscriptionsRef, (map) => {
              const newMap = new Map(map);
              newMap.set(provider, result.subscription.id);
              return newMap;
            });
            return result.subscription;
          }

          return undefined;
        }),

      selectSubscription: (provider) =>
        Effect.gen(function* () {
          const subscriptions = yield* getSubscriptionsWithStatus(provider);
          return selectBestSubscription(subscriptions);
        }),

      markRateLimited: (provider, subscriptionId, cooldownMs = DEFAULT_RATE_LIMIT_COOLDOWN_MS) =>
        Effect.gen(function* () {
          const rateLimitedUntil = Date.now() + cooldownMs;
          const key = makeRateLimitKey(provider, subscriptionId);

          yield* Ref.update(rateLimitsRef, (map) => {
            const newMap = new Map(map);
            newMap.set(key, rateLimitedUntil);
            return newMap;
          });

          // Emit rate limit event
          yield* PubSub.publish(rateLimitEventsPubSub, {
            provider,
            subscriptionId,
            rateLimitedUntil,
          });
        }),

      clearRateLimit: (provider, subscriptionId) =>
        Effect.gen(function* () {
          const key = makeRateLimitKey(provider, subscriptionId);
          yield* Ref.update(rateLimitsRef, (map) => {
            const newMap = new Map(map);
            newMap.delete(key);
            return newMap;
          });
        }),

      switchSubscription: (provider, subscriptionId) =>
        Effect.gen(function* () {
          const activeMap = yield* Ref.get(activeSubscriptionsRef);
          const previousId = activeMap.get(provider);

          yield* Ref.update(activeSubscriptionsRef, (map) => {
            const newMap = new Map(map);
            newMap.set(provider, subscriptionId);
            return newMap;
          });

          yield* PubSub.publish(switchEventsPubSub, {
            provider,
            previousSubscriptionId: previousId,
            newSubscriptionId: subscriptionId,
            reason: "manual" as const,
          });
        }),

      handleRateLimitEvent: (provider, _rateLimitInfo) =>
        Effect.gen(function* () {
          const activeMap = yield* Ref.get(activeSubscriptionsRef);
          const currentId = activeMap.get(provider);

          if (!currentId) {
            // No active subscription to mark
            return undefined;
          }

          // Mark current subscription as rate limited
          yield* service.markRateLimited(provider, currentId);

          // Select next best subscription
          const subscriptions = yield* getSubscriptionsWithStatus(provider);
          const result = selectBestSubscription(subscriptions);

          if (!result || result.subscription.id === currentId) {
            // No alternative available or same subscription (all rate-limited)
            return undefined;
          }

          // Switch to the new subscription
          yield* Ref.update(activeSubscriptionsRef, (map) => {
            const newMap = new Map(map);
            newMap.set(provider, result.subscription.id);
            return newMap;
          });

          const switchEvent: SubscriptionSwitchEvent = {
            provider,
            previousSubscriptionId: currentId,
            newSubscriptionId: result.subscription.id,
            reason: "rate_limit",
          };

          yield* PubSub.publish(switchEventsPubSub, switchEvent);

          return switchEvent;
        }),

      streamSwitchEvents: Stream.fromPubSub(switchEventsPubSub),

      streamRateLimitEvents: Stream.fromPubSub(rateLimitEventsPubSub),

      getSubscriptions: getSubscriptionsWithStatus,

      getEffectiveConfigPath: (provider) =>
        Effect.gen(function* () {
          const settings = yield* serverSettings.getSettings;
          const subscriptions = getProviderSubscriptions(settings, provider);

          if (subscriptions.length === 0) {
            // No subscriptions configured - use legacy config path
            return getLegacyConfigPath(settings, provider);
          }

          // Get active subscription's config path
          const active = yield* service.getActiveSubscription(provider);
          return active?.configPath;
        }),
    };

    return service;
  }),
);
