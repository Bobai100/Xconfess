/**
 * WCAG 2.2 AA color contrast audit for product themes.
 *
 * Measures text and meaningful interactive controls in both light and dark
 * themes against the AA thresholds:
 *   - 4.5:1 for normal text
 *   - 3:1 for large text and UI components / graphical objects
 *
 * These checks act as regression guards: any future token change that drops a
 * pair below threshold fails fast here.
 */

type RGB = { r: number; g: number; b: number };

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Parse a #rgb or #rrggbb string. Throws on malformed input (no silent pass). */
export function parseHex(input: string): RGB {
  if (typeof input !== 'string' || !HEX_RE.test(input)) {
    throw new Error(`Invalid color value: ${JSON.stringify(input)}`);
  }
  let hex = input.slice(1);
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('');
  }
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

function channelToLinear(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Relative luminance per WCAG 2.x definition. */
export function relativeLuminance(color: RGB): number {
  return (
    0.2126 * channelToLinear(color.r) +
    0.7152 * channelToLinear(color.g) +
    0.0722 * channelToLinear(color.b)
  );
}

/** Contrast ratio between two colors, in the range [1, 21]. */
export function contrastRatio(foreground: string, background: string): number {
  const fg = relativeLuminance(parseHex(foreground));
  const bg = relativeLuminance(parseHex(background));
  const lighter = Math.max(fg, bg);
  const darker = Math.min(fg, bg);
  return (lighter + 0.05) / (darker + 0.05);
}

export const AA_NORMAL_TEXT = 4.5;
export const AA_LARGE_TEXT = 3;
export const AA_UI_COMPONENT = 3;

type ThemeName = 'light' | 'dark';

interface ThemeTokens {
  background: string;
  surface: string;
  text: string;
  textMuted: string;
  primary: string;
  primaryText: string;
  border: string;
  focusRing: string;
}

/**
 * Audited product theme tokens. Keep in sync with the theme layer; these are
 * the values the regression checks below assert against.
 */
export const THEMES: Record<ThemeName, ThemeTokens> = {
  light: {
    background: '#ffffff',
    surface: '#f5f5f5',
    text: '#1a1a1a',
    textMuted: '#595959',
    primary: '#0b5fff',
    primaryText: '#ffffff',
    border: '#767676',
    focusRing: '#0b5fff',
  },
  dark: {
    background: '#121212',
    surface: '#1e1e1e',
    text: '#f5f5f5',
    textMuted: '#b3b3b3',
    primary: '#6ea8ff',
    primaryText: '#0a0a0a',
    border: '#8c8c8c',
    focusRing: '#6ea8ff',
  },
};

interface AuditPair {
  label: string;
  foreground: string;
  background: string;
  threshold: number;
}

function auditPairs(theme: ThemeTokens): AuditPair[] {
  return [
    { label: 'body text on background', foreground: theme.text, background: theme.background, threshold: AA_NORMAL_TEXT },
    { label: 'body text on surface', foreground: theme.text, background: theme.surface, threshold: AA_NORMAL_TEXT },
    { label: 'muted text on background', foreground: theme.textMuted, background: theme.background, threshold: AA_NORMAL_TEXT },
    { label: 'muted text on surface', foreground: theme.textMuted, background: theme.surface, threshold: AA_NORMAL_TEXT },
    { label: 'primary button label', foreground: theme.primaryText, background: theme.primary, threshold: AA_NORMAL_TEXT },
    { label: 'primary control vs background', foreground: theme.primary, background: theme.background, threshold: AA_UI_COMPONENT },
    { label: 'border vs background', foreground: theme.border, background: theme.background, threshold: AA_UI_COMPONENT },
    { label: 'focus ring vs background', foreground: theme.focusRing, background: theme.background, threshold: AA_UI_COMPONENT },
  ];
}

describe('WCAG 2.2 AA color contrast audit', () => {
  describe('contrast math', () => {
    it('computes known ratios', () => {
      expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
      expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    });

    it('is symmetric', () => {
      expect(contrastRatio('#1a1a1a', '#ffffff')).toBeCloseTo(
        contrastRatio('#ffffff', '#1a1a1a'),
        5,
      );
    });

    it('expands 3-digit hex', () => {
      expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    });

    it('rejects malformed color values instead of silently passing', () => {
      expect(() => parseHex('not-a-color')).toThrow(/Invalid color value/);
      expect(() => parseHex('#12')).toThrow(/Invalid color value/);
      expect(() => parseHex('#gggggg')).toThrow(/Invalid color value/);
      expect(() => contrastRatio('#12345', '#ffffff')).toThrow(/Invalid color value/);
    });
  });

  (Object.keys(THEMES) as ThemeName[]).forEach((themeName) => {
    describe(`${themeName} theme`, () => {
      const theme = THEMES[themeName];

      it('defines all audited tokens as valid colors', () => {
        Object.entries(theme).forEach(([token, value]) => {
          expect(() => parseHex(value)).not.toThrow();
          expect(token).toBeTruthy();
        });
      });

      auditPairs(theme).forEach((pair) => {
        it(`${pair.label} meets ${pair.threshold}:1`, () => {
          const ratio = contrastRatio(pair.foreground, pair.background);
          expect(ratio).toBeGreaterThanOrEqual(pair.threshold);
        });
      });
    });
  });

  it('rejects unknown themes explicitly', () => {
    const lookup = (name: string): ThemeTokens => {
      if (!(name in THEMES)) {
        throw new Error(`Unknown theme: ${name}`);
      }
      return THEMES[name as ThemeName];
    };
    expect(() => lookup('sepia')).toThrow(/Unknown theme/);
    expect(lookup('light')).toBe(THEMES.light);
  });
});
