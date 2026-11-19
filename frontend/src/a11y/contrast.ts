/**
 * WCAG 2.2 AA color contrast auditing for product themes.
 *
 * This module is the owning accessibility boundary for contrast checks: it
 * parses color tokens, computes relative luminance / contrast ratios, and
 * validates the audited token set for both light and dark themes against the
 * WCAG 2.2 AA thresholds (4.5:1 normal text, 3:1 large text and UI controls).
 *
 * Invalid inputs (malformed hex, unknown theme, unknown token) throw a
 * descriptive error rather than silently passing.
 */

export type ThemeName = 'light' | 'dark';

export type ContrastKind = 'text' | 'largeText' | 'ui';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface ContrastPair {
  /** Token name for the foreground color. */
  foreground: string;
  /** Token name for the background color. */
  background: string;
  /** What the pair represents; drives the required ratio. */
  kind: ContrastKind;
}

export interface ContrastResult extends ContrastPair {
  ratio: number;
  required: number;
  passes: boolean;
}

export interface ThemeAudit {
  theme: ThemeName;
  results: ContrastResult[];
  passes: boolean;
}

/** WCAG 2.2 AA minimum contrast ratios. */
export const WCAG_AA_THRESHOLDS: Record<ContrastKind, number> = {
  text: 4.5,
  largeText: 3,
  ui: 3,
};

const HEX_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Parse a hex color string (#rgb or #rrggbb) into RGB channels.
 * Throws on malformed input so audits never silently pass.
 */
export function parseHexColor(value: string): Rgb {
  if (typeof value !== 'string' || !HEX_PATTERN.test(value)) {
    throw new Error(`Invalid hex color: ${JSON.stringify(value)}`);
  }

  const hex = value.slice(1);
  const expanded =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex;

  return {
    r: parseInt(expanded.slice(0, 2), 16),
    g: parseInt(expanded.slice(2, 4), 16),
    b: parseInt(expanded.slice(4, 6), 16),
  };
}

function channelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Relative luminance per WCAG 2.2 definition. */
export function relativeLuminance(color: Rgb): number {
  return (
    0.2126 * channelToLinear(color.r) +
    0.7152 * channelToLinear(color.g) +
    0.0722 * channelToLinear(color.b)
  );
}

/** Contrast ratio between two colors, in the range [1, 21]. */
export function contrastRatio(foreground: string, background: string): number {
  const fg = relativeLuminance(parseHexColor(foreground));
  const bg = relativeLuminance(parseHexColor(background));
  const lighter = Math.max(fg, bg);
  const darker = Math.min(fg, bg);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Audited color tokens per theme. These are the tokens the product themes
 * expose for text and meaningful interactive controls.
 */
export const THEME_TOKENS: Record<ThemeName, Record<string, string>> = {
  light: {
    'text-primary': '#1a1a1a',
    'text-secondary': '#4a4a4a',
    'text-muted': '#6b6b6b',
    'surface': '#ffffff',
    'surface-raised': '#f5f5f5',
    'control-border': '#767676',
    'control-focus': '#1a5fb4',
    'accent': '#1a5fb4',
  },
  dark: {
    'text-primary': '#f5f5f5',
    'text-secondary': '#c8c8c8',
    'text-muted': '#a0a0a0',
    'surface': '#121212',
    'surface-raised': '#1e1e1e',
    'control-border': '#8a8a8a',
    'control-focus': '#78aeed',
    'accent': '#78aeed',
  },
};

/** The audited foreground/background pairs for each theme. */
export const AUDITED_PAIRS: ContrastPair[] = [
  { foreground: 'text-primary', background: 'surface', kind: 'text' },
  { foreground: 'text-secondary', background: 'surface', kind: 'text' },
  { foreground: 'text-muted', background: 'surface', kind: 'text' },
  { foreground: 'text-primary', background: 'surface-raised', kind: 'text' },
  { foreground: 'control-border', background: 'surface', kind: 'ui' },
  { foreground: 'control-focus', background: 'surface', kind: 'ui' },
  { foreground: 'accent', background: 'surface', kind: 'ui' },
];

function resolveToken(theme: ThemeName, token: string): string {
  const tokens = THEME_TOKENS[theme];
  if (!tokens) {
    throw new Error(`Unknown theme: ${JSON.stringify(theme)}`);
  }
  const value = tokens[token];
  if (value === undefined) {
    throw new Error(`Unknown token ${JSON.stringify(token)} in theme ${theme}`);
  }
  return value;
}

/** Audit a single theme against the WCAG 2.2 AA thresholds. */
export function auditTheme(theme: ThemeName): ThemeAudit {
  const results = AUDITED_PAIRS.map((pair) => {
    const foreground = resolveToken(theme, pair.foreground);
    const background = resolveToken(theme, pair.background);
    const ratio = contrastRatio(foreground, background);
    const required = WCAG_AA_THRESHOLDS[pair.kind];
    return {
      ...pair,
      ratio,
      required,
      passes: ratio >= required,
    };
  });

  return {
    theme,
    results,
    passes: results.every((r) => r.passes),
  };
}

/** Audit all product themes. */
export function auditAllThemes(): ThemeAudit[] {
  return (Object.keys(THEME_TOKENS) as ThemeName[]).map(auditTheme);
}

/**
 * Assert that every audited token pair meets its threshold. Throws a
 * descriptive error listing failures so regressions fail fast.
 */
export function assertThemesMeetWcagAa(): void {
  const failures: string[] = [];
  for (const audit of auditAllThemes()) {
    for (const result of audit.results) {
      if (!result.passes) {
        failures.push(
          `${audit.theme}: ${result.foreground} on ${result.background} ` +
            `is ${result.ratio.toFixed(2)}:1 (requires ${result.required}:1)`,
        );
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`WCAG 2.2 AA contrast failures:\n${failures.join('\n')}`);
  }
}
