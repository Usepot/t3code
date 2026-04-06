/**
 * SubscriptionManager - Service for managing provider subscriptions and automatic failover.
 *
 * Handles:
 * - Tracking active subscription per provider
 * - Detecting rate limit events and marking subscriptions
 * - Selecting next available subscription based on priority
 * - Coordinating subscription switches
 *
 * @module SubscriptionManager
 */
import type { ProviderKind, ProviderSubscription } from "@t3tools/contracts";
import { DEFAULT_RATE_LIMIT_COOLDOWN_MS } from "@t3tools/contracts";
import { Effect, Layer, ServiceMap, Stream } from "effect";
import type { Effect as EffectType, Stream as StreamType } from "effect";

import type { ServerSettingsError } from "../../serverSettings";

/**
 * Event emitted when a subscription switch occurs
 */
export interface SubscriptionSwitchEvent {
  readonly provider: ProviderKind;
  readonly previousSubscriptionId: string | undefined;
  readonly newSubscriptionId: string;
  readonly reason: "rate_limit" | "manual" | "initial";
}

/**
 * Event emitted when a subscription's rate limit status changes
 */
export interface SubscriptionRateLimitEvent {
  readonly provider: ProviderKind;
  readonly subscriptionId: string;
  readonly rateLimitedUntil: number;
}

/**
 * Result of subscription selection
 */
export interface SubscriptionSelectionResult {
  readonly subscription: ProviderSubscription;
  readonly allRateLimited: boolean;
}

/**
 * SubscriptionManagerShape - Service API for subscription management.
 */
export interface SubscriptionManagerShape {
  /**
   * Get the currently active subscription for a provider.
   * Returns undefined if no subscriptions are configured.
   */
  readonly getActiveSubscription: (
    provider: ProviderKind,
  ) => EffectType.Effect<ProviderSubscription | undefined, ServerSettingsError>;

  /**
   * Select the best available subscription for a provider.
   * Uses priority-based selection, skipping rate-limited subscriptions.
   * If all subscriptions are rate-limited, returns the one with earliest expiry.
   */
  readonly selectSubscription: (
    provider: ProviderKind,
  ) => EffectType.Effect<SubscriptionSelectionResult | undefined, ServerSettingsError>;

  /**
   * Mark a subscription as rate-limited.
   * Sets rateLimitedUntil to now + cooldownMs and triggers switch if needed.
   */
  readonly markRateLimited: (
    provider: ProviderKind,
    subscriptionId: string,
    cooldownMs?: number,
  ) => EffectType.Effect<void>;

  /**
   * Clear rate limit status for a subscription.
   */
  readonly clearRateLimit: (
    provider: ProviderKind,
    subscriptionId: string,
  ) => EffectType.Effect<void>;

  /**
   * Manually switch to a specific subscription.
   */
  readonly switchSubscription: (
    provider: ProviderKind,
    subscriptionId: string,
  ) => EffectType.Effect<void>;

  /**
   * Handle rate limit event from a provider adapter.
   * Marks current subscription as rate-limited and triggers automatic switch.
   */
  readonly handleRateLimitEvent: (
    provider: ProviderKind,
    rateLimitInfo?: unknown,
  ) => EffectType.Effect<SubscriptionSwitchEvent | undefined, ServerSettingsError>;

  /**
   * Stream of subscription switch events.
   */
  readonly streamSwitchEvents: StreamType.Stream<SubscriptionSwitchEvent>;

  /**
   * Stream of rate limit events.
   */
  readonly streamRateLimitEvents: StreamType.Stream<SubscriptionRateLimitEvent>;

  /**
   * Get all subscriptions for a provider with their current status.
   */
  readonly getSubscriptions: (
    provider: ProviderKind,
  ) => EffectType.Effect<ReadonlyArray<ProviderSubscription>, ServerSettingsError>;

  /**
   * Get the effective config path for a provider.
   * Returns active subscription's configPath, or legacy setting path if no subscriptions.
   */
  readonly getEffectiveConfigPath: (
    provider: ProviderKind,
  ) => EffectType.Effect<string | undefined, ServerSettingsError>;
}

/**
 * SubscriptionManager - Service tag for subscription management.
 */
export class SubscriptionManager extends ServiceMap.Service<
  SubscriptionManager,
  SubscriptionManagerShape
>()("t3/provider/Services/SubscriptionManager") {
  static readonly layerTest = (options?: {
    readonly activeSubscriptions?: Partial<Record<ProviderKind, ProviderSubscription>>;
  }) =>
    Layer.succeed(SubscriptionManager, {
      getActiveSubscription: (provider) =>
        Effect.succeed(options?.activeSubscriptions?.[provider] ?? undefined),
      selectSubscription: (provider) =>
        Effect.succeed(
          options?.activeSubscriptions?.[provider]
            ? {
                subscription: options.activeSubscriptions[provider],
                allRateLimited: false,
              }
            : undefined,
        ),
      markRateLimited: () => Effect.void,
      clearRateLimit: () => Effect.void,
      switchSubscription: () => Effect.void,
      handleRateLimitEvent: () => Effect.succeed(undefined),
      streamSwitchEvents: Stream.empty,
      streamRateLimitEvents: Stream.empty,
      getSubscriptions: (provider) =>
        Effect.succeed(
          options?.activeSubscriptions?.[provider]
            ? [options.activeSubscriptions[provider]]
            : ([] as ReadonlyArray<ProviderSubscription>),
        ),
      getEffectiveConfigPath: (provider) =>
        Effect.succeed(options?.activeSubscriptions?.[provider]?.configPath),
    } satisfies SubscriptionManagerShape);
}

/**
 * Helper function to select the best subscription from a list.
 * Priority-based selection, skipping rate-limited subscriptions.
 */
export function selectBestSubscription(
  subscriptions: ReadonlyArray<ProviderSubscription>,
): SubscriptionSelectionResult | undefined {
  if (subscriptions.length === 0) {
    return undefined;
  }

  const now = Date.now();
  const sorted = subscriptions.toSorted((a, b) => a.priority - b.priority);

  // Find first non-rate-limited subscription
  const available = sorted.find((s) => !s.rateLimitedUntil || s.rateLimitedUntil < now);

  if (available) {
    return { subscription: available, allRateLimited: false };
  }

  // All rate-limited: return the one with earliest expiry
  const earliest = sorted.reduce<ProviderSubscription>((min, s) => {
    const minExpiry = min.rateLimitedUntil ?? Infinity;
    const sExpiry = s.rateLimitedUntil ?? Infinity;
    return sExpiry < minExpiry ? s : min;
  }, sorted[0]!);

  return { subscription: earliest, allRateLimited: true };
}

/**
 * Default rate limit cooldown period
 */
export { DEFAULT_RATE_LIMIT_COOLDOWN_MS };
