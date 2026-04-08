import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { sendTelegramAlert } from "./telegram-alert.ts";

const CLAUDE_ACCOUNTS_PATH = "/home/i9-server/.openclaw/workspace/services/claude-code-proxy/accounts.json";
const CHECK_INTERVAL_MS = 60_000;
const RECOVERY_THRESHOLD_PCT = 50;

// Deduplication: avoid sending the same alert type more than once per cooldown
const ALERT_COOLDOWN_MS = 5 * 60_000; // 5 minutes

interface FallbackSettings {
  enabled: number;
  threshold_pct: number;
  warn_pct: number;
  telegram_alerts: number;
  auto_switch: number;
  fallback_chain: string;
}

interface CliUsageWindow {
  label?: string;
  percentage?: number;
  pct?: number;
  [key: string]: unknown;
}

interface CliUsageEntry {
  windows?: CliUsageWindow[];
  error?: string | null;
  [key: string]: unknown;
}

interface ClaudeAccount {
  id: string;
  email: string;
  label?: string;
  subscriptionType?: string;
}

interface ClaudeAccountsFile {
  activeAccount: string;
  accounts: ClaudeAccount[];
}

type BroadcastFn = (type: string, payload: unknown) => void;

export class UsageMonitor {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private db: DatabaseSync;
  private broadcast: BroadcastFn;
  private lastAlerts: Map<string, number> = new Map();
  private refreshCliUsageData: (() => Promise<Record<string, CliUsageEntry>>) | null = null;

  constructor(db: DatabaseSync, broadcast: BroadcastFn) {
    this.db = db;
    this.broadcast = broadcast;
  }

  setRefreshCliUsageData(fn: () => Promise<Record<string, CliUsageEntry>>): void {
    this.refreshCliUsageData = fn;
  }

  start(): void {
    if (this.intervalId) return;
    console.log("[usage-monitor] Started (interval: 60s)");
    this.intervalId = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    // First check after 30s to let everything initialize
    setTimeout(() => void this.check(), 30_000);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private getSettings(): FallbackSettings {
    try {
      const row = this.db
        .prepare("SELECT * FROM fallback_settings WHERE id = 'default'")
        .get() as FallbackSettings | undefined;

      if (row) return row;
    } catch {
      // Table might not exist yet
    }

    // Ensure default row exists
    try {
      this.db.prepare(
        "INSERT OR IGNORE INTO fallback_settings (id) VALUES ('default')"
      ).run();
    } catch {
      // ignore
    }

    return {
      enabled: 1,
      threshold_pct: 95,
      warn_pct: 80,
      telegram_alerts: 1,
      auto_switch: 1,
      fallback_chain: '{"claude":["codex","ollama"],"codex":["claude","ollama"],"gemini":["ollama"]}',
    };
  }

  private getMaxUsagePct(entry: CliUsageEntry): number {
    if (!entry.windows || !Array.isArray(entry.windows)) return 0;
    let maxPct = 0;
    for (const w of entry.windows) {
      const pct = typeof w.percentage === "number" ? w.percentage : typeof w.pct === "number" ? w.pct : 0;
      if (pct > maxPct) maxPct = pct;
    }
    return maxPct;
  }

  private shouldAlert(key: string): boolean {
    const last = this.lastAlerts.get(key);
    if (last && Date.now() - last < ALERT_COOLDOWN_MS) return false;
    this.lastAlerts.set(key, Date.now());
    return true;
  }

  private logEvent(provider: string, accountId: string | null, eventType: string, usagePct: number, details: string): void {
    try {
      this.db.prepare(
        "INSERT INTO usage_events (id, provider, account_id, event_type, usage_pct, details) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(randomUUID(), provider, accountId, eventType, usagePct, details);
    } catch {
      // ignore logging errors
    }
  }

  private updateAccountUsage(provider: string, accountId: string, usagePct: number, status: string): void {
    try {
      this.db.prepare(
        "UPDATE provider_accounts SET last_usage_pct = ?, last_usage_check = ?, status = ? WHERE id = ? AND provider = ?"
      ).run(usagePct, Date.now(), status, accountId, provider);
    } catch {
      // ignore
    }
  }

  private async sendAlert(message: string, settings: FallbackSettings): Promise<void> {
    if (settings.telegram_alerts) {
      await sendTelegramAlert(this.db, message);
    }
    // Also broadcast to WebSocket clients
    this.broadcast("usage_alert", { message, ts: Date.now() });
  }

  private switchClaudeAccount(nextAccountId: string): { success: boolean; oldAccount: string; newAccount: string } {
    try {
      if (!existsSync(CLAUDE_ACCOUNTS_PATH)) {
        return { success: false, oldAccount: "", newAccount: nextAccountId };
      }

      const raw = readFileSync(CLAUDE_ACCOUNTS_PATH, "utf-8");
      const data: ClaudeAccountsFile = JSON.parse(raw);
      const oldAccount = data.activeAccount;

      const account = data.accounts?.find((a) => a.id === nextAccountId);
      if (!account) {
        return { success: false, oldAccount, newAccount: nextAccountId };
      }

      data.activeAccount = nextAccountId;
      writeFileSync(CLAUDE_ACCOUNTS_PATH, JSON.stringify(data, null, 2), "utf-8");

      return { success: true, oldAccount, newAccount: nextAccountId };
    } catch (err) {
      console.error("[usage-monitor] Failed to switch Claude account:", err);
      return { success: false, oldAccount: "", newAccount: nextAccountId };
    }
  }

  private getClaudeAccounts(): ClaudeAccount[] {
    try {
      if (!existsSync(CLAUDE_ACCOUNTS_PATH)) return [];
      const raw = readFileSync(CLAUDE_ACCOUNTS_PATH, "utf-8");
      const data: ClaudeAccountsFile = JSON.parse(raw);
      return data.accounts ?? [];
    } catch {
      return [];
    }
  }

  private getActiveClaudeAccountId(): string {
    try {
      if (!existsSync(CLAUDE_ACCOUNTS_PATH)) return "";
      const raw = readFileSync(CLAUDE_ACCOUNTS_PATH, "utf-8");
      const data: ClaudeAccountsFile = JSON.parse(raw);
      return data.activeAccount ?? "";
    } catch {
      return "";
    }
  }

  private async activateFallback(provider: string, settings: FallbackSettings): Promise<void> {
    let chain: Record<string, string[]>;
    try {
      chain = JSON.parse(settings.fallback_chain);
    } catch {
      chain = { claude: ["codex", "ollama"], codex: ["claude", "ollama"], gemini: ["ollama"] };
    }

    const fallbacks = chain[provider] ?? [];
    if (fallbacks.length === 0) return;

    const fallbackProvider = fallbacks[0];
    const alertKey = `fallback_${provider}_${fallbackProvider}`;
    if (this.shouldAlert(alertKey)) {
      const message = `\u{1F6A8} *CRITICO*\nTodas as contas ${provider} estao esgotadas!\nAtivando fallback para ${fallbackProvider}...`;
      await this.sendAlert(message, settings);
      this.logEvent(provider, null, "fallback", 100, `Fallback: ${provider} -> ${fallbackProvider}`);
    }

    // Update agents using the exhausted provider to use the fallback
    try {
      this.db.prepare(
        "UPDATE agents SET cli_provider = ? WHERE cli_provider = ? AND status != 'offline'"
      ).run(fallbackProvider, provider);

      // Broadcast updated agents
      const agents = this.db.prepare("SELECT * FROM agents WHERE cli_provider = ?").all(fallbackProvider);
      for (const agent of agents) {
        this.broadcast("agent_status", agent);
      }
    } catch (err) {
      console.error("[usage-monitor] Failed to update agent providers:", err);
    }
  }

  async check(): Promise<void> {
    const settings = this.getSettings();
    if (!settings.enabled) return;

    // Get usage data
    let usage: Record<string, CliUsageEntry> = {};
    try {
      if (this.refreshCliUsageData) {
        usage = await this.refreshCliUsageData();
      } else {
        // Fallback: read from DB cache
        const rows = this.db.prepare("SELECT provider, data_json FROM cli_usage_cache").all() as Array<{
          provider: string;
          data_json: string;
        }>;
        for (const row of rows) {
          try {
            usage[row.provider] = JSON.parse(row.data_json);
          } catch {
            // skip
          }
        }
      }
    } catch (err) {
      console.error("[usage-monitor] Failed to fetch usage data:", err);
      return;
    }

    const providers = ["claude", "codex", "gemini"];

    for (const provider of providers) {
      const entry = usage[provider];
      if (!entry || entry.error) continue;

      const maxPct = this.getMaxUsagePct(entry);
      if (maxPct <= 0) continue;

      // Sync to provider_accounts if they exist
      if (provider === "claude") {
        const activeId = this.getActiveClaudeAccountId();
        if (activeId) {
          this.updateAccountUsage(provider, activeId, maxPct, maxPct >= settings.threshold_pct ? "exhausted" : "active");
        }
      }

      // Check thresholds
      if (maxPct >= settings.threshold_pct) {
        // CRITICAL: try auto-switch
        if (settings.auto_switch && provider === "claude") {
          const accounts = this.getClaudeAccounts();
          const activeId = this.getActiveClaudeAccountId();
          const nextAccount = accounts.find((a) => a.id !== activeId);

          if (nextAccount) {
            // Check if next account is also exhausted (from provider_accounts table)
            let nextExhausted = false;
            try {
              const row = this.db
                .prepare("SELECT status FROM provider_accounts WHERE id = ? AND provider = ?")
                .get(nextAccount.id, "claude") as { status?: string } | undefined;
              if (row?.status === "exhausted") nextExhausted = true;
            } catch {
              // no row = not tracked yet, assume available
            }

            if (!nextExhausted) {
              const alertKey = `critical_switch_${provider}_${activeId}`;
              if (this.shouldAlert(alertKey)) {
                const message = `\u{1F534} *Uso Critico*\n${provider} esta em ${Math.round(maxPct)}%!\nTrocando automaticamente para ${nextAccount.email}...`;
                await this.sendAlert(message, settings);
              }

              const result = this.switchClaudeAccount(nextAccount.id);
              if (result.success) {
                this.logEvent(provider, nextAccount.id, "switch", maxPct, `${result.oldAccount} -> ${result.newAccount}`);
                const successKey = `switch_success_${provider}_${nextAccount.id}`;
                if (this.shouldAlert(successKey)) {
                  const message = `\u2705 *Conta Trocada*\n${provider}: ${result.oldAccount} -> ${nextAccount.email}`;
                  await this.sendAlert(message, settings);
                }
                this.broadcast("account_switched", {
                  provider,
                  oldAccount: result.oldAccount,
                  newAccount: nextAccount.id,
                  newEmail: nextAccount.email,
                });
              }
            } else {
              // All Claude accounts exhausted -> activate fallback
              await this.activateFallback(provider, settings);
            }
          } else {
            // Only one account -> activate fallback
            await this.activateFallback(provider, settings);
          }
        } else if (maxPct >= settings.threshold_pct) {
          // Non-claude provider at critical -> activate fallback
          const alertKey = `critical_${provider}`;
          if (this.shouldAlert(alertKey)) {
            const message = `\u{1F534} *Uso Critico*\n${provider} esta em ${Math.round(maxPct)}%!`;
            await this.sendAlert(message, settings);
            this.logEvent(provider, null, "critical", maxPct, `${provider} at ${Math.round(maxPct)}%`);
          }
          if (settings.auto_switch) {
            await this.activateFallback(provider, settings);
          }
        }
      } else if (maxPct >= settings.warn_pct) {
        // WARNING
        const alertKey = `warning_${provider}`;
        if (this.shouldAlert(alertKey)) {
          const activeId = provider === "claude" ? this.getActiveClaudeAccountId() : "default";
          const message = `\u26A0\uFE0F *Alerta de Uso*\n${provider} esta em ${Math.round(maxPct)}% de uso.\nConta: ${activeId}`;
          await this.sendAlert(message, settings);
          this.logEvent(provider, activeId, "warning", maxPct, `${provider} at ${Math.round(maxPct)}%`);
        }
      }

      // Recovery check: if usage drops below threshold, recover exhausted accounts
      if (maxPct < RECOVERY_THRESHOLD_PCT && provider === "claude") {
        try {
          const exhaustedRows = this.db
            .prepare("SELECT id FROM provider_accounts WHERE provider = 'claude' AND status = 'exhausted'")
            .all() as Array<{ id: string }>;

          for (const row of exhaustedRows) {
            this.db
              .prepare("UPDATE provider_accounts SET status = 'active', last_usage_pct = ? WHERE id = ?")
              .run(maxPct, row.id);
            this.logEvent(provider, row.id, "recovery", maxPct, `Account recovered (usage: ${Math.round(maxPct)}%)`);
          }
        } catch {
          // ignore
        }
      }
    }
  }
}
