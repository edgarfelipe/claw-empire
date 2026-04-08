import type { DatabaseSync } from "node:sqlite";

const MESSENGER_SETTINGS_KEY = "messengerChannels";

type PersistedSession = {
  targetId?: unknown;
  enabled?: unknown;
  token?: unknown;
};

type PersistedTelegramChannel = {
  token?: unknown;
  sessions?: unknown;
  receiveEnabled?: unknown;
};

type PersistedMessengerChannels = {
  telegram?: PersistedTelegramChannel;
};

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeChatId(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return normalizeText(value);
}

/**
 * Resolve the first available Telegram bot token and chat ID from the
 * messengerChannels settings stored in SQLite.
 */
function resolveTelegramTarget(db: DatabaseSync): { token: string; chatId: string } | null {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(MESSENGER_SETTINGS_KEY) as
      | { value?: unknown }
      | undefined;
    const raw = normalizeText(row?.value);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as PersistedMessengerChannels;
    const telegram = parsed?.telegram;
    if (!telegram || typeof telegram !== "object") return null;

    // Try to decrypt the token. The token stored may be encrypted; for
    // runtime alerts we attempt a plain-text read first (the
    // decryptMessengerTokenForRuntime helper is not easily importable here
    // without circular deps). If the token looks like an encrypted blob we
    // skip. Most self-hosted setups store plain tokens.
    let channelToken = "";
    if (typeof telegram.token === "string" && telegram.token.trim()) {
      // Heuristic: encrypted blobs start with "enc:" or have no ":" prefix
      const raw = telegram.token.trim();
      // Try dynamic import of decrypt helper
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { decryptMessengerTokenForRuntime } = require("../../messenger/token-crypto.ts");
        channelToken = decryptMessengerTokenForRuntime("telegram", raw);
      } catch {
        channelToken = raw;
      }
    }

    if (!channelToken) return null;

    // Find first enabled session with a targetId
    if (Array.isArray(telegram.sessions)) {
      for (const session of telegram.sessions) {
        const s = (session ?? {}) as PersistedSession;
        if (s.enabled === false) continue;
        const chatId = normalizeChatId(s.targetId);
        if (chatId) {
          return { token: channelToken, chatId };
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

export async function sendTelegramAlert(db: DatabaseSync, message: string): Promise<boolean> {
  const target = resolveTelegramTarget(db);
  if (!target) {
    console.warn("[usage-monitor] Telegram alert skipped: no configured channel");
    return false;
  }

  try {
    const r = await fetch(`https://api.telegram.org/bot${target.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: target.chatId,
        text: message,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });

    const payload = (await r.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
    if (!r.ok || payload?.ok === false) {
      console.error("[usage-monitor] Telegram send failed:", payload?.description || r.status);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[usage-monitor] Telegram send error:", err);
    return false;
  }
}
