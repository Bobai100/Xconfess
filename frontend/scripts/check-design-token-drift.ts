import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export interface DriftViolation {
  file: string;
  line: number;
  column: number;
  kind: 'color' | 'spacing' | 'typography';
  literal: string;
  suggestion: string;
}

export interface DriftOptions {
  rootDir: string;
  /** Paths (relative to rootDir) that are intentionally exempt. */
  allowlist?: string[];
  /** Extra file extensions to scan. Defaults to ts/tsx/js/jsx/css. */
  extensions?: string[];
}

const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.css'];
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', '.next', 'coverage']);

const COLOR_PATTERNS: Array<{ re: RegExp; suggest: (m: string) => string }> = [
  { re: /#[0-9a-fA-F]{3,8}\b/g, suggest: (m) => `var(--color-*) token (found ${m})` },
  {
    re: /\brgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+[^)]*\)/g,
    suggest: (m) => `var(--color-*) token (found ${m})`,
  },
  {
    re: /\bhsla?\(\s*\d+[^)]*\)/g,
    suggest: (m) => `var(--color-*) token (found ${m})`,
  },
];

const SPACING_PATTERN = /\b(?:margin|padding|gap|top|right|bottom|left)(?:-[a-z]+)?\s*:\s*['"]?(\d+(?:\.\d+)?(?:px|rem|em))\b/gi;
const TYPOGRAPHY_PATTERN = /\bfont-size\s*:\s*['"]?(\d+(?:\.\d+)?(?:px|rem|em))\b/gi;

function isAllowlisted(relPath: string, allowlist: string[]): boolean {
  return allowlist.some((entry) => relPath === entry || relPath.startsWith(entry.replace(/\/$/, '') + '/'));
}

function walk(dir: string, rootDir: string, extensions: string[], out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (IGNORED_DIRS.has(name)) continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, rootDir, extensions, out);
    } else if (extensions.some((ext) => name.endsWith(ext))) {
      out.push(full);
    }
  }
}

function scanLine(line: string, lineNo: number, file: string): DriftViolation[] {
  const violations: DriftViolation[] = [];
  for (const { re, suggest } of COLOR_PATTERNS) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(line)) !== null) {
      violations.push({
        file,
        line: lineNo,
        column: match.index + 1,
        kind: 'color',
        literal: match[0],
        suggestion: suggest(match[0]),
      });
    }
  }
  for (const [kind, re] of [
    ['spacing', SPACING_PATTERN],
    ['typography', TYPOGRAPHY_PATTERN],
  ] as const) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(line)) !== null) {
      violations.push({
        file,
        line: lineNo,
        column: match.index + 1,
        kind,
        literal: match[0],
        suggestion: `var(--${kind}-*) token (found ${match[1]})`,
      });
    }
  }
  return violations;
}

export function checkDesignTokenDrift(options: DriftOptions): DriftViolation[] {
  const rootDir = resolve(options.rootDir);
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
  const allowlist = options.allowlist ?? [];
  const files: string[] = [];
  walk(rootDir, rootDir, extensions, files);

  const violations: DriftViolation[] = [];
  for (const full of files) {
    const rel = relative(rootDir, full).split('\\').join('/');
    if (isAllowlisted(rel, allowlist)) continue;
    const content = readFileSync(full, 'utf8');
    content.split(/\r?\n/).forEach((line, idx) => {
      violations.push(...scanLine(line, idx + 1, rel));
    });
  }
  return violations;
}

export function formatViolations(violations: DriftViolation[]): string {
  return violations
    .map(
      (v) =>
        `${v.file}:${v.line}:${v.column} [${v.kind}] hard-coded ${v.literal} -> ${v.suggestion}`,
    )
    .join('\n');
}

if (require.main === module) {
  const rootDir = process.argv[2] ?? resolve(__dirname, '..');
  const violations = checkDesignTokenDrift({ rootDir });
  if (violations.length > 0) {
    console.error(formatViolations(violations));
    console.error(`\n${violations.length} design-token drift violation(s) found.`);
    process.exit(1);
  }
  console.log('No design-token drift detected.');
}
