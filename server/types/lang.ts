export type Lang = "ko" | "en" | "ja" | "zh" | "pt";

export const SUPPORTED_LANGS: readonly Lang[] = ["ko", "en", "ja", "zh", "pt"] as const;

export function isLang(value: unknown): value is Lang {
  return typeof value === "string" && SUPPORTED_LANGS.includes(value as Lang);
}

/** For L10n lookups, pt falls back to en since most system strings only have ko/en/ja/zh */
export function langForL10n(lang: Lang): "ko" | "en" | "ja" | "zh" {
  return lang === "pt" ? "en" : lang;
}
