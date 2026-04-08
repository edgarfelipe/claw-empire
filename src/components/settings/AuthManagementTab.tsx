import { useCallback, useEffect, useState } from "react";
import type {
  AuthManagementStatus,
  ProviderAuthInfo,
  ProviderAccountInfo,
  FallbackSettings,
  UsageEvent,
} from "../../api/auth-management";
import * as api from "../../api";
import { CliClaudeLogo, CliChatGPTLogo, CliGeminiLogo, GitHubCopilotLogo } from "./Logos";
import type { TFunction } from "./types";

interface AuthManagementTabProps {
  t: TFunction;
}

type ProviderKey = "claude" | "codex" | "gemini" | "github" | "ollama";
type AddableProvider = "claude" | "codex" | "gemini";

const PROVIDER_META: Record<
  ProviderKey,
  { label: string; icon: React.ReactNode; color: string }
> = {
  claude: { label: "Claude Code", icon: <CliClaudeLogo />, color: "#D97757" },
  codex: { label: "Codex CLI", icon: <CliChatGPTLogo />, color: "#10A37F" },
  gemini: { label: "Gemini CLI", icon: <CliGeminiLogo />, color: "#4285F4" },
  github: { label: "GitHub", icon: <GitHubCopilotLogo className="w-[18px] h-[18px] text-white" />, color: "#ffffff" },
  ollama: { label: "Ollama", icon: <span className="text-lg">🦙</span>, color: "#ffffff" },
};

// ---------------------------------------------------------------------------
// Usage bar color helper
// ---------------------------------------------------------------------------
function usageBarColor(pct: number): string {
  if (pct >= 95) return "bg-red-500";
  if (pct >= 80) return "bg-yellow-500";
  return "bg-green-500";
}

function usageTextColor(pct: number): string {
  if (pct >= 95) return "text-red-400";
  if (pct >= 80) return "text-yellow-400";
  return "text-green-400";
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function AuthManagementTab({ t }: AuthManagementTabProps) {
  const [status, setStatus] = useState<AuthManagementStatus | null>(null);
  const [accounts, setAccounts] = useState<Record<string, ProviderAccountInfo[]>>({});
  const [fallbackSettings, setFallbackSettings] = useState<FallbackSettings | null>(null);
  const [usageEvents, setUsageEvents] = useState<UsageEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [geminiKeyInput, setGeminiKeyInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Add account form state
  const [addFormOpen, setAddFormOpen] = useState<AddableProvider | null>(null);
  const [addFormData, setAddFormData] = useState<Record<string, string>>({});
  const [addFormSaving, setAddFormSaving] = useState(false);

  // Confirmation dialog
  const [removeConfirm, setRemoveConfirm] = useState<{ provider: string; accountId: string; label: string } | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statusData, accountsData, fbSettings, eventsData] = await Promise.all([
        api.getAuthManagementStatus(),
        api.getProviderAccounts().catch(() => ({ ok: false, accounts: { claude: [], codex: [], gemini: [] } })),
        api.getFallbackSettings().catch(() => ({
          ok: false,
          settings: {
            enabled: true,
            thresholdPct: 95,
            warnPct: 80,
            telegramAlerts: true,
            autoSwitch: true,
            fallbackChain: { claude: ["codex", "ollama"], codex: ["claude", "ollama"], gemini: ["ollama"] },
          },
        })),
        api.getUsageEvents(20).catch(() => ({ ok: false, events: [] })),
      ]);
      setStatus(statusData);
      setAccounts(accountsData.accounts as Record<string, ProviderAccountInfo[]>);
      setFallbackSettings(fbSettings.settings);
      setUsageEvents(eventsData.events ?? []);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const showMessage = useCallback((type: "success" | "error", text: string) => {
    setActionMessage({ type, text });
    setTimeout(() => setActionMessage(null), 3000);
  }, []);

  const handleSwitchAccount = useCallback(
    async (accountId: string) => {
      setSwitching(true);
      try {
        const result = await api.switchAuthAccount("claude", accountId);
        showMessage("success", t({
          ko: `계정이 ${result.email}(으)로 전환되었습니다`,
          en: `Switched to ${result.email}`,
          ja: `${result.email} に切り替えました`,
          zh: `已切换到 ${result.email}`,
          pt: `Alternado para ${result.email}`,
        }));
        await loadStatus();
      } catch (err) {
        showMessage("error", String(err));
      } finally {
        setSwitching(false);
      }
    },
    [loadStatus, showMessage, t],
  );

  const handleUpdateGeminiKey = useCallback(async () => {
    if (!geminiKeyInput.trim()) return;
    setSavingKey(true);
    try {
      await api.updateProviderKey("gemini", geminiKeyInput.trim());
      showMessage("success", t({
        ko: "Gemini API 키가 업데이트되었습니다",
        en: "Gemini API key updated",
        ja: "Gemini API キーが更新されました",
        zh: "Gemini API 密钥已更新",
        pt: "Chave API Gemini atualizada",
      }));
      setGeminiKeyInput("");
      await loadStatus();
    } catch (err) {
      showMessage("error", String(err));
    } finally {
      setSavingKey(false);
    }
  }, [geminiKeyInput, loadStatus, showMessage, t]);

  const handleAddAccount = useCallback(async (provider: AddableProvider) => {
    setAddFormSaving(true);
    try {
      let credentials: Record<string, unknown> = {};
      let label = addFormData.label ?? "";

      if (provider === "claude") {
        credentials = {
          email: addFormData.email ?? "",
          accessToken: addFormData.accessToken ?? "",
          refreshToken: addFormData.refreshToken ?? "",
          subscriptionType: addFormData.subscriptionType ?? "max",
        };
        label = label || addFormData.email || "Claude Account";
      } else {
        credentials = { apiKey: addFormData.apiKey ?? "" };
        label = label || `${provider} Key`;
      }

      await api.addProviderAccount(provider, label, credentials);
      showMessage("success", t({
        ko: "계정이 추가되었습니다",
        en: "Account added successfully",
        ja: "アカウントが追加されました",
        zh: "账户已添加",
        pt: "Conta adicionada com sucesso",
      }));
      setAddFormOpen(null);
      setAddFormData({});
      await loadStatus();
    } catch (err) {
      showMessage("error", String(err));
    } finally {
      setAddFormSaving(false);
    }
  }, [addFormData, loadStatus, showMessage, t]);

  const handleRemoveAccount = useCallback(async (provider: string, accountId: string) => {
    try {
      await api.removeProviderAccount(provider, accountId);
      showMessage("success", t({
        ko: "계정이 제거되었습니다",
        en: "Account removed",
        ja: "アカウントが削除されました",
        zh: "账户已移除",
        pt: "Conta removida",
      }));
      setRemoveConfirm(null);
      await loadStatus();
    } catch (err) {
      showMessage("error", String(err));
    }
  }, [loadStatus, showMessage, t]);

  const handleUpdateFallbackSetting = useCallback(async (key: string, value: unknown) => {
    try {
      await api.updateFallbackSettings({ [key]: value } as Partial<FallbackSettings>);
      setFallbackSettings((prev) => prev ? { ...prev, [key]: value } : prev);
    } catch (err) {
      showMessage("error", String(err));
    }
  }, [showMessage]);

  if (loading && !status) {
    return (
      <div className="text-center py-8 text-slate-500 text-sm">
        {t({ ko: "로딩 중...", en: "Loading...", ja: "読み込み中...", zh: "加载中...", pt: "Carregando..." })}
      </div>
    );
  }

  if (error && !status) {
    return (
      <div className="text-center py-8 text-red-400 text-sm">
        {t({ ko: "오류 발생", en: "Error loading status", ja: "エラー", zh: "加载错误", pt: "Erro ao carregar" })}
        <p className="text-xs text-slate-500 mt-1">{error}</p>
        <button onClick={loadStatus} className="mt-2 text-blue-400 hover:text-blue-300 text-xs">
          {t({ ko: "다시 시도", en: "Retry", ja: "再試行", zh: "重试", pt: "Tentar novamente" })}
        </button>
      </div>
    );
  }

  return (
    <section
      className="rounded-xl p-5 sm:p-6 space-y-5"
      style={{ background: "var(--th-card-bg)", border: "1px solid var(--th-card-border)" }}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--th-text-primary)" }}>
          {t({
            ko: "인증 관리",
            en: "Authentication Management",
            ja: "認証管理",
            zh: "认证管理",
            pt: "Gerenciamento de Autenticacao",
          })}
        </h3>
        <button
          onClick={loadStatus}
          disabled={loading}
          className="text-xs text-blue-400 hover:text-blue-300 transition-colors disabled:opacity-50"
        >
          {t({ ko: "새로고침", en: "Refresh", ja: "更新", zh: "刷新", pt: "Atualizar" })}
        </button>
      </div>

      {actionMessage && (
        <div
          className={`text-xs px-3 py-2 rounded-lg ${
            actionMessage.type === "success"
              ? "bg-green-500/20 text-green-400"
              : "bg-red-500/20 text-red-400"
          }`}
        >
          {actionMessage.text}
        </div>
      )}

      {/* Provider cards */}
      <div className="space-y-3">
        {status &&
          (Object.keys(PROVIDER_META) as ProviderKey[]).map((key) => {
            const meta = PROVIDER_META[key];
            const info: ProviderAuthInfo | undefined = status[key];
            if (!info) return null;

            const providerAccounts = (accounts as Record<string, ProviderAccountInfo[]>)[key] ?? [];

            return (
              <ProviderCard
                key={key}
                providerKey={key}
                meta={meta}
                info={info}
                providerAccounts={providerAccounts}
                t={t}
                switching={switching}
                onSwitchAccount={handleSwitchAccount}
                onAddAccount={() => {
                  setAddFormData({});
                  setAddFormOpen(key as AddableProvider);
                }}
                onRemoveAccount={(accountId, label) => setRemoveConfirm({ provider: key, accountId, label })}
                geminiKeyInput={geminiKeyInput}
                onGeminiKeyChange={setGeminiKeyInput}
                onGeminiKeySave={handleUpdateGeminiKey}
                savingKey={savingKey}
              />
            );
          })}
      </div>

      {/* Fallback Settings Section */}
      {fallbackSettings && (
        <FallbackSettingsSection
          settings={fallbackSettings}
          onUpdate={handleUpdateFallbackSetting}
          t={t}
        />
      )}

      {/* Recent Usage Events */}
      {usageEvents.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            {t({
              ko: "최근 이벤트",
              en: "Recent Events",
              ja: "最近のイベント",
              zh: "最近事件",
              pt: "Eventos Recentes",
            })}
          </h4>
          <div className="max-h-32 overflow-y-auto space-y-1">
            {usageEvents.slice(0, 10).map((ev) => (
              <div key={ev.id} className="flex items-center gap-2 text-xs text-slate-400">
                <span className="shrink-0">
                  {ev.event_type === "warning" && "\u26A0\uFE0F"}
                  {ev.event_type === "critical" && "\u{1F534}"}
                  {ev.event_type === "switch" && "\u2705"}
                  {ev.event_type === "fallback" && "\u{1F6A8}"}
                  {ev.event_type === "recovery" && "\u{1F49A}"}
                </span>
                <span className="truncate">{ev.details ?? ev.event_type}</span>
                <span className="shrink-0 text-slate-600 ml-auto">
                  {ev.usage_pct != null ? `${Math.round(ev.usage_pct)}%` : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add Account Modal */}
      {addFormOpen && (
        <AddAccountModal
          provider={addFormOpen}
          formData={addFormData}
          onChange={(key, val) => setAddFormData((prev) => ({ ...prev, [key]: val }))}
          onSubmit={() => handleAddAccount(addFormOpen)}
          onClose={() => { setAddFormOpen(null); setAddFormData({}); }}
          saving={addFormSaving}
          t={t}
        />
      )}

      {/* Remove Confirmation */}
      {removeConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setRemoveConfirm(null)}>
          <div
            className="rounded-xl p-5 max-w-sm w-full mx-4 space-y-3"
            style={{ background: "var(--th-card-bg)", border: "1px solid var(--th-card-border)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h4 className="text-sm font-semibold text-white">
              {t({ ko: "계정 제거", en: "Remove Account", ja: "アカウント削除", zh: "移除账户", pt: "Remover Conta" })}
            </h4>
            <p className="text-xs text-slate-400">
              {t({
                ko: `${removeConfirm.label}을(를) 제거하시겠습니까?`,
                en: `Remove ${removeConfirm.label}?`,
                ja: `${removeConfirm.label} を削除しますか？`,
                zh: `确认移除 ${removeConfirm.label}？`,
                pt: `Remover ${removeConfirm.label}?`,
              })}
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setRemoveConfirm(null)}
                className="px-3 py-1.5 bg-slate-600 hover:bg-slate-500 text-white text-xs rounded transition-colors"
              >
                {t({ ko: "취소", en: "Cancel", ja: "キャンセル", zh: "取消", pt: "Cancelar" })}
              </button>
              <button
                onClick={() => handleRemoveAccount(removeConfirm.provider, removeConfirm.accountId)}
                className="px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white text-xs rounded transition-colors"
              >
                {t({ ko: "제거", en: "Remove", ja: "削除", zh: "移除", pt: "Remover" })}
              </button>
            </div>
          </div>
        </div>
      )}

      <p className="text-xs text-slate-500">
        {t({
          ko: "Claude 계정은 accounts.json에서 관리됩니다. GitHub는 OAuth 탭에서 연결합니다.",
          en: "Claude accounts are managed via accounts.json. GitHub connects through OAuth tab.",
          ja: "Claude アカウントは accounts.json で管理されています。GitHub は OAuth タブで接続します。",
          zh: "Claude 账户通过 accounts.json 管理。GitHub 通过 OAuth 标签连接。",
          pt: "Contas Claude sao gerenciadas via accounts.json. GitHub conecta pela aba OAuth.",
        })}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Provider Card
// ---------------------------------------------------------------------------

interface ProviderCardProps {
  providerKey: ProviderKey;
  meta: { label: string; icon: React.ReactNode; color: string };
  info: ProviderAuthInfo;
  providerAccounts: ProviderAccountInfo[];
  t: TFunction;
  switching: boolean;
  onSwitchAccount: (accountId: string) => void;
  onAddAccount: () => void;
  onRemoveAccount: (accountId: string, label: string) => void;
  geminiKeyInput: string;
  onGeminiKeyChange: (v: string) => void;
  onGeminiKeySave: () => void;
  savingKey: boolean;
}

function ProviderCard({
  providerKey,
  meta,
  info,
  providerAccounts,
  t,
  switching,
  onSwitchAccount,
  onAddAccount,
  onRemoveAccount,
  geminiKeyInput,
  onGeminiKeyChange,
  onGeminiKeySave,
  savingKey,
}: ProviderCardProps) {
  const canAddAccounts = providerKey === "claude" || providerKey === "gemini" || providerKey === "codex";

  return (
    <div className="rounded-lg bg-slate-700/30 p-3 space-y-2">
      {/* Header row */}
      <div className="flex items-center gap-3">
        <span className="flex-shrink-0">{meta.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm text-white font-medium">{meta.label}</div>
          <div className="text-xs text-slate-400 truncate">
            {info.account
              ? info.account
              : info.method === "local"
                ? t({ ko: "로컬 서버", en: "Local server", ja: "ローカルサーバー", zh: "本地服务器", pt: "Servidor local" })
                : t({ ko: "연결 안됨", en: "Not connected", ja: "未接続", zh: "未连接", pt: "Nao conectado" })}
          </div>
        </div>

        {/* Add account button */}
        {canAddAccounts && (
          <button
            onClick={onAddAccount}
            className="text-xs px-2 py-0.5 rounded bg-blue-600/30 text-blue-400 hover:bg-blue-600/50 transition-colors"
          >
            + {t({ ko: "추가", en: "Add", ja: "追加", zh: "添加", pt: "Adicionar" })}
          </button>
        )}

        {/* Status badge */}
        <span
          className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${
            info.authenticated
              ? "bg-green-500/20 text-green-400"
              : "bg-red-500/20 text-red-400"
          }`}
        >
          {info.authenticated
            ? t({ ko: "인증됨", en: "Auth", ja: "認証済み", zh: "已认证", pt: "Autenticado" })
            : t({ ko: "미인증", en: "Not Auth", ja: "未認証", zh: "未认证", pt: "Nao autenticado" })}
        </span>
      </div>

      {/* Account list with usage bars */}
      {info.authenticated && providerAccounts.length > 0 && (
        <div className="pl-0 sm:pl-8 space-y-1.5">
          {providerAccounts.map((acc) => (
            <div key={acc.id} className="flex items-center gap-2">
              {/* Active indicator */}
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  acc.isActive ? "bg-green-400" : "bg-slate-600"
                }`}
                title={acc.isActive
                  ? t({ ko: "활성", en: "Active", ja: "アクティブ", zh: "活跃", pt: "Ativo" })
                  : t({ ko: "대기", en: "Standby", ja: "待機", zh: "待机", pt: "Em espera" })
                }
              />

              {/* Account label */}
              <span className="text-xs text-slate-300 truncate min-w-0 flex-shrink">
                {acc.email ?? acc.label}
                {acc.plan ? ` (${acc.plan})` : ""}
              </span>

              {/* Usage bar */}
              <div className="flex-1 min-w-[60px] max-w-[120px]">
                <div className="h-1.5 bg-slate-600 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${usageBarColor(acc.usagePct)}`}
                    style={{ width: `${Math.min(100, acc.usagePct)}%` }}
                  />
                </div>
              </div>

              {/* Usage percentage */}
              <span className={`text-xs font-mono shrink-0 ${usageTextColor(acc.usagePct)}`}>
                {Math.round(acc.usagePct)}%
              </span>

              {/* Status badge */}
              {acc.status === "exhausted" && (
                <span className="text-xs px-1 py-0.5 rounded bg-red-500/20 text-red-400 shrink-0">
                  {t({ ko: "소진", en: "Exhausted", ja: "消耗", zh: "耗尽", pt: "Esgotada" })}
                </span>
              )}

              {/* Switch button for non-active Claude accounts */}
              {providerKey === "claude" && !acc.isActive && (
                <button
                  onClick={() => onSwitchAccount(acc.id)}
                  disabled={switching}
                  className="text-xs px-1.5 py-0.5 rounded bg-slate-600 hover:bg-slate-500 text-slate-300 transition-colors disabled:opacity-50 shrink-0"
                >
                  {t({ ko: "전환", en: "Switch", ja: "切替", zh: "切换", pt: "Trocar" })}
                </button>
              )}

              {/* Remove button */}
              <button
                onClick={() => onRemoveAccount(acc.id, acc.email ?? acc.label)}
                className="text-xs text-red-500/60 hover:text-red-400 transition-colors shrink-0"
                title={t({ ko: "제거", en: "Remove", ja: "削除", zh: "移除", pt: "Remover" })}
              >
                x
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Existing account switcher (fallback when no provider_accounts data) */}
      {info.authenticated && providerAccounts.length === 0 && (
        <div className="pl-0 sm:pl-8 space-y-1.5">
          {/* Plan badge for Claude */}
          {info.plan && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">
                {t({ ko: "플랜:", en: "Plan:", ja: "プラン:", zh: "套餐:", pt: "Plano:" })}
              </span>
              <span className="text-xs px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300">
                {info.plan}
              </span>
            </div>
          )}

          {/* Method badge */}
          {info.method && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">
                {t({ ko: "방식:", en: "Method:", ja: "方式:", zh: "方式:", pt: "Metodo:" })}
              </span>
              <span className="text-xs text-slate-300">{info.method}</span>
            </div>
          )}

          {/* Ollama model count */}
          {info.models !== undefined && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">
                {t({ ko: "모델 수:", en: "Models:", ja: "モデル数:", zh: "模型数:", pt: "Modelos:" })}
              </span>
              <span className="text-xs text-slate-300">{info.models}</span>
            </div>
          )}

          {/* Claude account switcher */}
          {providerKey === "claude" && info.accounts && info.accounts.length > 1 && (
            <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2">
              <span className="text-xs text-slate-400 shrink-0">
                {t({
                  ko: "계정 전환:",
                  en: "Switch account:",
                  ja: "アカウント切替:",
                  zh: "切换账号:",
                  pt: "Alternar conta:",
                })}
              </span>
              <select
                disabled={switching}
                value={info.accounts.find((a) => a.active)?.id ?? ""}
                onChange={(e) => onSwitchAccount(e.target.value)}
                className="w-full min-w-0 rounded border border-slate-600 bg-slate-700/50 px-2 py-1 text-xs text-white focus:border-blue-500 focus:outline-none sm:flex-1 disabled:opacity-50"
              >
                {info.accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.email} {acc.plan ? `(${acc.plan})` : ""} {acc.active ? " *" : ""}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Gemini API key input */}
          {providerKey === "gemini" && (
            <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2">
              <span className="text-xs text-slate-400 shrink-0">
                {t({
                  ko: "API 키 업데이트:",
                  en: "Update API key:",
                  ja: "API キー更新:",
                  zh: "更新 API 密钥:",
                  pt: "Atualizar chave API:",
                })}
              </span>
              <input
                type="password"
                placeholder="AIza..."
                value={geminiKeyInput}
                onChange={(e) => onGeminiKeyChange(e.target.value)}
                className="w-full min-w-0 rounded border border-slate-600 bg-slate-700/50 px-2 py-1 text-xs text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none sm:flex-1"
              />
              <button
                onClick={onGeminiKeySave}
                disabled={savingKey || !geminiKeyInput.trim()}
                className="shrink-0 px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {savingKey
                  ? t({ ko: "저장 중...", en: "Saving...", ja: "保存中...", zh: "保存中...", pt: "Salvando..." })
                  : t({ ko: "저장", en: "Save", ja: "保存", zh: "保存", pt: "Salvar" })}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Not authenticated — show hint */}
      {!info.authenticated && (
        <div className="pl-0 sm:pl-8">
          <p className="text-xs text-slate-500">
            {providerKey === "claude" &&
              t({
                ko: "accounts.json 파일이 없거나 활성 계정이 없습니다.",
                en: "No accounts.json or no active account found.",
                ja: "accounts.json が見つからないか、アクティブアカウントがありません。",
                zh: "未找到 accounts.json 或没有活跃账户。",
                pt: "accounts.json nao encontrado ou sem conta ativa.",
              })}
            {providerKey === "codex" &&
              t({
                ko: "Codex CLI를 설치하고 인증하세요.",
                en: "Install and authenticate Codex CLI.",
                ja: "Codex CLI をインストールして認証してください。",
                zh: "请安装并认证 Codex CLI。",
                pt: "Instale e autentique o Codex CLI.",
              })}
            {providerKey === "gemini" && (
              <span className="space-y-1.5 block">
                <span className="block">
                  {t({
                    ko: "GOOGLE_API_KEY 또는 GEMINI_API_KEY 환경 변수를 설정하세요.",
                    en: "Set GOOGLE_API_KEY or GEMINI_API_KEY environment variable.",
                    ja: "GOOGLE_API_KEY または GEMINI_API_KEY 環境変数を設定してください。",
                    zh: "请设置 GOOGLE_API_KEY 或 GEMINI_API_KEY 环境变量。",
                    pt: "Defina a variavel de ambiente GOOGLE_API_KEY ou GEMINI_API_KEY.",
                  })}
                </span>
                <span className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2 mt-1.5">
                  <input
                    type="password"
                    placeholder="AIza..."
                    value={geminiKeyInput}
                    onChange={(e) => onGeminiKeyChange(e.target.value)}
                    className="w-full min-w-0 rounded border border-slate-600 bg-slate-700/50 px-2 py-1 text-xs text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none sm:flex-1"
                  />
                  <button
                    onClick={onGeminiKeySave}
                    disabled={savingKey || !geminiKeyInput.trim()}
                    className="shrink-0 px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {savingKey
                      ? t({ ko: "저장 중...", en: "Saving...", ja: "保存中...", zh: "保存中...", pt: "Salvando..." })
                      : t({ ko: "설정", en: "Set Key", ja: "設定", zh: "设置", pt: "Definir" })}
                  </button>
                </span>
              </span>
            )}
            {providerKey === "github" &&
              t({
                ko: "OAuth 탭에서 GitHub를 연결하세요.",
                en: "Connect GitHub from the OAuth tab.",
                ja: "OAuth タブから GitHub を接続してください。",
                zh: "请从 OAuth 标签页连接 GitHub。",
                pt: "Conecte o GitHub pela aba OAuth.",
              })}
            {providerKey === "ollama" &&
              t({
                ko: "Ollama 서버가 실행되고 있지 않습니다.",
                en: "Ollama server is not running.",
                ja: "Ollama サーバーが実行されていません。",
                zh: "Ollama 服务器未运行。",
                pt: "Servidor Ollama nao esta rodando.",
              })}
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add Account Modal
// ---------------------------------------------------------------------------

interface AddAccountModalProps {
  provider: AddableProvider;
  formData: Record<string, string>;
  onChange: (key: string, value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  saving: boolean;
  t: TFunction;
}

function AddAccountModal({ provider, formData, onChange, onSubmit, onClose, saving, t }: AddAccountModalProps) {
  const title = t({
    ko: `${PROVIDER_META[provider]?.label ?? provider} 계정 추가`,
    en: `Add ${PROVIDER_META[provider]?.label ?? provider} Account`,
    ja: `${PROVIDER_META[provider]?.label ?? provider} アカウント追加`,
    zh: `添加 ${PROVIDER_META[provider]?.label ?? provider} 账户`,
    pt: `Adicionar Conta ${PROVIDER_META[provider]?.label ?? provider}`,
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="rounded-xl p-5 max-w-md w-full mx-4 space-y-3"
        style={{ background: "var(--th-card-bg)", border: "1px solid var(--th-card-border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h4 className="text-sm font-semibold text-white">{title}</h4>

        <div className="space-y-2">
          <div>
            <label className="text-xs text-slate-400 block mb-1">
              {t({ ko: "이름", en: "Label", ja: "ラベル", zh: "名称", pt: "Nome" })}
            </label>
            <input
              type="text"
              value={formData.label ?? ""}
              onChange={(e) => onChange("label", e.target.value)}
              placeholder={t({ ko: "계정 이름", en: "Account Name", ja: "アカウント名", zh: "账户名称", pt: "Nome da Conta" })}
              className="w-full rounded border border-slate-600 bg-slate-700/50 px-2 py-1.5 text-xs text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none"
            />
          </div>

          {provider === "claude" && (
            <>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Email</label>
                <input
                  type="email"
                  value={formData.email ?? ""}
                  onChange={(e) => onChange("email", e.target.value)}
                  placeholder="user@gmail.com"
                  className="w-full rounded border border-slate-600 bg-slate-700/50 px-2 py-1.5 text-xs text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Access Token</label>
                <input
                  type="password"
                  value={formData.accessToken ?? ""}
                  onChange={(e) => onChange("accessToken", e.target.value)}
                  placeholder="sk-ant-oat01-..."
                  className="w-full rounded border border-slate-600 bg-slate-700/50 px-2 py-1.5 text-xs text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Refresh Token</label>
                <input
                  type="password"
                  value={formData.refreshToken ?? ""}
                  onChange={(e) => onChange("refreshToken", e.target.value)}
                  placeholder="sk-ant-ort01-..."
                  className="w-full rounded border border-slate-600 bg-slate-700/50 px-2 py-1.5 text-xs text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">
                  {t({ ko: "구독 유형", en: "Subscription Type", ja: "サブスクリプション", zh: "订阅类型", pt: "Tipo de Assinatura" })}
                </label>
                <select
                  value={formData.subscriptionType ?? "max"}
                  onChange={(e) => onChange("subscriptionType", e.target.value)}
                  className="w-full rounded border border-slate-600 bg-slate-700/50 px-2 py-1.5 text-xs text-white focus:border-blue-500 focus:outline-none"
                >
                  <option value="max">Max</option>
                  <option value="pro">Pro</option>
                </select>
              </div>
            </>
          )}

          {(provider === "gemini" || provider === "codex") && (
            <div>
              <label className="text-xs text-slate-400 block mb-1">API Key</label>
              <input
                type="password"
                value={formData.apiKey ?? ""}
                onChange={(e) => onChange("apiKey", e.target.value)}
                placeholder={provider === "gemini" ? "AIza..." : "sk-..."}
                className="w-full rounded border border-slate-600 bg-slate-700/50 px-2 py-1.5 text-xs text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none"
              />
            </div>
          )}
        </div>

        <div className="flex gap-2 justify-end pt-1">
          <button
            onClick={onClose}
            className="px-3 py-1.5 bg-slate-600 hover:bg-slate-500 text-white text-xs rounded transition-colors"
          >
            {t({ ko: "취소", en: "Cancel", ja: "キャンセル", zh: "取消", pt: "Cancelar" })}
          </button>
          <button
            onClick={onSubmit}
            disabled={saving}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded transition-colors disabled:opacity-50"
          >
            {saving
              ? t({ ko: "추가 중...", en: "Adding...", ja: "追加中...", zh: "添加中...", pt: "Adicionando..." })
              : t({ ko: "추가", en: "Add Account", ja: "追加", zh: "添加", pt: "Adicionar Conta" })}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fallback Settings Section
// ---------------------------------------------------------------------------

interface FallbackSettingsSectionProps {
  settings: FallbackSettings;
  onUpdate: (key: string, value: unknown) => void;
  t: TFunction;
}

function FallbackSettingsSection({ settings, onUpdate, t }: FallbackSettingsSectionProps) {
  return (
    <div className="rounded-lg bg-slate-700/30 p-3 space-y-3">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
        {t({
          ko: "자동 전환 & 폴백",
          en: "Auto-Rotation & Fallback",
          ja: "自動切替 & フォールバック",
          zh: "自动切换与回退",
          pt: "Rotacao Automatica & Fallback",
        })}
      </h4>

      {/* Toggle rows */}
      <div className="space-y-2">
        <ToggleRow
          label={t({
            ko: "자동 전환 활성화",
            en: "Enable auto-rotation",
            ja: "自動切替を有効化",
            zh: "启用自动切换",
            pt: "Ativar rotacao automatica",
          })}
          value={settings.enabled}
          onChange={(v) => onUpdate("enabled", v)}
        />
        <ToggleRow
          label={t({
            ko: "자동 계정 전환",
            en: "Auto-switch accounts",
            ja: "自動アカウント切替",
            zh: "自动切换账户",
            pt: "Trocar contas automaticamente",
          })}
          value={settings.autoSwitch}
          onChange={(v) => onUpdate("autoSwitch", v)}
        />
        <ToggleRow
          label={t({
            ko: "Telegram 알림",
            en: "Telegram alerts",
            ja: "Telegram アラート",
            zh: "Telegram 通知",
            pt: "Alertas Telegram",
          })}
          value={settings.telegramAlerts}
          onChange={(v) => onUpdate("telegramAlerts", v)}
        />
      </div>

      {/* Threshold */}
      <div className="flex items-center gap-3">
        <span className="text-xs text-slate-400 shrink-0">
          {t({ ko: "임계값:", en: "Threshold:", ja: "閾値:", zh: "阈值:", pt: "Limite:" })}
        </span>
        <input
          type="range"
          min="50"
          max="100"
          value={settings.thresholdPct}
          onChange={(e) => onUpdate("thresholdPct", Number(e.target.value))}
          className="flex-1 h-1 accent-blue-500"
        />
        <span className="text-xs text-white font-mono w-8 text-right">{settings.thresholdPct}%</span>
      </div>

      {/* Fallback chain display */}
      <div className="space-y-1">
        <span className="text-xs text-slate-400">
          {t({ ko: "폴백 체인:", en: "Fallback chain:", ja: "フォールバック:", zh: "回退链:", pt: "Cadeia de fallback:" })}
        </span>
        <div className="flex flex-wrap gap-1">
          {Object.entries(settings.fallbackChain).map(([provider, chain]) => (
            <span key={provider} className="text-xs text-slate-300 bg-slate-600/50 px-2 py-0.5 rounded">
              {provider} {"\u2192"} {(chain as string[]).join(" \u2192 ")}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toggle Row
// ---------------------------------------------------------------------------

function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-slate-300">{label}</span>
      <button
        onClick={() => onChange(!value)}
        className={`relative w-8 h-4 rounded-full transition-colors ${
          value ? "bg-blue-500" : "bg-slate-600"
        }`}
      >
        <span
          className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
            value ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </button>
    </div>
  );
}
