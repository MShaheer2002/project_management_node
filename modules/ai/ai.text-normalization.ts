export type ScriptFamily =
  | "arabic"
  | "devanagari"
  | "han"
  | "hiragana"
  | "katakana"
  | "hangul"
  | "cyrillic"
  | "latin"
  | "mixed"
  | "unknown";

export type NormalizedTextForms = {
  normalized: string;
  folded: string;
};

const SCRIPT_LOCALE_PREFIXES: Record<Exclude<ScriptFamily, "mixed" | "unknown">, string[]> = {
  arabic: ["ar", "ur", "fa", "ps", "sd"],
  devanagari: ["hi", "mr", "ne", "sa"],
  han: ["zh"],
  hiragana: ["ja"],
  katakana: ["ja"],
  hangul: ["ko"],
  cyrillic: ["ru", "uk", "bg", "sr", "kk", "mn"],
  latin: ["en", "fr", "es", "de", "pt", "it", "tr", "id", "ms", "nl", "sv", "no", "da", "fi", "pl", "ro", "cs", "sk", "hu", "vi"],
};

function canonicalizeWhitespace(value: string) {
  return value.replace(/[\s\u00A0]+/gu, " ").trim();
}

function cleanupPunctuation(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[\u2010-\u2015\u2212]+/gu, "-")
    .replace(/[^\p{L}\p{N}\p{M}\s-]+/gu, " ");
}

function stripCombiningMarks(value: string) {
  return value.normalize("NFKD").replace(/\p{M}+/gu, "");
}

export function normalizeUnicodeText(
  value: string,
  options: {
    stripDiacritics?: boolean | undefined;
    preserveCase?: boolean | undefined;
  } = {},
) {
  const cleaned = canonicalizeWhitespace(cleanupPunctuation(value));
  const withoutMarks = options.stripDiacritics ? canonicalizeWhitespace(cleanupPunctuation(stripCombiningMarks(cleaned))) : cleaned;
  return options.preserveCase ? withoutMarks : withoutMarks.toLocaleLowerCase();
}

export function buildNormalizedTextForms(value: string): NormalizedTextForms {
  return {
    normalized: normalizeUnicodeText(value),
    folded: normalizeUnicodeText(value, { stripDiacritics: true }),
  };
}

export function detectScriptFamily(value: string): ScriptFamily {
  const text = value.normalize("NFKC");
  const checks: Array<[Exclude<ScriptFamily, "mixed" | "unknown">, RegExp]> = [
    ["arabic", /\p{Script=Arabic}/u],
    ["devanagari", /\p{Script=Devanagari}/u],
    ["hangul", /\p{Script=Hangul}/u],
    ["hiragana", /\p{Script=Hiragana}/u],
    ["katakana", /\p{Script=Katakana}/u],
    ["han", /\p{Script=Han}/u],
    ["cyrillic", /\p{Script=Cyrillic}/u],
    ["latin", /\p{Script=Latin}/u],
  ];

  const matched = checks.filter(([, pattern]) => pattern.test(text)).map(([family]) => family);
  if (matched.length === 0) return "unknown";
  if (matched.length === 1) return matched[0]!;
  return "mixed";
}

export function normalizeLocaleCode(locale: string | null | undefined) {
  if (typeof locale !== "string") return undefined;
  const normalized = locale.trim().toLowerCase().replace(/_/g, "-");
  return normalized.length > 0 ? normalized : undefined;
}

export function localeMatchesText(locale: string | null | undefined, value: string) {
  const normalizedLocale = normalizeLocaleCode(locale);
  if (!normalizedLocale) return false;

  const prefix = normalizedLocale.split("-")[0]!;
  const scriptFamily = detectScriptFamily(value);
  if (scriptFamily === "mixed" || scriptFamily === "unknown") return false;

  return SCRIPT_LOCALE_PREFIXES[scriptFamily]?.includes(prefix) ?? false;
}
