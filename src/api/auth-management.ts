import { request, post } from "./core";

export interface ProviderAuthInfo {
  authenticated: boolean;
  account?: string;
  plan?: string;
  method?: string;
  models?: number;
  accounts?: Array<{
    id: string;
    email: string;
    label?: string;
    plan?: string;
    active: boolean;
  }>;
}

export interface AuthManagementStatus {
  claude: ProviderAuthInfo;
  codex: ProviderAuthInfo;
  gemini: ProviderAuthInfo;
  github: ProviderAuthInfo;
  ollama: ProviderAuthInfo;
}

export interface ProviderAccountInfo {
  id: string;
  provider: string;
  label: string;
  email?: string;
  isActive: boolean;
  plan?: string;
  usagePct: number;
  status: string;
}

export interface ProviderAccountsResponse {
  ok: boolean;
  accounts: {
    claude: ProviderAccountInfo[];
    codex: ProviderAccountInfo[];
    gemini: ProviderAccountInfo[];
  };
}

export interface FallbackSettings {
  enabled: boolean;
  thresholdPct: number;
  warnPct: number;
  telegramAlerts: boolean;
  autoSwitch: boolean;
  fallbackChain: Record<string, string[]>;
}

export interface UsageEvent {
  id: string;
  provider: string;
  account_id: string | null;
  event_type: string;
  usage_pct: number | null;
  details: string | null;
  created_at: number;
}

export function getAuthManagementStatus(): Promise<AuthManagementStatus> {
  return request<AuthManagementStatus>("/api/auth/management/status");
}

export function switchAuthAccount(
  provider: string,
  accountId: string,
): Promise<{ ok: boolean; activeAccount: string; email: string }> {
  return post("/api/auth/management/switch-account", { provider, accountId });
}

export function updateProviderKey(
  provider: string,
  apiKey: string,
): Promise<{ ok: boolean; provider: string }> {
  return post("/api/auth/management/update-key", { provider, apiKey });
}

export function getProviderAccounts(): Promise<ProviderAccountsResponse> {
  return request<ProviderAccountsResponse>("/api/auth/management/accounts");
}

export function addProviderAccount(
  provider: string,
  label: string,
  credentials: Record<string, unknown>,
): Promise<{ ok: boolean; accountId: string; provider: string; email?: string }> {
  return post("/api/auth/management/add-account", { provider, label, credentials });
}

export function removeProviderAccount(
  provider: string,
  accountId: string,
): Promise<{ ok: boolean; removedId: string; newActive?: string }> {
  return post("/api/auth/management/remove-account", { provider, accountId });
}

export function getFallbackSettings(): Promise<{ ok: boolean; settings: FallbackSettings }> {
  return request<{ ok: boolean; settings: FallbackSettings }>("/api/auth/management/fallback-settings");
}

export function updateFallbackSettings(
  settings: Partial<FallbackSettings>,
): Promise<{ ok: boolean }> {
  return post("/api/auth/management/fallback-settings", settings);
}

export function getUsageEvents(
  limit?: number,
): Promise<{ ok: boolean; events: UsageEvent[] }> {
  const qs = limit ? `?limit=${limit}` : "";
  return request<{ ok: boolean; events: UsageEvent[] }>(`/api/auth/management/usage-events${qs}`);
}
