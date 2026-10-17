/**
 * Multilingual normalization and tokenization for search queries and indexed text.
 *
 * Goals:
 * - Fold Unicode forms (NFKC) so composed/decomposed input matches.
 * - Fold diacritics for languages where they are not semantically significant.
 * - Apply language-specific token boundaries (e.g. CJK, Thai) while keeping
 *   safe fallbacks for unknown languages.
 * - Never throw on malformed input; degrade to a conservative fallback.
 */

export type SupportedLanguage =
  | 'en'
  | 'es'
  | 'fr'
  | 'de'
  | 'pt'
  | 'ru'
  | 'ar'
  | 'zh'
  | 'ja'
  | 'ko'
  | 'th';

export interface NormalizationOptions {
  /** BCP-47-ish language tag; unknown values fall back to the default profile. */
  language?: string;
  /** When false, diacritics are preserved (e.g. for languages where they matter). */
  foldDiacritics?: boolean;
}

export interface NormalizationResult {
  /** Normalized text suitable for indexing or query matching. */
  normalized: string;
  /** Tokenized form of the normalized text. */
  tokens: string[];
  /** Language profile actually applied (may be the fallback). */
  language: SupportedLanguage | 'default';
  /** True when the requested language was not recognized and a fallback was used. */
  usedFallback: boolean;
}

interface LanguageProfile {
  /** Whether diacritics should be folded by default for this language. */
  foldDiacritics: boolean;
  /** Regex used to split tokens; must be applied to NFKC-normalized text. */
  tokenPattern: RegExp;
}

// Combining diacritical marks block (U+0300–U+036F) plus common extended marks.
const DIACRITIC_PATTERN = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff]/g;

// CJK / Thai scripts have no whitespace word boundaries; tokenize per character
// (or per grapheme cluster) so substring matching remains meaningful.
const CJK_CHAR_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const THAI_CHAR_PATTERN = /[\u0e00-\u0e7f]/u;

const WORD_TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

const PROFILES: Record<SupportedLanguage, LanguageProfile> = {
  en: { foldDiacritics: true, tokenPattern: WORD_TOKEN_PATTERN },
  es: { foldDiacritics: true, tokenPattern: WORD_TOKEN_PATTERN },
  fr: { foldDiacritics: true, tokenPattern: WORD_TOKEN_PATTERN },
  de: { foldDiacritics: true, tokenPattern: WORD_TOKEN_PATTERN },
  pt: { foldDiacritics: true, tokenPattern: WORD_TOKEN_PATTERN },
  ru: { foldDiacritics: true, tokenPattern: WORD_TOKEN_PATTERN },
  ar: { foldDiacritics: true, tokenPattern: WORD_TOKEN_PATTERN },
  zh: { foldDiacritics: false, tokenPattern: WORD_TOKEN_PATTERN },
  ja: { foldDiacritics: false, tokenPattern: WORD_TOKEN_PATTERN },
  ko: { foldDiacritics: false, tokenPattern: WORD_TOKEN_PATTERN },
  th: { foldDiacritics: false, tokenPattern: WORD_TOKEN_PATTERN },
};

const DEFAULT_PROFILE: LanguageProfile = {
  foldDiacritics: true,
  tokenPattern: WORD_TOKEN_PATTERN,
};

function resolveLanguage(
  language: string | undefined,
): { profile: LanguageProfile; language: SupportedLanguage | 'default'; usedFallback: boolean } {
  if (!language || typeof language !== 'string') {
    return { profile: DEFAULT_PROFILE, language: 'default', usedFallback: true };
  }
  // Accept tags like "en-US" or "zh_Hans" by taking the primary subtag.
  const primary = language.trim().toLowerCase().split(/[-_]/)[0];
  if (primary && Object.prototype.hasOwnProperty.call(PROFILES, primary)) {
    return {
      profile: PROFILES[primary as SupportedLanguage],
      language: primary as SupportedLanguage,
      usedFallback: false,
    };
  }
  return { profile: DEFAULT_PROFILE, language: 'default', usedFallback: true };
}

function foldDiacritics(text: string): string {
  // NFD splits base characters from combining marks so they can be stripped.
  return text.normalize('NFD').replace(DIACRITIC_PATTERN, '').normalize('NFC');
}

function tokenize(text: string): string[] {
  if (!text) return [];
  const tokens: string[] = [];
  // Split on whitespace first, then further split CJK/Thai runs per character
  // while keeping contiguous Latin/Cyrillic/Arabic words intact.
  for (const chunk of text.split(/\s+/)) {
    if (!chunk) continue;
    if (CJK_CHAR_PATTERN.test(chunk) || THAI_CHAR_PATTERN.test(chunk)) {
      for (const char of chunk) {
        if (CJK_CHAR_PATTERN.test(char) || THAI_CHAR_PATTERN.test(char)) {
          tokens.push(char);
        } else {
          const matches = char.match(WORD_TOKEN_PATTERN);
          if (matches) tokens.push(...matches);
        }
      }
    } else {
      const matches = chunk.match(WORD_TOKEN_PATTERN);
      if (matches) tokens.push(...matches);
    }
  }
  return tokens;
}

/**
 * Normalize and tokenize text for search. Never throws: malformed input
 * (lone surrogates, invalid sequences) is coerced to a string and normalized
 * with the fallback profile.
 */
export function normalizeForSearch(
  input: unknown,
  options: NormalizationOptions = {},
): NormalizationResult {
  const { profile, language, usedFallback } = resolveLanguage(options.language);
  const fold = options.foldDiacritics ?? profile.foldDiacritics;

  let text: string;
  try {
    text = typeof input === 'string' ? input : input == null ? '' : String(input);
  } catch {
    text = '';
  }

  let normalized: string;
  try {
    // NFKC unifies compatibility forms (full-width, ligatures) before folding.
    normalized = text.normalize('NFKC');
    if (fold) normalized = foldDiacritics(normalized);
    normalized = normalized.toLowerCase().trim();
  } catch {
    // Malformed input: fall back to a conservative lowercase trim.
    normalized = text.toLowerCase().trim();
  }

  let tokens: string[];
  try {
    tokens = tokenize(normalized);
  } catch {
    tokens = normalized ? normalized.split(/\s+/).filter(Boolean) : [];
  }

  return { normalized, tokens, language, usedFallback };
}

/** Convenience helper for indexing pipelines. */
export function normalizeIndexedText(
  input: unknown,
  options: NormalizationOptions = {},
): string {
  return normalizeForSearch(input, options).normalized;
}

/** Convenience helper for query pipelines. */
export function normalizeQuery(
  input: unknown,
  options: NormalizationOptions = {},
): string[] {
  return normalizeForSearch(input, options).tokens;
}
