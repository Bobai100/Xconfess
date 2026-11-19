import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkDesignTokenDrift, formatViolations } from '../check-design-token-drift';

describe('checkDesignTokenDrift', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'token-drift-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function write(rel: string, content: string): void {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }

  it('flags hard-coded colors, spacing, and typography with owning file and suggestion', () => {
    write('components/Button.tsx', [
      'export const Button = () => (',
      '  <button style={{ color: "#ff0000", padding: "12px", fontSize: "14px" }} />',
      ');',
    ].join('\n'));

    const violations = checkDesignTokenDrift({ rootDir: root });
    const kinds = violations.map((v) => v.kind).sort();
    expect(kinds).toEqual(['color', 'spacing', 'typography']);
    for (const v of violations) {
      expect(v.file).toBe('components/Button.tsx');
      expect(v.suggestion).toContain('var(--');
    }
  });

  it('does not flag token references', () => {
    write('components/Card.tsx', 'const s = { color: "var(--color-fg)", padding: "var(--spacing-2)" };');
    expect(checkDesignTokenDrift({ rootDir: root })).toEqual([]);
  });

  it('respects the approved-exceptions allowlist', () => {
    write('theme/tokens.css', ':root { --brand: #123456; }');
    write('components/Badge.tsx', 'const c = "#abcdef";');

    const violations = checkDesignTokenDrift({ rootDir: root, allowlist: ['theme/tokens.css'] });
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe('components/Badge.tsx');
  });

  it('ignores node_modules and non-source files', () => {
    write('node_modules/pkg/index.js', 'const c = "#000000";');
    write('README.md', 'color: #000000');
    expect(checkDesignTokenDrift({ rootDir: root })).toEqual([]);
  });

  it('formats violations with file, line, column, and replacement', () => {
    write('a.ts', 'const c = "#fff";');
    const out = formatViolations(checkDesignTokenDrift({ rootDir: root }));
    expect(out).toContain('a.ts:1:');
    expect(out).toContain('[color]');
    expect(out).toContain('var(--color-*');
  });
});
