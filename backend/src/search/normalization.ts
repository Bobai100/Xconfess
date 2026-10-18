/**
 * Multilingual normalization and tokenization for search queries and indexed text.
 *
 * Goals:
 * - Fold Unicode forms (NFKC) so composed/decomposed input matches.
 * - Fold diacritics for languages where they are not semantically significant.
 * - Apply language-specific token boundaries (e.g. CJK, Thai) while keeping
 *   safe fallbacks for unknown languages.
 * - Never throw on malformed input; degrade to a conservative fallback.
 *
 * Advanced query grammar (allowlisted):
 * - Free terms: `foo bar`
 * - Field-scoped terms: `field:value` where `field` is in ALLOWED_FIELDS.
 * - Quoted phrases: `"exact phrase"` (optionally field-scoped: `title:"a b"`).
 * - Negation prefix: `-term` / `-field:value` / `-"phrase"`.
 * Anything else (unknown operators, unbalanced quotes, unknown fields,
 * excessive complexity) is rejected with a stable error code.
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

// ---------------------------------------------------------------------------
// Advanced query grammar
// ---------------------------------------------------------------------------

/** Fields that may be used as `field:value` scopes in advanced queries. */
export const ALLOWED_FIELDS = [
  'title',
  'body',
  'author',
  'tag',
  'category',
  'language',
] as const;

export type AllowedField = (typeof ALLOWED_FIELDS)[number];

/** Stable, documented validation error codes for advanced query parsing. */
export type QueryValidationErrorCode =
  | 'EMPTY_QUERY'
  | 'UNKNOWN_FIELD'
  | 'UNBALANCED_QUOTES'
  | 'UNSUPPORTED_OPERATOR'
  | 'TOO_MANY_CLAUSES'
  | 'TOO_MANY_TOKENS'
  | 'CLAUSE_TOO_LONG';

export interface QueryValidationError {
  code: QueryValidationErrorCode;
  message: string;
  /** Character offset in the original query where the problem was detected. */
  position?: number;
}

export interface QueryClause {
  /** Field scope, or null for a free-text clause. */
  field: AllowedField | null;
  /** True when the clause is negated with a leading `-`. */
  negated: boolean;
  /** True when the clause originated from a quoted phrase. */
  phrase: boolean;
  /** Normalized tokens for the clause. */
  tokens: string[];
}

export interface ParsedQuery {
  ok: true;
  clauses: QueryClause[];
}

export interface QueryParseFailure {
  ok: false;
  error: QueryValidationError;
}

export type QueryParseResult = ParsedQuery | QueryParseFailure;

/** Complexity caps to prevent unexpectedly expensive queries. */
export const QUERY_LIMITS = {
  /** Maximum number of clauses (terms/phrases) in a single query. */
  maxClauses: 32,
  /** Maximum number of normalized tokens across the whole query. */
  maxTokens: 128,
  /** Maximum length (in characters) of a single clause value. */
  maxClauseLength: 256,
} as const;

const FIELD_SET: ReadonlySet<string> = new Set(ALLOWED_FIELDS);

// Characters that look like operators but are not part of the allowlisted
// grammar. Rejecting them keeps behavior predictable and avoids expensive
// wildcard/regex-style queries.
const UNSUPPORTED_OPERATOR_PATTERN = /[~^*?()[\]{}|\\]/;

function fail(
  code: QueryValidationErrorCode,
  message: string,
  position?: number,
): QueryParseFailure {
  return { ok: false, error: { code, message, position } };
}

/**
 * Parse an advanced search query against the documented allowlisted grammar.
 *
 * Grammar (informal):
 *   query   := clause*
 *   clause  := '-'? ( field ':' )? value
 *   value   := word | '"' phrase '"'
 *
 * Returns a discriminated result; never throws. Malformed or disallowed input
 * yields a stable `QueryValidationErrorCode`.
 */
export function parseAdvancedQuery(
  input: unknown,
  options: NormalizationOptions = {},
): QueryParseResult {
  let raw: string;
  try {
    raw = typeof input === 'string' ? input : input == null ? '' : String(input);
  } catch {
    raw = '';
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return fail('EMPTY_QUERY', 'Query must not be empty.');
  }

  const clauses: QueryClause[] = [];
  let totalTokens = 0;
  let i = 0;
  const len = trimmed.length;

  while (i < len) {
    // Skip whitespace between clauses.
    while (i < len && /\s/.test(trimmed[i])) i++;
    if (i >= len) break;

    const clauseStart = i;
    let negated = false;
    if (trimmed[i] === '-') {
      negated = true;
      i++;
    }

    // Optional field scope: `field:` where field is allowlisted.
    let field: AllowedField | null = null;
    const fieldMatch = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(trimmed.slice(i));
    if (fieldMatch) {
      const candidate = fieldMatch[1].toLowerCase();
      if (!FIELD_SET.has(candidate)) {
        return fail(
          'UNKNOWN_FIELD',
          `Unknown field "${fieldMatch[1]}". Allowed fields: ${ALLOWED_FIELDS.join(', ')}.`,
          i,
        );
      }
      field = candidate as AllowedField;
      i += fieldMatch[0].length;
    }

    // Value: quoted phrase or bare word.
    let value: string;
    let phrase = false;
    if (trimmed[i] === '"') {
      phrase = true;
      const close = trimmed.indexOf('"', i + 1);
      if (close === -1) {
        return fail('UNBALANCED_QUOTES', 'Unbalanced quotes in query.', i);
      }
      value = trimmed.slice(i + 1, close);
      i = close + 1;
    } else {
      const start = i;
      while (i < len && !/\s/.test(trimmed[i])) i++;
      value = trimmed.slice(start, i);
    }

    if (!value) {
      return fail('UNSUPPORTED_OPERATOR', 'Empty clause value.', clauseStart);
    }

    if (value.length > QUERY_LIMITS.maxClauseLength) {
      return fail(
        'CLAUSE_TOO_LONG',
        `Clause exceeds maximum length of ${QUERY_LIMITS.maxClauseLength} characters.`,
        clauseStart,
      );
    }

    if (UNSUPPORTED_OPERATOR_PATTERN.test(value)) {
      return fail(
        'UNSUPPORTED_OPERATOR',
        'Query contains an unsupported operator or wildcard.',
        clauseStart,
      );
    }

    const tokens = normalizeQuery(value, options);
    if (tokens.length === 0) {
      return fail('UNSUPPORTED_OPERATOR', 'Clause produced no searchable tokens.', clauseStart);
    }

    totalTokens += tokens.length;
    if (totalTokens > QUERY_LIMITS.maxTokens) {
      return fail(
        'TOO_MANY_TOKENS',
        `Query exceeds maximum of ${QUERY_LIMITS.maxTokens} tokens.`,
        clauseStart,
      );
    }

    clauses.push({ field, negated, phrase, tokens });
    if (clauses.length > QUERY_LIMITS.maxClauses) {
      return fail(
        'TOO_MANY_CLAUSES',
        `Query exceeds maximum of ${QUERY_LIMITS.maxClauses} clauses.`,
        clauseStart,
      );
    }
  }

  if (clauses.length === 0) {
    return fail('EMPTY_QUERY', 'Query must not be empty.');
  }

  return { ok: true, clauses };
}
