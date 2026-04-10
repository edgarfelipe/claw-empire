import type { RuntimeContext } from "../../../types/runtime-context.ts";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const CLAUDE_ACCOUNTS_PATH = "/home/i9-server/.openclaw/workspace/services/claude-code-proxy/accounts.json";
const OLLAMA_API = "http://localhost:11434/api/tags";

interface ClaudeAccount {
  id: string;
  email: string;
  label?: string;
  subscriptionType?: string;
  rateLimitTier?: string;
  savedAt?: string;
  expiresAt?: number;
  credentials?: Record<string, unknown>;
}

interface ClaudeAccountsFile {
  activeAccount: string;
  accounts: ClaudeAccount[];
}

interface ProviderAuthStatus {
  authenticated: boolean;
  account?: string;
  plan?: string;
  method?: string;
  models?: number;
  accounts?: Array<{ id: string; email: string; label?: string; plan?: string; active: boolean }>;
}

interface ProviderAccountRow {
  id: string;
  provider: string;
  label: string;
  credentials_enc: string | null;
  is_active: number;
  last_usage_pct: number;
  last_usage_check: number | null;
  status: string;
  created_at: number;
}

interface FallbackSettingsRow {
  id: string;
  enabled: number;
  threshold_pct: number;
  warn_pct: number;
  telegram_alerts: number;
  auto_switch: number;
  fallback_chain: string;
  updated_at: number;
}

interface UsageEventRow {
  id: string;
  provider: string;
  account_id: string | null;
  event_type: string;
  usage_pct: number | null;
  details: string | null;
  created_at: number;
}

function getClaudeAuthStatus(): ProviderAuthStatus {
  try {
    if (!existsSync(CLAUDE_ACCOUNTS_PATH)) {
      return { authenticated: false };
    }
    const raw = readFileSync(CLAUDE_ACCOUNTS_PATH, "utf-8");
    const data: ClaudeAccountsFile = JSON.parse(raw);
    const activeId = data.activeAccount;
    const activeAccount = data.accounts?.find((a) => a.id === activeId);

    return {
      authenticated: !!activeAccount,
      account: activeAccount?.email ?? activeId,
      plan: activeAccount?.subscriptionType?.toUpperCase() ?? "unknown",
      activeAccountId: activeId,
      accounts: (data.accounts ?? []).map((a) => ({
        id: a.id,
        email: a.email,
        label: a.label,
        subscriptionType: a.subscriptionType,
        plan: a.subscriptionType?.toUpperCase(),
        active: a.id === activeId,
      })),
    };
  } catch {
    return { authenticated: false };
  }
}

function getCodexAuthStatus(): ProviderAuthStatus {
  try {
    const result = execSync("codex --version 2>&1", { timeout: 5000, encoding: "utf-8" });
    return {
      authenticated: true,
      account: "default",
      method: "cli",
    };
  } catch {
    return { authenticated: false };
  }
}

function getGeminiAuthStatus(): ProviderAuthStatus {
  const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (apiKey) {
    const masked = apiKey.slice(0, 6) + "..." + apiKey.slice(-4);
    return {
      authenticated: true,
      method: "api_key",
      account: masked,
    };
  }
  return { authenticated: false };
}

function getGitHubAuthStatus(db: RuntimeContext["db"]): ProviderAuthStatus {
  try {
    const row = db
      .prepare(
        "SELECT provider_login FROM oauth_accounts WHERE provider = 'github-copilot' AND status = 'active' LIMIT 1",
      )
      .get() as { provider_login?: string } | undefined;

    if (row?.provider_login) {
      return {
        authenticated: true,
        account: row.provider_login,
      };
    }

    const anyRow = db
      .prepare("SELECT provider_login FROM oauth_accounts WHERE provider = 'github-copilot' LIMIT 1")
      .get() as { provider_login?: string } | undefined;

    return {
      authenticated: !!anyRow,
      account: anyRow?.provider_login ?? undefined,
    };
  } catch {
    return { authenticated: false };
  }
}

function getOllamaAuthStatus(): ProviderAuthStatus {
  try {
    const result = execSync(`curl -s --max-time 3 ${OLLAMA_API}`, {
      timeout: 5000,
      encoding: "utf-8",
    });
    const data = JSON.parse(result);
    const modelCount = Array.isArray(data.models) ? data.models.length : 0;
    return {
      authenticated: true,
      models: modelCount,
      method: "local",
    };
  } catch {
    return { authenticated: false };
  }
}

export function registerAuthManagementRoutes(ctx: RuntimeContext): void {
  const { app, db } = ctx;

  // -------------------------------------------------------------------------
  // GET /api/auth/management/status — Returns auth status for all providers
  // -------------------------------------------------------------------------
  app.get("/api/auth/management/status", async (_req, res) => {
    try {
      const [claude, codex, gemini, github, ollama] = await Promise.all([
        Promise.resolve(getClaudeAuthStatus()),
        Promise.resolve(getCodexAuthStatus()),
        Promise.resolve(getGeminiAuthStatus()),
        Promise.resolve(getGitHubAuthStatus(db)),
        Promise.resolve(getOllamaAuthStatus()),
      ]);

      res.json({ claude, codex, gemini, github, ollama });
    } catch (err) {
      console.error("[auth-management] Failed to get auth status:", err);
      res.status(500).json({ error: "auth_status_failed", message: String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/auth/management/switch-account — Switch Claude active account
  // -------------------------------------------------------------------------
  app.post("/api/auth/management/switch-account", async (req, res) => {
    try {
      const { provider, accountId } = req.body as { provider: string; accountId: string };

      if (provider !== "claude") {
        return res.status(400).json({ error: "unsupported_provider", message: "Account switching only supported for Claude" });
      }

      if (!existsSync(CLAUDE_ACCOUNTS_PATH)) {
        return res.status(404).json({ error: "accounts_not_found", message: "Claude accounts.json not found" });
      }

      const raw = readFileSync(CLAUDE_ACCOUNTS_PATH, "utf-8");
      const data: ClaudeAccountsFile = JSON.parse(raw);

      const account = data.accounts?.find((a) => a.id === accountId);
      if (!account) {
        return res.status(404).json({ error: "account_not_found", message: `Account ${accountId} not found` });
      }

      data.activeAccount = accountId;
      writeFileSync(CLAUDE_ACCOUNTS_PATH, JSON.stringify(data, null, 2), "utf-8");

      // Also update the REAL Claude Code credentials file
      const claudeCredsPath = path.join(process.env.HOME || "/home/i9-server", ".claude", ".credentials.json");
      try {
        const oauthCreds = account.credentials?.claudeAiOauth as Record<string, unknown> | undefined;
        if (oauthCreds && existsSync(claudeCredsPath)) {
          const realCreds = JSON.parse(readFileSync(claudeCredsPath, "utf-8"));
          realCreds.claudeAiOauth = {
            accessToken: oauthCreds.accessToken,
            refreshToken: oauthCreds.refreshToken,
            expiresAt: oauthCreds.expiresAt,
            scopes: oauthCreds.scopes,
            subscriptionType: oauthCreds.subscriptionType,
            rateLimitTier: oauthCreds.rateLimitTier,
          };
          if (account.credentials?.organizationUuid) {
            realCreds.organizationUuid = account.credentials.organizationUuid;
          }
          writeFileSync(claudeCredsPath, JSON.stringify(realCreds, null, 2), "utf-8");
          console.info(`[auth-management] Switched Claude credentials to ${account.email}`);
        }
      } catch (credErr) {
        console.warn("[auth-management] Could not update Claude credentials file:", credErr);
      }

      // Force refresh CLI usage data after switch (wait a moment for CLI to pick up new creds)
      setTimeout(async () => {
        try {
          await fetch("http://localhost:8790/api/cli-usage/refresh", {
            method: "POST",
            headers: { Authorization: `Bearer ${process.env.API_AUTH_TOKEN || ""}` },
          });
        } catch { /* ignore */ }
      }, 3000);

      res.json({ ok: true, activeAccount: accountId, email: account.email });
    } catch (err) {
      console.error("[auth-management] Failed to switch account:", err);
      res.status(500).json({ error: "switch_failed", message: String(err) });
    }
  });

  // POST /api/auth/management/login — Trigger OAuth login and return URL
  app.post("/api/auth/management/login", async (req, res) => {
    try {
      const { provider, email } = req.body as { provider: string; email?: string };
      if (provider !== "claude") {
        return res.status(400).json({ error: "unsupported_provider" });
      }
      const emailFlag = email ? ` --email "${email}"` : "";
      const output = execSync(
        `timeout 5 bash -c 'claude auth login --claudeai${emailFlag} 2>&1' || true`,
        { encoding: "utf-8", timeout: 8000 }
      );
      const urlMatch = output.match(/(https:\/\/claude\.com\/cai\/oauth\/authorize[^\s]+)/);
      if (!urlMatch) {
        if (output.includes("already") || output.includes("logged in")) {
          return res.json({ ok: true, alreadyAuthenticated: true });
        }
        return res.status(500).json({ error: "no_url", output });
      }
      res.json({ ok: true, loginUrl: urlMatch[1] });
    } catch (err) {
      res.status(500).json({ error: "login_failed", message: String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/auth/management/update-key — Update API key for a provider
  // -------------------------------------------------------------------------
  app.post("/api/auth/management/update-key", async (req, res) => {
    try {
      const { provider, apiKey } = req.body as { provider: string; apiKey: string };

      if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length === 0) {
        return res.status(400).json({ error: "invalid_key", message: "API key is required" });
      }

      if (provider === "gemini") {
        process.env.GOOGLE_API_KEY = apiKey.trim();
        process.env.GEMINI_API_KEY = apiKey.trim();

        const envPath = path.resolve(process.cwd(), ".env");
        try {
          let envContent = "";
          if (existsSync(envPath)) {
            envContent = readFileSync(envPath, "utf-8");
          }

          if (envContent.includes("GOOGLE_API_KEY=")) {
            envContent = envContent.replace(/GOOGLE_API_KEY=.*/g, `GOOGLE_API_KEY=${apiKey.trim()}`);
          } else {
            envContent += `\nGOOGLE_API_KEY=${apiKey.trim()}\n`;
          }

          if (envContent.includes("GEMINI_API_KEY=")) {
            envContent = envContent.replace(/GEMINI_API_KEY=.*/g, `GEMINI_API_KEY=${apiKey.trim()}`);
          } else {
            envContent += `GEMINI_API_KEY=${apiKey.trim()}\n`;
          }

          writeFileSync(envPath, envContent, "utf-8");
        } catch {
          // .env write failed — runtime update is still active
        }

        return res.json({ ok: true, provider: "gemini" });
      }

      return res.status(400).json({ error: "unsupported_provider", message: `API key update not supported for ${provider}` });
    } catch (err) {
      console.error("[auth-management] Failed to update key:", err);
      res.status(500).json({ error: "update_key_failed", message: String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/auth/management/add-account — Add a new provider account
  // -------------------------------------------------------------------------
  app.post("/api/auth/management/add-account", async (req, res) => {
    try {
      const { provider, label, credentials } = req.body as {
        provider: string;
        label: string;
        credentials: Record<string, unknown>;
      };

      if (!provider || !label || !credentials) {
        return res.status(400).json({ error: "invalid_input", message: "provider, label, and credentials are required" });
      }

      if (provider === "claude") {
        // Add to accounts.json
        const accessToken = String(credentials.accessToken ?? "").trim();
        const refreshToken = String(credentials.refreshToken ?? "").trim();
        const email = String(credentials.email ?? "").trim();
        const subscriptionType = String(credentials.subscriptionType ?? "max").trim();

        if (!accessToken || !email) {
          return res.status(400).json({ error: "invalid_credentials", message: "accessToken and email are required for Claude" });
        }

        // Derive account id from email (before @)
        const accountId = email.split("@")[0].toLowerCase().replace(/[^a-z0-9]/g, "");

        let data: ClaudeAccountsFile = { activeAccount: "", accounts: [] };
        if (existsSync(CLAUDE_ACCOUNTS_PATH)) {
          const raw = readFileSync(CLAUDE_ACCOUNTS_PATH, "utf-8");
          data = JSON.parse(raw);
        }

        // Check for duplicate
        if (data.accounts?.some((a) => a.id === accountId || a.email === email)) {
          return res.status(409).json({ error: "duplicate_account", message: `Account ${email} already exists` });
        }

        const newAccount: ClaudeAccount = {
          id: accountId,
          email,
          label: `${subscriptionType.toUpperCase()} (${email})`,
          subscriptionType,
          rateLimitTier: subscriptionType === "max" ? "default_claude_max_20x" : "default",
          savedAt: new Date().toISOString(),
          expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
          credentials: {
            claudeAiOauth: {
              accessToken,
              refreshToken,
              expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
              scopes: [
                "user:file_upload",
                "user:inference",
                "user:mcp_servers",
                "user:profile",
                "user:sessions:claude_code",
              ],
              subscriptionType,
              rateLimitTier: subscriptionType === "max" ? "default_claude_max_20x" : "default",
            },
          },
        };

        data.accounts = data.accounts ?? [];
        data.accounts.push(newAccount);

        // If no active account, set this as active
        if (!data.activeAccount) {
          data.activeAccount = accountId;
        }

        writeFileSync(CLAUDE_ACCOUNTS_PATH, JSON.stringify(data, null, 2), "utf-8");

        // Also track in provider_accounts table
        try {
          db.prepare(
            "INSERT OR IGNORE INTO provider_accounts (id, provider, label, is_active, status) VALUES (?, ?, ?, ?, 'active')"
          ).run(accountId, "claude", label, data.activeAccount === accountId ? 1 : 0);
        } catch {
          // table might not exist yet — non-fatal
        }

        return res.json({ ok: true, accountId, email, provider: "claude" });
      }

      if (provider === "gemini" || provider === "codex") {
        const apiKey = String(credentials.apiKey ?? "").trim();
        if (!apiKey) {
          return res.status(400).json({ error: "invalid_credentials", message: "apiKey is required" });
        }

        const accountId = randomUUID();
        try {
          db.prepare(
            "INSERT INTO provider_accounts (id, provider, label, credentials_enc, is_active, status) VALUES (?, ?, ?, ?, 0, 'active')"
          ).run(accountId, provider, label, apiKey);
        } catch (err) {
          return res.status(500).json({ error: "db_error", message: String(err) });
        }

        // If this is the first account for this provider, set as active
        const countRow = db.prepare("SELECT COUNT(*) as cnt FROM provider_accounts WHERE provider = ?").get(provider) as { cnt: number };
        if (countRow.cnt === 1) {
          db.prepare("UPDATE provider_accounts SET is_active = 1 WHERE id = ?").run(accountId);

          // For gemini/codex, also update the runtime env
          if (provider === "gemini") {
            process.env.GOOGLE_API_KEY = apiKey;
            process.env.GEMINI_API_KEY = apiKey;
          }
        }

        return res.json({ ok: true, accountId, provider });
      }

      return res.status(400).json({ error: "unsupported_provider", message: `Adding accounts not supported for ${provider}` });
    } catch (err) {
      console.error("[auth-management] Failed to add account:", err);
      res.status(500).json({ error: "add_account_failed", message: String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /api/auth/management/remove-account — Remove a provider account
  // -------------------------------------------------------------------------
  app.post("/api/auth/management/remove-account", async (req, res) => {
    try {
      const { provider, accountId } = req.body as { provider: string; accountId: string };

      if (!provider || !accountId) {
        return res.status(400).json({ error: "invalid_input", message: "provider and accountId are required" });
      }

      if (provider === "claude") {
        if (!existsSync(CLAUDE_ACCOUNTS_PATH)) {
          return res.status(404).json({ error: "accounts_not_found", message: "Claude accounts.json not found" });
        }

        const raw = readFileSync(CLAUDE_ACCOUNTS_PATH, "utf-8");
        const data: ClaudeAccountsFile = JSON.parse(raw);

        const accountIndex = data.accounts?.findIndex((a) => a.id === accountId) ?? -1;
        if (accountIndex === -1) {
          return res.status(404).json({ error: "account_not_found", message: `Account ${accountId} not found` });
        }

        // Don't allow removing the last account
        if ((data.accounts?.length ?? 0) <= 1) {
          return res.status(400).json({ error: "last_account", message: "Cannot remove the last account" });
        }

        data.accounts!.splice(accountIndex, 1);

        // If we removed the active account, switch to another
        if (data.activeAccount === accountId && data.accounts!.length > 0) {
          data.activeAccount = data.accounts![0].id;
        }

        writeFileSync(CLAUDE_ACCOUNTS_PATH, JSON.stringify(data, null, 2), "utf-8");

        // Also remove from provider_accounts
        try {
          db.prepare("DELETE FROM provider_accounts WHERE id = ? AND provider = ?").run(accountId, "claude");
        } catch {
          // non-fatal
        }

        return res.json({ ok: true, removedId: accountId, newActive: data.activeAccount });
      }

      if (provider === "gemini" || provider === "codex") {
        try {
          const result = db.prepare("DELETE FROM provider_accounts WHERE id = ? AND provider = ?").run(accountId, provider) as { changes?: number };
          if ((result.changes ?? 0) === 0) {
            return res.status(404).json({ error: "account_not_found", message: `Account ${accountId} not found` });
          }
        } catch (err) {
          return res.status(500).json({ error: "db_error", message: String(err) });
        }

        return res.json({ ok: true, removedId: accountId });
      }

      return res.status(400).json({ error: "unsupported_provider", message: `Removing accounts not supported for ${provider}` });
    } catch (err) {
      console.error("[auth-management] Failed to remove account:", err);
      res.status(500).json({ error: "remove_account_failed", message: String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/auth/management/accounts — All accounts per provider with usage
  // -------------------------------------------------------------------------
  app.get("/api/auth/management/accounts", async (_req, res) => {
    try {
      // Fetch real-time usage data from internal CLI usage endpoint
      let cliUsage: Record<string, { windows?: Array<{ label: string; utilization: number; resetsAt?: string }> }> = {};
      try {
        const usageRes = await fetch("http://localhost:8790/api/cli-usage", {
          headers: { Authorization: `Bearer ${process.env.API_AUTH_TOKEN || ""}` },
        });
        if (usageRes.ok) {
          const usageData = await usageRes.json() as { usage?: typeof cliUsage };
          cliUsage = usageData.usage ?? {};
        }
      } catch { /* ignore */ }

      // Get max usage % per provider from real CLI data
      function getMaxUsage(provider: string): { pct: number; details: Array<{ label: string; pct: number; resetsAt?: string }> } {
        const data = cliUsage[provider];
        if (!data?.windows?.length) return { pct: 0, details: [] };
        const details = data.windows.map((w) => ({
          label: w.label,
          pct: Math.round((w.utilization ?? 0) * 100),
          resetsAt: w.resetsAt,
        }));
        const maxPct = Math.max(...details.map((d) => d.pct), 0);
        return { pct: maxPct, details };
      }

      const claudeUsage = getMaxUsage("claude");
      const codexUsage = getMaxUsage("codex");
      const geminiUsage = getMaxUsage("gemini");

      // Claude accounts from accounts.json
      const claudeAccounts: Array<{
        id: string;
        provider: string;
        label: string;
        email: string;
        isActive: boolean;
        plan: string;
        usagePct: number;
        usageDetails: Array<{ label: string; pct: number; resetsAt?: string }>;
        status: string;
      }> = [];

      if (existsSync(CLAUDE_ACCOUNTS_PATH)) {
        const raw = readFileSync(CLAUDE_ACCOUNTS_PATH, "utf-8");
        const data: ClaudeAccountsFile = JSON.parse(raw);
        for (const a of data.accounts ?? []) {
          const isActive = a.id === data.activeAccount;
          // Active account gets the real usage data; inactive shows 0
          const usagePct = isActive ? claudeUsage.pct : 0;
          const usageDetails = isActive ? claudeUsage.details : [];

          let status = "active";
          try {
            const row = db.prepare("SELECT status FROM provider_accounts WHERE id = ? AND provider = 'claude'").get(a.id) as ProviderAccountRow | undefined;
            if (row?.status) status = row.status;
          } catch { /* ignore */ }

          claudeAccounts.push({
            id: a.id,
            provider: "claude",
            label: a.label ?? a.email,
            email: a.email,
            isActive,
            plan: a.subscriptionType?.toUpperCase() ?? "unknown",
            usagePct,
            usageDetails,
            status,
          });
        }
      }

      // Gemini/Codex accounts from provider_accounts table
      let dbAccounts: Array<{
        id: string;
        provider: string;
        label: string;
        isActive: boolean;
        usagePct: number;
        status: string;
      }> = [];
      try {
        const rows = db
          .prepare("SELECT * FROM provider_accounts WHERE provider IN ('gemini', 'codex') ORDER BY provider, created_at")
          .all() as unknown as ProviderAccountRow[];
        dbAccounts = rows.map((r) => ({
          id: r.id,
          provider: r.provider,
          label: r.label,
          isActive: r.is_active === 1,
          usagePct: r.last_usage_pct ?? 0,
          status: r.status ?? "active",
        }));
      } catch {
        // table might not exist
      }

      // Build codex accounts: merge DB accounts with real usage
      let codexAccts = dbAccounts.filter((a) => a.provider === "codex");
      if (codexAccts.length === 0 && codexUsage.pct >= 0) {
        // No DB accounts but CLI is active — show as default account
        codexAccts = [{
          id: "codex-default",
          provider: "codex",
          label: "Codex CLI (default)",
          isActive: true,
          usagePct: codexUsage.pct,
          status: "active",
        }];
      } else {
        codexAccts = codexAccts.map((a) => ({ ...a, usagePct: a.isActive ? codexUsage.pct : a.usagePct }));
      }

      // Build gemini accounts: merge DB accounts with real usage
      let geminiAccts = dbAccounts.filter((a) => a.provider === "gemini");
      if (geminiAccts.length === 0 && geminiUsage.pct >= 0) {
        geminiAccts = [{
          id: "gemini-default",
          provider: "gemini",
          label: "Gemini CLI (API Key)",
          isActive: true,
          usagePct: geminiUsage.pct,
          status: "active",
        }];
      } else {
        geminiAccts = geminiAccts.map((a) => ({ ...a, usagePct: a.isActive ? geminiUsage.pct : a.usagePct }));
      }

      res.json({
        ok: true,
        accounts: {
          claude: claudeAccounts,
          codex: codexAccts,
          gemini: geminiAccts,
        },
        usage: {
          claude: claudeUsage,
          codex: codexUsage,
          gemini: geminiUsage,
        },
      });
    } catch (err) {
      console.error("[auth-management] Failed to get accounts:", err);
      res.status(500).json({ error: "get_accounts_failed", message: String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/auth/management/fallback-settings — Get fallback settings
  // -------------------------------------------------------------------------
  app.get("/api/auth/management/fallback-settings", async (_req, res) => {
    try {
      // Ensure default row exists
      db.prepare("INSERT OR IGNORE INTO fallback_settings (id) VALUES ('default')").run();

      const row = db.prepare("SELECT * FROM fallback_settings WHERE id = 'default'").get() as FallbackSettingsRow | undefined;
      if (!row) {
        return res.json({
          ok: true,
          settings: {
            enabled: true,
            thresholdPct: 95,
            warnPct: 80,
            telegramAlerts: true,
            autoSwitch: true,
            fallbackChain: { claude: ["codex", "ollama"], codex: ["claude", "ollama"], gemini: ["ollama"] },
          },
        });
      }

      let fallbackChain: Record<string, string[]>;
      try {
        fallbackChain = JSON.parse(row.fallback_chain);
      } catch {
        fallbackChain = { claude: ["codex", "ollama"], codex: ["claude", "ollama"], gemini: ["ollama"] };
      }

      res.json({
        ok: true,
        settings: {
          enabled: row.enabled === 1,
          thresholdPct: row.threshold_pct,
          warnPct: row.warn_pct,
          telegramAlerts: row.telegram_alerts === 1,
          autoSwitch: row.auto_switch === 1,
          fallbackChain,
        },
      });
    } catch (err) {
      console.error("[auth-management] Failed to get fallback settings:", err);
      res.status(500).json({ error: "get_fallback_settings_failed", message: String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/auth/management/fallback-settings — Update fallback settings
  // -------------------------------------------------------------------------
  app.post("/api/auth/management/fallback-settings", async (req, res) => {
    try {
      const { enabled, thresholdPct, warnPct, telegramAlerts, autoSwitch, fallbackChain } = req.body as {
        enabled?: boolean;
        thresholdPct?: number;
        warnPct?: number;
        telegramAlerts?: boolean;
        autoSwitch?: boolean;
        fallbackChain?: Record<string, string[]>;
      };

      // Ensure default row
      db.prepare("INSERT OR IGNORE INTO fallback_settings (id) VALUES ('default')").run();

      if (enabled !== undefined) {
        db.prepare("UPDATE fallback_settings SET enabled = ?, updated_at = ? WHERE id = 'default'").run(enabled ? 1 : 0, Date.now());
      }
      if (typeof thresholdPct === "number") {
        db.prepare("UPDATE fallback_settings SET threshold_pct = ?, updated_at = ? WHERE id = 'default'").run(Math.max(50, Math.min(100, thresholdPct)), Date.now());
      }
      if (typeof warnPct === "number") {
        db.prepare("UPDATE fallback_settings SET warn_pct = ?, updated_at = ? WHERE id = 'default'").run(Math.max(30, Math.min(99, warnPct)), Date.now());
      }
      if (telegramAlerts !== undefined) {
        db.prepare("UPDATE fallback_settings SET telegram_alerts = ?, updated_at = ? WHERE id = 'default'").run(telegramAlerts ? 1 : 0, Date.now());
      }
      if (autoSwitch !== undefined) {
        db.prepare("UPDATE fallback_settings SET auto_switch = ?, updated_at = ? WHERE id = 'default'").run(autoSwitch ? 1 : 0, Date.now());
      }
      if (fallbackChain) {
        db.prepare("UPDATE fallback_settings SET fallback_chain = ?, updated_at = ? WHERE id = 'default'").run(JSON.stringify(fallbackChain), Date.now());
      }

      res.json({ ok: true });
    } catch (err) {
      console.error("[auth-management] Failed to update fallback settings:", err);
      res.status(500).json({ error: "update_fallback_settings_failed", message: String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/auth/management/usage-events — Recent usage events
  // -------------------------------------------------------------------------
  app.get("/api/auth/management/usage-events", async (_req, res) => {
    try {
      const limit = Math.min(Number(_req.query.limit) || 50, 200);
      const rows = db
        .prepare("SELECT * FROM usage_events ORDER BY created_at DESC LIMIT ?")
        .all(limit) as unknown as UsageEventRow[];

      res.json({ ok: true, events: rows });
    } catch (err) {
      console.error("[auth-management] Failed to get usage events:", err);
      res.status(500).json({ error: "get_usage_events_failed", message: String(err) });
    }
  });
}
