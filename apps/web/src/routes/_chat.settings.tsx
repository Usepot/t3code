import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDownIcon,
  InfoIcon,
  LoaderIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ProviderSubscription,
  type ServerProvider,
  type ServerProviderModel,
  type ServerUsageLimitBucket,
  type ServerUsageLimitsSnapshot,
} from "@t3tools/contracts";
import { buildModelSelection, normalizeModelSlug } from "@t3tools/shared/model";
import { useSettings, useUpdateSettings } from "../hooks/useSettings";
import {
  getCustomModelOptionsByProvider,
  MAX_CUSTOM_MODEL_LENGTH,
  resolveAppModelSelectionState,
} from "../modelSelection";
import { APP_VERSION } from "../branding";
import { Button } from "../components/ui/button";
import { Collapsible, CollapsibleContent } from "../components/ui/collapsible";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { SidebarTrigger } from "../components/ui/sidebar";
import { Switch } from "../components/ui/switch";
import { ProviderModelPicker } from "../components/chat/ProviderModelPicker";
import { TraitsPicker } from "../components/chat/TraitsPicker";
import { SidebarInset } from "../components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { resolveAndPersistPreferredEditor } from "../editorPreferences";
import { isElectron } from "../env";
import { useTheme } from "../hooks/useTheme";
import {
  serverConfigQueryOptions,
  serverQueryKeys,
  serverUsageLimitsQueryOptions,
} from "../lib/serverReactQuery";
import { cn } from "../lib/utils";
import { formatRelativeTime } from "../timestampFormat";
import { ensureNativeApi, readNativeApi } from "../nativeApi";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { Equal } from "effect";

const THEME_OPTIONS = [
  {
    value: "system",
    label: "System",
    description: "Match your OS appearance setting.",
  },
  {
    value: "light",
    label: "Light",
    description: "Always use the light theme.",
  },
  {
    value: "dark",
    label: "Dark",
    description: "Always use the dark theme.",
  },
] as const;

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

const EMPTY_SERVER_PROVIDERS: ReadonlyArray<ServerProvider> = [];

type InstallProviderSettings = {
  provider: ProviderKind;
  title: string;
  binaryPlaceholder: string;
  binaryDescription: ReactNode;
  secondaryField?: {
    key: "homePath" | "configDir";
    label: string;
    placeholder: string;
    description?: ReactNode;
  };
};

const PROVIDER_SETTINGS: readonly InstallProviderSettings[] = [
  {
    provider: "codex",
    title: "Codex",
    binaryPlaceholder: "Codex binary path",
    binaryDescription: "Path to the Codex binary",
    secondaryField: {
      key: "homePath",
      label: "CODEX_HOME path",
      placeholder: "CODEX_HOME",
      description: "Optional custom Codex home and config directory.",
    },
  },
  {
    provider: "claudeAgent",
    title: "Claude",
    binaryPlaceholder: "Claude binary path",
    binaryDescription: "Path to the Claude binary",
  },
  {
    provider: "copilot",
    title: "Copilot",
    binaryPlaceholder: "Copilot binary path",
    binaryDescription: "Optional path to the GitHub Copilot CLI binary.",
    secondaryField: {
      key: "configDir",
      label: "Config directory",
      placeholder: "~/.config/github-copilot",
      description: "Optional custom GitHub Copilot config and state directory.",
    },
  },
];

const PROVIDER_STATUS_STYLES = {
  disabled: {
    dot: "bg-amber-400",
    badge: "warning" as const,
  },
  error: {
    dot: "bg-destructive",
    badge: "error" as const,
  },
  ready: {
    dot: "bg-success",
    badge: "success" as const,
  },
  warning: {
    dot: "bg-warning",
    badge: "warning" as const,
  },
} as const;

function getProviderSummary(provider: ServerProvider | undefined): {
  readonly headline: string;
  readonly detail: string | null;
} {
  if (!provider) {
    return {
      headline: "Checking provider status",
      detail: "Waiting for the server to report installation and authentication details.",
    };
  }
  if (!provider.enabled) {
    return {
      headline: "Disabled",
      detail:
        provider.message ?? "This provider is installed but disabled for new sessions in T3 Code.",
    };
  }
  if (!provider.installed) {
    return {
      headline: "Not found",
      detail: provider.message ?? "CLI not detected on PATH.",
    };
  }
  if (provider.authStatus === "authenticated") {
    return {
      headline: "Authenticated",
      detail: provider.message ?? null,
    };
  }
  if (provider.authStatus === "unauthenticated") {
    return {
      headline: "Not authenticated",
      detail: provider.message ?? null,
    };
  }
  if (provider.status === "warning") {
    return {
      headline: "Needs attention",
      detail:
        provider.message ?? "The provider is installed, but the server could not fully verify it.",
    };
  }
  if (provider.status === "error") {
    return {
      headline: "Unavailable",
      detail: provider.message ?? "The provider failed its startup checks.",
    };
  }
  return {
    headline: "Available",
    detail: provider.message ?? "Installed and ready, but authentication could not be verified.",
  };
}

function getProviderVersionLabel(version: string | null | undefined): string | null {
  if (!version) return null;
  return version.startsWith("v") ? version : `v${version}`;
}

function formatUsageBucketHeadline(bucket: ServerUsageLimitBucket): string {
  if (bucket.used !== undefined && bucket.limit !== undefined && bucket.remaining !== undefined) {
    return `${bucket.used}/${bucket.limit} used, ${bucket.remaining} remaining`;
  }
  if (bucket.used !== undefined && bucket.limit !== undefined) {
    return `${bucket.used}/${bucket.limit} used`;
  }
  if (bucket.usedPercent !== undefined) {
    return `${Math.round(bucket.usedPercent)}% used`;
  }
  return "Usage data available";
}

function formatUsageBucketDetail(bucket: ServerUsageLimitBucket): string | null {
  const parts: string[] = [];
  if (bucket.resetsAt) {
    parts.push(`Resets ${new Date(bucket.resetsAt).toLocaleString()}`);
  }
  if (bucket.windowDurationMins !== undefined) {
    parts.push(`${bucket.windowDurationMins} minute window`);
  }
  return parts.length > 0 ? parts.join(" | ") : null;
}

function getUsageSnapshotSummary(snapshot: ServerUsageLimitsSnapshot): {
  readonly headline: string;
  readonly detail: string | null;
} {
  if (!snapshot.available) {
    return {
      headline: "Unavailable",
      detail: snapshot.message ?? "No usage-limit data is available right now.",
    };
  }

  if (snapshot.buckets.length === 0) {
    return {
      headline: "No buckets reported",
      detail: snapshot.message ?? null,
    };
  }

  const highestUsageBucket = snapshot.buckets.toSorted(
    (left, right) => (right.usedPercent ?? -1) - (left.usedPercent ?? -1),
  )[0];
  if (!highestUsageBucket) {
    return {
      headline: "Available",
      detail: snapshot.message ?? null,
    };
  }

  return {
    headline: highestUsageBucket.label,
    detail: formatUsageBucketHeadline(highestUsageBucket),
  };
}

/** Returns a timestamp that updates on an interval, forcing re-renders to keep relative times fresh. */
function useRelativeTimeTick(intervalMs = 1_000): number {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return tick;
}

function SettingsSection({
  title,
  headerAction,
  children,
}: {
  title: string;
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {title}
        </h2>
        {headerAction}
      </div>
      <div className="relative overflow-hidden rounded-2xl border bg-card not-dark:bg-clip-padding text-card-foreground shadow-xs/5 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]">
        {children}
      </div>
    </section>
  );
}

function SettingsRow({
  title,
  description,
  status,
  resetAction,
  control,
  children,
}: {
  title: string;
  description: string;
  status?: ReactNode;
  resetAction?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      className="border-t border-border px-4 py-4 first:border-t-0 sm:px-5"
      data-slot="settings-row"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="text-sm font-medium text-foreground">{title}</h3>
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
              {resetAction}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{description}</p>
          {status ? <div className="pt-1 text-[11px] text-muted-foreground">{status}</div> : null}
        </div>
        {control ? (
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            {control}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function makeSubscriptionId(provider: ProviderKind, name: string, index: number): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${provider}-${normalized || `account-${index + 1}`}-${Date.now().toString(36)}`;
}

function makeDefaultSubscription(provider: ProviderKind, index: number): ProviderSubscription {
  return {
    id: makeSubscriptionId(provider, "", index),
    name: `Account ${index + 1}`,
    configPath: "",
    priority: index,
    isActive: false,
  };
}

function SettingResetButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Reset ${label} to default`}
            className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
          >
            <Undo2Icon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup side="top">Reset to default</TooltipPopup>
    </Tooltip>
  );
}

function SettingsRouteView() {
  const { theme, setTheme } = useTheme();
  const settings = useSettings();
  const { updateSettings, resetSettings } = useUpdateSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const serverUsageLimitsQuery = useQuery(serverUsageLimitsQueryOptions());
  const [isOpeningKeybindings, setIsOpeningKeybindings] = useState(false);
  const [openKeybindingsError, setOpenKeybindingsError] = useState<string | null>(null);
  const [openProviderDetails, setOpenProviderDetails] = useState<Record<ProviderKind, boolean>>({
    codex: Boolean(
      settings.providers.codex.binaryPath !== DEFAULT_UNIFIED_SETTINGS.providers.codex.binaryPath ||
      settings.providers.codex.homePath !== DEFAULT_UNIFIED_SETTINGS.providers.codex.homePath ||
      settings.providers.codex.customModels.length > 0 ||
      settings.providers.codex.subscriptions.length > 0,
    ),
    claudeAgent: Boolean(
      settings.providers.claudeAgent.binaryPath !==
        DEFAULT_UNIFIED_SETTINGS.providers.claudeAgent.binaryPath ||
      settings.providers.claudeAgent.customModels.length > 0 ||
      settings.providers.claudeAgent.subscriptions.length > 0,
    ),
    copilot: Boolean(
      settings.providers.copilot.binaryPath !==
        DEFAULT_UNIFIED_SETTINGS.providers.copilot.binaryPath ||
      settings.providers.copilot.configDir !==
        DEFAULT_UNIFIED_SETTINGS.providers.copilot.configDir ||
      settings.providers.copilot.customModels.length > 0 ||
      settings.providers.copilot.subscriptions.length > 0,
    ),
  });
  const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
    Record<ProviderKind, string>
  >({
    codex: "",
    claudeAgent: "",
    copilot: "",
  });
  const [customModelErrorByProvider, setCustomModelErrorByProvider] = useState<
    Partial<Record<ProviderKind, string | null>>
  >({});
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const [isRefreshingUsageLimits, setIsRefreshingUsageLimits] = useState(false);
  const refreshingRef = useRef(false);
  const refreshingUsageLimitsRef = useRef(false);
  const queryClient = useQueryClient();
  useRelativeTimeTick();

  const refreshProviders = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshingProviders(true);
    const api = ensureNativeApi();
    api.server
      .refreshProviders()
      .then(() => queryClient.invalidateQueries({ queryKey: serverQueryKeys.config() }))
      .catch((error: unknown) => {
        console.warn("Failed to refresh providers", error);
      })
      .finally(() => {
        refreshingRef.current = false;
        setIsRefreshingProviders(false);
      });
  }, [queryClient]);

  const refreshUsageLimits = useCallback(() => {
    if (refreshingUsageLimitsRef.current) return;
    refreshingUsageLimitsRef.current = true;
    setIsRefreshingUsageLimits(true);
    const api = ensureNativeApi();
    api.server
      .getUsageLimits()
      .then((usageLimits) => {
        queryClient.setQueryData(serverQueryKeys.usageLimits(), usageLimits);
      })
      .catch((error: unknown) => {
        console.warn("Failed to refresh usage limits", error);
      })
      .finally(() => {
        refreshingUsageLimitsRef.current = false;
        setIsRefreshingUsageLimits(false);
      });
  }, [queryClient]);

  const modelListRefs = useRef<Partial<Record<ProviderKind, HTMLDivElement | null>>>({});

  const keybindingsConfigPath = serverConfigQuery.data?.keybindingsConfigPath ?? null;
  const availableEditors = serverConfigQuery.data?.availableEditors;
  const serverProviders = serverConfigQuery.data?.providers ?? EMPTY_SERVER_PROVIDERS;
  const usageLimits = serverUsageLimitsQuery.data;

  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const textGenProvider = textGenerationModelSelection.provider;
  const textGenModel = textGenerationModelSelection.model;
  const textGenModelOptions = textGenerationModelSelection.options;
  const gitModelOptionsByProvider = getCustomModelOptionsByProvider(
    settings,
    serverProviders,
    textGenProvider,
    textGenModel,
  );
  const areProviderSettingsDirty = PROVIDER_SETTINGS.some((providerSettings) => {
    const currentSettings = settings.providers[providerSettings.provider];
    const defaultSettings = DEFAULT_UNIFIED_SETTINGS.providers[providerSettings.provider];
    return !Equal.equals(currentSettings, defaultSettings);
  });
  const isGitWritingModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  const changedSettingLabels = [
    ...(theme !== "system" ? ["Theme"] : []),
    ...(settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat
      ? ["Time format"]
      : []),
    ...(settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap
      ? ["Diff line wrapping"]
      : []),
    ...(settings.enableAssistantStreaming !== DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming
      ? ["Assistant output"]
      : []),
    ...(settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode
      ? ["New thread mode"]
      : []),
    ...(settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete
      ? ["Delete confirmation"]
      : []),
    ...(isGitWritingModelDirty ? ["Git writing model"] : []),
    ...(areProviderSettingsDirty ? ["Providers"] : []),
  ];

  const openKeybindingsFile = useCallback(() => {
    if (!keybindingsConfigPath) return;
    setOpenKeybindingsError(null);
    setIsOpeningKeybindings(true);
    const api = ensureNativeApi();
    const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
    if (!editor) {
      setOpenKeybindingsError("No available editors found.");
      setIsOpeningKeybindings(false);
      return;
    }
    void api.shell
      .openInEditor(keybindingsConfigPath, editor)
      .catch((error) => {
        setOpenKeybindingsError(
          error instanceof Error ? error.message : "Unable to open keybindings file.",
        );
      })
      .finally(() => {
        setIsOpeningKeybindings(false);
      });
  }, [availableEditors, keybindingsConfigPath]);

  const addCustomModel = useCallback(
    (provider: ProviderKind) => {
      const customModelInput = customModelInputByProvider[provider];
      const customModels = settings.providers[provider].customModels;
      const normalized = normalizeModelSlug(customModelInput, provider);
      if (!normalized) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "Enter a model slug.",
        }));
        return;
      }
      if (
        serverProviders
          .find((candidate) => candidate.provider === provider)
          ?.models.some((option) => !option.isCustom && option.slug === normalized)
      ) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That model is already built in.",
        }));
        return;
      }
      if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`,
        }));
        return;
      }
      if (customModels.includes(normalized)) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That custom model is already saved.",
        }));
        return;
      }

      updateSettings({
        providers: {
          ...settings.providers,
          [provider]: {
            ...settings.providers[provider],
            customModels: [...customModels, normalized],
          },
        },
      });
      setCustomModelInputByProvider((existing) => ({
        ...existing,
        [provider]: "",
      }));
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
      // Watch for DOM changes (server may push updated model list) and scroll to bottom
      const el = modelListRefs.current[provider];
      if (el) {
        const scrollToEnd = () => el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
        // Immediate scroll for the optimistic update
        requestAnimationFrame(scrollToEnd);
        // Also observe mutations for when the server pushes an updated list
        const observer = new MutationObserver(() => {
          scrollToEnd();
          observer.disconnect();
        });
        observer.observe(el, { childList: true, subtree: true });
        // Clean up observer after a reasonable window
        setTimeout(() => observer.disconnect(), 2000);
      }
    },
    [customModelInputByProvider, serverProviders, settings, updateSettings],
  );

  const removeCustomModel = useCallback(
    (provider: ProviderKind, slug: string) => {
      const customModels = settings.providers[provider].customModels;
      updateSettings({
        providers: {
          ...settings.providers,
          [provider]: {
            ...settings.providers[provider],
            customModels: customModels.filter((model) => model !== slug),
          },
        },
      });
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [settings, updateSettings],
  );

  const updateProviderSubscriptions = useCallback(
    (provider: ProviderKind, subscriptions: ReadonlyArray<ProviderSubscription>) => {
      updateSettings({
        providers: {
          ...settings.providers,
          [provider]: {
            ...settings.providers[provider],
            subscriptions: [...subscriptions],
          },
        },
      });
    },
    [settings, updateSettings],
  );

  const addSubscription = useCallback(
    (provider: ProviderKind) => {
      const subscriptions = settings.providers[provider].subscriptions;
      updateProviderSubscriptions(provider, [
        ...subscriptions,
        makeDefaultSubscription(provider, subscriptions.length),
      ]);
      setOpenProviderDetails((existing) => ({
        ...existing,
        [provider]: true,
      }));
    },
    [settings, updateProviderSubscriptions],
  );

  const updateSubscription = useCallback(
    (
      provider: ProviderKind,
      subscriptionId: string,
      patch: Partial<Pick<ProviderSubscription, "name" | "configPath" | "priority">>,
    ) => {
      const subscriptions = settings.providers[provider].subscriptions.map((subscription) =>
        subscription.id !== subscriptionId
          ? subscription
          : {
              ...subscription,
              ...patch,
            },
      );
      updateProviderSubscriptions(provider, subscriptions);
    },
    [settings, updateProviderSubscriptions],
  );

  const removeSubscription = useCallback(
    (provider: ProviderKind, subscriptionId: string) => {
      const subscriptions = settings.providers[provider].subscriptions
        .filter((subscription) => subscription.id !== subscriptionId)
        .map((subscription, index) => Object.assign({}, subscription, { priority: index }));
      updateProviderSubscriptions(provider, subscriptions);
    },
    [settings, updateProviderSubscriptions],
  );

  const providerCards = PROVIDER_SETTINGS.map((providerSettings) => {
    const liveProvider = serverProviders.find(
      (candidate) => candidate.provider === providerSettings.provider,
    );
    const providerConfig = settings.providers[providerSettings.provider];
    const defaultProviderConfig = DEFAULT_UNIFIED_SETTINGS.providers[providerSettings.provider];
    const statusKey = liveProvider?.status ?? (providerConfig.enabled ? "warning" : "disabled");
    const statusStyle = PROVIDER_STATUS_STYLES[statusKey];
    const summary = getProviderSummary(liveProvider);
    const models: ReadonlyArray<ServerProviderModel> =
      liveProvider?.models ??
      providerConfig.customModels.map((slug) => ({
        slug,
        name: slug,
        isCustom: true,
        capabilities: null,
      }));
    const binaryPathValue = providerConfig.binaryPath;
    const isDirty = !Equal.equals(providerConfig, defaultProviderConfig);

    return {
      provider: providerSettings.provider,
      title: providerSettings.title,
      binaryPlaceholder: providerSettings.binaryPlaceholder,
      binaryDescription: providerSettings.binaryDescription,
      secondaryField: providerSettings.secondaryField,
      binaryPathValue,
      isDirty,
      liveProvider,
      models,
      providerConfig,
      statusKey,
      statusStyle,
      summary,
      versionLabel: getProviderVersionLabel(liveProvider?.version),
    };
  });

  async function restoreDefaults() {
    if (changedSettingLabels.length === 0) return;

    const api = readNativeApi();
    const confirmed = await (api ?? ensureNativeApi()).dialogs.confirm(
      ["Restore default settings?", `This will reset: ${changedSettingLabels.join(", ")}.`].join(
        "\n",
      ),
    );
    if (!confirmed) return;

    setTheme("system");
    resetSettings();
    setOpenProviderDetails({
      codex: false,
      claudeAgent: false,
      copilot: false,
    });
    setCustomModelInputByProvider({
      codex: "",
      claudeAgent: "",
      copilot: "",
    });
    setCustomModelErrorByProvider({});
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {!isElectron && (
          <header className="border-b border-border px-3 py-2 sm:px-5">
            <div className="flex items-center gap-2">
              <SidebarTrigger className="size-7 shrink-0 md:hidden" />
              <span className="text-sm font-medium text-foreground">Settings</span>
              <div className="ms-auto flex items-center gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={changedSettingLabels.length === 0}
                  onClick={() => void restoreDefaults()}
                >
                  <RotateCcwIcon className="size-3.5" />
                  Restore defaults
                </Button>
              </div>
            </div>
          </header>
        )}

        {isElectron && (
          <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
            <span className="text-xs font-medium tracking-wide text-muted-foreground/70">
              Settings
            </span>
            <div className="ms-auto flex items-center gap-2">
              <Button
                size="xs"
                variant="outline"
                disabled={changedSettingLabels.length === 0}
                onClick={() => void restoreDefaults()}
              >
                <RotateCcwIcon className="size-3.5" />
                Restore defaults
              </Button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
            <SettingsSection title="General">
              <SettingsRow
                title="Theme"
                description="Choose how T3 Code looks across the app."
                resetAction={
                  theme !== "system" ? (
                    <SettingResetButton label="theme" onClick={() => setTheme("system")} />
                  ) : null
                }
                control={
                  <Select
                    value={theme}
                    onValueChange={(value) => {
                      if (value !== "system" && value !== "light" && value !== "dark") return;
                      setTheme(value);
                    }}
                  >
                    <SelectTrigger className="w-full sm:w-40" aria-label="Theme preference">
                      <SelectValue>
                        {THEME_OPTIONS.find((option) => option.value === theme)?.label ?? "System"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      {THEME_OPTIONS.map((option) => (
                        <SelectItem hideIndicator key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                }
              />

              <SettingsRow
                title="Time format"
                description="System default follows your browser or OS clock preference."
                resetAction={
                  settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat ? (
                    <SettingResetButton
                      label="time format"
                      onClick={() =>
                        updateSettings({
                          timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
                        })
                      }
                    />
                  ) : null
                }
                control={
                  <Select
                    value={settings.timestampFormat}
                    onValueChange={(value) => {
                      if (value !== "locale" && value !== "12-hour" && value !== "24-hour") {
                        return;
                      }
                      updateSettings({
                        timestampFormat: value,
                      });
                    }}
                  >
                    <SelectTrigger className="w-full sm:w-40" aria-label="Timestamp format">
                      <SelectValue>{TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      <SelectItem hideIndicator value="locale">
                        {TIMESTAMP_FORMAT_LABELS.locale}
                      </SelectItem>
                      <SelectItem hideIndicator value="12-hour">
                        {TIMESTAMP_FORMAT_LABELS["12-hour"]}
                      </SelectItem>
                      <SelectItem hideIndicator value="24-hour">
                        {TIMESTAMP_FORMAT_LABELS["24-hour"]}
                      </SelectItem>
                    </SelectPopup>
                  </Select>
                }
              />

              <SettingsRow
                title="Diff line wrapping"
                description="Set the default wrap state when the diff panel opens. The in-panel wrap toggle only affects the current diff session."
                resetAction={
                  settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap ? (
                    <SettingResetButton
                      label="diff line wrapping"
                      onClick={() =>
                        updateSettings({
                          diffWordWrap: DEFAULT_UNIFIED_SETTINGS.diffWordWrap,
                        })
                      }
                    />
                  ) : null
                }
                control={
                  <Switch
                    checked={settings.diffWordWrap}
                    onCheckedChange={(checked) =>
                      updateSettings({
                        diffWordWrap: Boolean(checked),
                      })
                    }
                    aria-label="Wrap diff lines by default"
                  />
                }
              />

              <SettingsRow
                title="Assistant output"
                description="Show token-by-token output while a response is in progress."
                resetAction={
                  settings.enableAssistantStreaming !==
                  DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming ? (
                    <SettingResetButton
                      label="assistant output"
                      onClick={() =>
                        updateSettings({
                          enableAssistantStreaming:
                            DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming,
                        })
                      }
                    />
                  ) : null
                }
                control={
                  <Switch
                    checked={settings.enableAssistantStreaming}
                    onCheckedChange={(checked) =>
                      updateSettings({
                        enableAssistantStreaming: Boolean(checked),
                      })
                    }
                    aria-label="Stream assistant messages"
                  />
                }
              />

              <SettingsRow
                title="New threads"
                description="Pick the default workspace mode for newly created draft threads."
                resetAction={
                  settings.defaultThreadEnvMode !==
                  DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode ? (
                    <SettingResetButton
                      label="new threads"
                      onClick={() =>
                        updateSettings({
                          defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
                        })
                      }
                    />
                  ) : null
                }
                control={
                  <Select
                    value={settings.defaultThreadEnvMode}
                    onValueChange={(value) => {
                      if (value !== "local" && value !== "worktree") return;
                      updateSettings({
                        defaultThreadEnvMode: value,
                      });
                    }}
                  >
                    <SelectTrigger className="w-full sm:w-44" aria-label="Default thread mode">
                      <SelectValue>
                        {settings.defaultThreadEnvMode === "worktree" ? "New worktree" : "Local"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      <SelectItem hideIndicator value="local">
                        Local
                      </SelectItem>
                      <SelectItem hideIndicator value="worktree">
                        New worktree
                      </SelectItem>
                    </SelectPopup>
                  </Select>
                }
              />

              <SettingsRow
                title="Delete confirmation"
                description="Ask before deleting a thread and its chat history."
                resetAction={
                  settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete ? (
                    <SettingResetButton
                      label="delete confirmation"
                      onClick={() =>
                        updateSettings({
                          confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
                        })
                      }
                    />
                  ) : null
                }
                control={
                  <Switch
                    checked={settings.confirmThreadDelete}
                    onCheckedChange={(checked) =>
                      updateSettings({
                        confirmThreadDelete: Boolean(checked),
                      })
                    }
                    aria-label="Confirm thread deletion"
                  />
                }
              />
              <SettingsRow
                title="Text generation model"
                description="Configure the model used for text generation (commit messages, PR content etc.)"
                resetAction={
                  JSON.stringify(settings.textGenerationModelSelection ?? null) !==
                  JSON.stringify(DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null) ? (
                    <SettingResetButton
                      label="text generation model"
                      onClick={() => {
                        updateSettings({
                          textGenerationModelSelection:
                            DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                        });
                      }}
                    />
                  ) : null
                }
                control={
                  <div className="flex flex-wrap items-center justify-end gap-1.5">
                    <ProviderModelPicker
                      provider={textGenProvider}
                      model={textGenModel}
                      lockedProvider={null}
                      providers={serverProviders}
                      modelOptionsByProvider={gitModelOptionsByProvider}
                      triggerVariant="outline"
                      triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                      onProviderModelChange={(provider, model) => {
                        updateSettings({
                          textGenerationModelSelection: resolveAppModelSelectionState(
                            {
                              ...settings,
                              textGenerationModelSelection: { provider, model },
                            },
                            serverProviders,
                          ),
                        });
                      }}
                    />
                    <TraitsPicker
                      provider={textGenProvider}
                      models={
                        serverProviders.find((provider) => provider.provider === textGenProvider)
                          ?.models ?? []
                      }
                      model={textGenModel}
                      prompt=""
                      onPromptChange={() => {}}
                      modelOptions={textGenModelOptions}
                      allowPromptInjectedEffort={false}
                      triggerVariant="outline"
                      triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                      onModelOptionsChange={(nextOptions) => {
                        const nextSelection = buildModelSelection(
                          textGenProvider,
                          textGenModel,
                          nextOptions,
                        );
                        updateSettings({
                          textGenerationModelSelection: resolveAppModelSelectionState(
                            {
                              ...settings,
                              textGenerationModelSelection: nextSelection,
                            },
                            serverProviders,
                          ),
                        });
                      }}
                    />
                  </div>
                }
              />
            </SettingsSection>

            <SettingsSection
              title="Providers"
              headerAction={
                <div className="flex items-center gap-1.5">
                  {serverProviders.length > 0 ? (
                    <span className="text-[11px] text-muted-foreground/60">
                      {(() => {
                        const rel = formatRelativeTime(
                          serverProviders.reduce(
                            (latest, provider) =>
                              provider.checkedAt > latest ? provider.checkedAt : latest,
                            serverProviders[0]!.checkedAt,
                          ),
                        );
                        return rel.suffix ? (
                          <>
                            Checked <span className="font-mono tabular-nums">{rel.value}</span>{" "}
                            {rel.suffix}
                          </>
                        ) : (
                          <>Checked {rel.value}</>
                        );
                      })()}
                    </span>
                  ) : null}
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                          disabled={isRefreshingProviders}
                          onClick={() => void refreshProviders()}
                          aria-label="Refresh provider status"
                        >
                          {isRefreshingProviders ? (
                            <LoaderIcon className="size-3 animate-spin" />
                          ) : (
                            <RefreshCwIcon className="size-3" />
                          )}
                        </Button>
                      }
                    />
                    <TooltipPopup side="top">Refresh provider status</TooltipPopup>
                  </Tooltip>
                </div>
              }
            >
              {providerCards.map((providerCard) => {
                const customModelInput = customModelInputByProvider[providerCard.provider];
                const customModelError = customModelErrorByProvider[providerCard.provider] ?? null;
                const providerDisplayName =
                  PROVIDER_DISPLAY_NAMES[providerCard.provider] ?? providerCard.title;

                return (
                  <div
                    key={providerCard.provider}
                    className="border-t border-border first:border-t-0"
                    data-slot="settings-row"
                  >
                    <div className="px-4 py-4 sm:px-5">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex min-h-5 items-center gap-1.5">
                            <span
                              className={cn(
                                "size-2 shrink-0 rounded-full",
                                providerCard.statusStyle.dot,
                              )}
                            />
                            <h3 className="text-sm font-medium text-foreground">
                              {providerDisplayName}
                            </h3>
                            {providerCard.versionLabel ? (
                              <code className="text-xs text-muted-foreground">
                                {providerCard.versionLabel}
                              </code>
                            ) : null}
                            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
                              {providerCard.isDirty ? (
                                <SettingResetButton
                                  label={`${providerDisplayName} provider settings`}
                                  onClick={() => {
                                    updateSettings({
                                      providers: {
                                        ...settings.providers,
                                        [providerCard.provider]:
                                          DEFAULT_UNIFIED_SETTINGS.providers[providerCard.provider],
                                      },
                                    });
                                    setCustomModelErrorByProvider((existing) => ({
                                      ...existing,
                                      [providerCard.provider]: null,
                                    }));
                                  }}
                                />
                              ) : null}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {providerCard.summary.headline}
                            {providerCard.summary.detail
                              ? ` — ${providerCard.summary.detail}`
                              : null}
                          </p>
                        </div>
                        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                            onClick={() =>
                              setOpenProviderDetails((existing) => ({
                                ...existing,
                                [providerCard.provider]: !existing[providerCard.provider],
                              }))
                            }
                            aria-label={`Toggle ${providerDisplayName} details`}
                          >
                            <ChevronDownIcon
                              className={cn(
                                "size-3.5 transition-transform",
                                openProviderDetails[providerCard.provider] && "rotate-180",
                              )}
                            />
                          </Button>
                          <Switch
                            checked={providerCard.providerConfig.enabled}
                            onCheckedChange={(checked) => {
                              const isDisabling = !checked;
                              // The resolved provider accounts for both explicit
                              // selection and the implicit default (codex).
                              const resolvedProvider = textGenProvider;
                              // When disabling the provider that's currently used for
                              // text generation, clear the selection so it falls back to
                              // the next available provider's default model.
                              const shouldClearModelSelection =
                                isDisabling && resolvedProvider === providerCard.provider;
                              updateSettings({
                                providers: {
                                  ...settings.providers,
                                  [providerCard.provider]: {
                                    ...settings.providers[providerCard.provider],
                                    enabled: Boolean(checked),
                                  },
                                },
                                ...(shouldClearModelSelection
                                  ? {
                                      textGenerationModelSelection:
                                        DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                                    }
                                  : {}),
                              });
                            }}
                            aria-label={`Enable ${providerDisplayName}`}
                          />
                        </div>
                      </div>
                    </div>

                    <Collapsible
                      open={openProviderDetails[providerCard.provider]}
                      onOpenChange={(open) =>
                        setOpenProviderDetails((existing) => ({
                          ...existing,
                          [providerCard.provider]: open,
                        }))
                      }
                    >
                      <CollapsibleContent>
                        <div className="space-y-0">
                          {/* Binary path */}
                          <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                            <label
                              htmlFor={`provider-install-${providerCard.provider}-binary-path`}
                              className="block"
                            >
                              <span className="text-xs font-medium text-foreground">
                                {providerDisplayName} binary path
                              </span>
                              <Input
                                id={`provider-install-${providerCard.provider}-binary-path`}
                                className="mt-1.5"
                                value={providerCard.binaryPathValue}
                                onChange={(event) =>
                                  updateSettings({
                                    providers: {
                                      ...settings.providers,
                                      [providerCard.provider]: {
                                        ...settings.providers[providerCard.provider],
                                        binaryPath: event.target.value,
                                      },
                                    },
                                  })
                                }
                                placeholder={providerCard.binaryPlaceholder}
                                spellCheck={false}
                              />
                              <span className="mt-1 block text-xs text-muted-foreground">
                                {providerCard.binaryDescription}
                              </span>
                            </label>
                          </div>

                          {providerCard.secondaryField ? (
                            <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                              <label
                                htmlFor={`provider-install-${providerCard.provider}-${providerCard.secondaryField.key}`}
                                className="block"
                              >
                                <span className="text-xs font-medium text-foreground">
                                  {providerCard.secondaryField.label}
                                </span>
                                <Input
                                  id={`provider-install-${providerCard.provider}-${providerCard.secondaryField.key}`}
                                  className="mt-1.5"
                                  value={
                                    providerCard.provider === "codex"
                                      ? settings.providers.codex.homePath
                                      : settings.providers.copilot.configDir
                                  }
                                  onChange={(event) => {
                                    if (
                                      providerCard.provider === "codex" &&
                                      providerCard.secondaryField!.key === "homePath"
                                    ) {
                                      updateSettings({
                                        providers: {
                                          ...settings.providers,
                                          codex: {
                                            ...settings.providers.codex,
                                            homePath: event.target.value,
                                          },
                                        },
                                      });
                                      return;
                                    }

                                    if (
                                      providerCard.provider === "copilot" &&
                                      providerCard.secondaryField!.key === "configDir"
                                    ) {
                                      updateSettings({
                                        providers: {
                                          ...settings.providers,
                                          copilot: {
                                            ...settings.providers.copilot,
                                            configDir: event.target.value,
                                          },
                                        },
                                      });
                                    }
                                  }}
                                  placeholder={providerCard.secondaryField.placeholder}
                                  spellCheck={false}
                                />
                                {providerCard.secondaryField.description ? (
                                  <span className="mt-1 block text-xs text-muted-foreground">
                                    {providerCard.secondaryField.description}
                                  </span>
                                ) : null}
                              </label>
                            </div>
                          ) : null}

                          <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <div className="text-xs font-medium text-foreground">
                                  Subscriptions
                                </div>
                                <div className="mt-1 text-xs text-muted-foreground">
                                  Configure multiple authenticated config directories so T3 Code can
                                  switch accounts automatically when this provider reports a rate
                                  limit.
                                </div>
                              </div>
                              <Button
                                size="xs"
                                variant="outline"
                                className="shrink-0"
                                onClick={() => addSubscription(providerCard.provider)}
                              >
                                <PlusIcon className="size-3.5" />
                                Add
                              </Button>
                            </div>

                            <div className="mt-3 space-y-3">
                              {providerCard.providerConfig.subscriptions.length === 0 ? (
                                <div className="rounded-xl border border-dashed border-border/70 bg-background/60 px-3 py-3 text-xs text-muted-foreground">
                                  No subscriptions configured. T3 Code will keep using the legacy
                                  single-account path for this provider.
                                </div>
                              ) : (
                                providerCard.providerConfig.subscriptions.map(
                                  (subscription, index) => (
                                    <div
                                      key={subscription.id}
                                      className="rounded-xl border border-border/70 bg-background/60 p-3"
                                    >
                                      <div className="flex items-center justify-between gap-3">
                                        <div className="min-w-0">
                                          <div className="text-xs font-medium text-foreground">
                                            Subscription {index + 1}
                                          </div>
                                          <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                                            {subscription.id}
                                          </div>
                                        </div>
                                        <button
                                          type="button"
                                          className="text-muted-foreground transition-colors hover:text-foreground"
                                          aria-label={`Remove ${subscription.name || `subscription ${index + 1}`}`}
                                          onClick={() =>
                                            removeSubscription(
                                              providerCard.provider,
                                              subscription.id,
                                            )
                                          }
                                        >
                                          <XIcon className="size-3.5" />
                                        </button>
                                      </div>

                                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                                        <label className="block">
                                          <span className="text-[11px] font-medium text-foreground">
                                            Name
                                          </span>
                                          <Input
                                            className="mt-1.5"
                                            value={subscription.name}
                                            onChange={(event) =>
                                              updateSubscription(
                                                providerCard.provider,
                                                subscription.id,
                                                { name: event.target.value },
                                              )
                                            }
                                            placeholder="Personal"
                                            spellCheck={false}
                                          />
                                        </label>

                                        <label className="block">
                                          <span className="text-[11px] font-medium text-foreground">
                                            Priority
                                          </span>
                                          <Input
                                            className="mt-1.5"
                                            type="number"
                                            min="0"
                                            step="1"
                                            value={String(subscription.priority)}
                                            onChange={(event) =>
                                              updateSubscription(
                                                providerCard.provider,
                                                subscription.id,
                                                {
                                                  priority: Math.max(
                                                    0,
                                                    Number.parseInt(
                                                      event.target.value || "0",
                                                      10,
                                                    ) || 0,
                                                  ),
                                                },
                                              )
                                            }
                                          />
                                        </label>
                                      </div>

                                      <label className="mt-3 block">
                                        <span className="text-[11px] font-medium text-foreground">
                                          {providerCard.provider === "codex"
                                            ? "Config path / CODEX_HOME"
                                            : "Config path"}
                                        </span>
                                        <Input
                                          className="mt-1.5"
                                          value={subscription.configPath}
                                          onChange={(event) =>
                                            updateSubscription(
                                              providerCard.provider,
                                              subscription.id,
                                              { configPath: event.target.value },
                                            )
                                          }
                                          placeholder={
                                            providerCard.provider === "codex"
                                              ? "~/.codex-work"
                                              : providerCard.provider === "claudeAgent"
                                                ? "~/.claude-work"
                                                : "~/.config/github-copilot-work"
                                          }
                                          spellCheck={false}
                                        />
                                      </label>
                                    </div>
                                  ),
                                )
                              )}
                            </div>
                          </div>

                          {/* Models */}
                          <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                            <div className="text-xs font-medium text-foreground">Models</div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {providerCard.models.length} model
                              {providerCard.models.length === 1 ? "" : "s"} available.
                            </div>
                            <div
                              ref={(el) => {
                                modelListRefs.current[providerCard.provider] = el;
                              }}
                              className="mt-2 max-h-40 overflow-y-auto pb-1"
                            >
                              {providerCard.models.map((model) => {
                                const caps = model.capabilities;
                                const capLabels: string[] = [];
                                if (caps?.supportsFastMode) capLabels.push("Fast mode");
                                if (caps?.supportsThinkingToggle) capLabels.push("Thinking");
                                if (
                                  caps?.reasoningEffortLevels &&
                                  caps.reasoningEffortLevels.length > 0
                                )
                                  capLabels.push("Reasoning");
                                const hasDetails =
                                  capLabels.length > 0 || model.name !== model.slug;

                                return (
                                  <div
                                    key={`${providerCard.provider}:${model.slug}`}
                                    className="flex items-center gap-2 py-1"
                                  >
                                    <span className="min-w-0 truncate text-xs text-foreground/90">
                                      {model.name}
                                    </span>
                                    {hasDetails ? (
                                      <Tooltip>
                                        <TooltipTrigger
                                          render={
                                            <button
                                              type="button"
                                              className="shrink-0 text-muted-foreground/40 transition-colors hover:text-muted-foreground"
                                              aria-label={`Details for ${model.name}`}
                                            />
                                          }
                                        >
                                          <InfoIcon className="size-3" />
                                        </TooltipTrigger>
                                        <TooltipPopup side="top" className="max-w-56">
                                          <div className="space-y-1">
                                            <code className="block text-[11px] text-foreground">
                                              {model.slug}
                                            </code>
                                            {capLabels.length > 0 ? (
                                              <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                                                {capLabels.map((label) => (
                                                  <span
                                                    key={label}
                                                    className="text-[10px] text-muted-foreground"
                                                  >
                                                    {label}
                                                  </span>
                                                ))}
                                              </div>
                                            ) : null}
                                          </div>
                                        </TooltipPopup>
                                      </Tooltip>
                                    ) : null}
                                    {model.isCustom ? (
                                      <div className="ml-auto flex shrink-0 items-center gap-1.5">
                                        <span className="text-[10px] text-muted-foreground">
                                          custom
                                        </span>
                                        <button
                                          type="button"
                                          className="text-muted-foreground transition-colors hover:text-foreground"
                                          aria-label={`Remove ${model.slug}`}
                                          onClick={() =>
                                            removeCustomModel(providerCard.provider, model.slug)
                                          }
                                        >
                                          <XIcon className="size-3" />
                                        </button>
                                      </div>
                                    ) : null}
                                  </div>
                                );
                              })}
                            </div>
                            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                              <Input
                                id={`custom-model-${providerCard.provider}`}
                                value={customModelInput}
                                onChange={(event) => {
                                  const value = event.target.value;
                                  setCustomModelInputByProvider((existing) => ({
                                    ...existing,
                                    [providerCard.provider]: value,
                                  }));
                                  if (customModelError) {
                                    setCustomModelErrorByProvider((existing) => ({
                                      ...existing,
                                      [providerCard.provider]: null,
                                    }));
                                  }
                                }}
                                onKeyDown={(event) => {
                                  if (event.key !== "Enter") return;
                                  event.preventDefault();
                                  addCustomModel(providerCard.provider);
                                }}
                                placeholder={
                                  providerCard.provider === "codex"
                                    ? "gpt-6.7-codex-ultra-preview"
                                    : providerCard.provider === "claudeAgent"
                                      ? "claude-sonnet-5-0"
                                      : "gpt-5.4-preview"
                                }
                                spellCheck={false}
                              />
                              <Button
                                className="shrink-0"
                                variant="outline"
                                onClick={() => addCustomModel(providerCard.provider)}
                              >
                                <PlusIcon className="size-3.5" />
                                Add
                              </Button>
                            </div>
                            {customModelError ? (
                              <p className="mt-2 text-xs text-destructive">{customModelError}</p>
                            ) : null}
                          </div>
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  </div>
                );
              })}
            </SettingsSection>

            <SettingsSection
              title="Account Limits"
              headerAction={
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                        disabled={isRefreshingUsageLimits}
                        onClick={() => void refreshUsageLimits()}
                        aria-label="Refresh account limits"
                      >
                        {isRefreshingUsageLimits ? (
                          <LoaderIcon className="size-3 animate-spin" />
                        ) : (
                          <RefreshCwIcon className="size-3" />
                        )}
                      </Button>
                    }
                  />
                  <TooltipPopup side="top">Refresh account limits</TooltipPopup>
                </Tooltip>
              }
            >
              {[
                {
                  key: "codex" as const,
                  title: "Codex",
                  description:
                    "Live Codex app-server rate limits. These become available after a Codex session starts.",
                  snapshot: usageLimits?.codex,
                },
                {
                  key: "github" as const,
                  title: "GitHub",
                  description:
                    "GitHub API rate-limit windows from `gh api rate_limit`. This is API rate-limit state, not billing usage.",
                  snapshot: usageLimits?.github,
                },
              ].map(({ key, title, description, snapshot }) => {
                const summary = snapshot
                  ? getUsageSnapshotSummary(snapshot)
                  : {
                      headline: "Loading",
                      detail: "Requesting the latest usage-limit snapshot from the server.",
                    };

                return (
                  <SettingsRow
                    key={key}
                    title={title}
                    description={description}
                    status={
                      <div className="space-y-2">
                        <div>
                          <span className="font-medium text-foreground">{summary.headline}</span>
                          {summary.detail ? <span>{` | ${summary.detail}`}</span> : null}
                        </div>
                        {snapshot?.available && snapshot.buckets.length ? (
                          <div className="space-y-1.5">
                            {snapshot.buckets.map((bucket) => (
                              <div
                                key={`${key}:${bucket.id}`}
                                className="rounded-md border border-border/70 bg-background/60 px-2.5 py-2"
                              >
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <span className="font-medium text-foreground">
                                    {bucket.label}
                                  </span>
                                  <span className="font-mono text-[11px] text-foreground/90">
                                    {formatUsageBucketHeadline(bucket)}
                                  </span>
                                </div>
                                {formatUsageBucketDetail(bucket) ? (
                                  <div className="mt-1 text-[11px] text-muted-foreground">
                                    {formatUsageBucketDetail(bucket)}
                                  </div>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        ) : snapshot?.message ? (
                          <div>{snapshot.message}</div>
                        ) : null}
                      </div>
                    }
                  />
                );
              })}
            </SettingsSection>

            <SettingsSection title="Advanced">
              <SettingsRow
                title="Keybindings"
                description="Open the persisted `keybindings.json` file to edit advanced bindings directly."
                status={
                  <>
                    <span className="block break-all font-mono text-[11px] text-foreground">
                      {keybindingsConfigPath ?? "Resolving keybindings path..."}
                    </span>
                    {openKeybindingsError ? (
                      <span className="mt-1 block text-destructive">{openKeybindingsError}</span>
                    ) : (
                      <span className="mt-1 block">Opens in your preferred editor.</span>
                    )}
                  </>
                }
                control={
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!keybindingsConfigPath || isOpeningKeybindings}
                    onClick={openKeybindingsFile}
                  >
                    {isOpeningKeybindings ? "Opening..." : "Open file"}
                  </Button>
                }
              />

              <SettingsRow
                title="Version"
                description="Current application version."
                control={
                  <code className="text-xs font-medium text-muted-foreground">{APP_VERSION}</code>
                }
              />
            </SettingsSection>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/settings")({
  component: SettingsRouteView,
});
