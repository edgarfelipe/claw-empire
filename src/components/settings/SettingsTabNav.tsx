import type { SettingsTab, TFunction } from "./types";

interface SettingsTabNavProps {
  tab: SettingsTab;
  setTab: (tab: SettingsTab) => void;
  t: TFunction;
}

const TAB_ITEMS: Array<{ key: SettingsTab; icon: string; label: (t: TFunction) => string }> = [
  { key: "general", icon: "⚙️", label: (t) => t({ ko: "일반 설정", en: "General", ja: "一般設定", zh: "常规设置" }) },
  { key: "cli", icon: "🔧", label: (t) => t({ ko: "CLI 도구", en: "CLI Tools", ja: "CLI ツール", zh: "CLI 工具" }) },
  { key: "oauth", icon: "🔑", label: (t) => t({ ko: "OAuth 인증", en: "OAuth", ja: "OAuth 認証", zh: "OAuth 认证" }) },
  { key: "api", icon: "🔌", label: (t) => t({ ko: "API 연동", en: "API", ja: "API 連携", zh: "API 集成" }) },
  { key: "gateway", icon: "📡", label: (t) => t({ ko: "채널 메시지", en: "Channel", ja: "チャネル", zh: "频道" }) },
  { key: "auth", icon: "🛡️", label: (t) => t({ ko: "인증 관리", en: "Authentication", ja: "認証管理", zh: "认证管理", pt: "Autenticacao" }) },
];

export default function SettingsTabNav({ tab, setTab, t }: SettingsTabNavProps) {
  return (
    <div className="flex flex-wrap gap-1 border-b border-slate-700/50 pb-1">
      {TAB_ITEMS.map((item) => (
        <button
          key={item.key}
          onClick={() => setTab(item.key)}
          className={`flex items-center gap-1.5 rounded-t-lg px-3 py-2 text-xs font-medium transition-colors sm:px-4 sm:py-2.5 sm:text-sm ${
            tab === item.key ? "text-blue-400 border-b-2 border-blue-400" : "text-slate-400 hover:text-slate-200"
          }`}
        >
          <span>{item.icon}</span>
          <span>{item.label(t)}</span>
        </button>
      ))}
    </div>
  );
}
