#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(ROOT, 'docs/data-classification-registry.json');
const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
const DATA_CLASSIFICATIONS = new Set([
  'public',
  'operational',
  'personal',
  'sensitive',
  'credential',
  'on-chain',
]);
const baseRef = process.env.GITHUB_BASE_REF
  ? `origin/${process.env.GITHUB_BASE_REF}`
  : 'origin/main';

function git(args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function readBaseFile(filePath) {
  const revisionPath = `${baseRef}:${filePath}`;
  try {
    return git(['show', revisionPath]);
  } catch (showError) {
    try {
      git(['cat-file', '-e', revisionPath]);
    } catch {
      return '';
    }
    throw showError;
  }
}

function columnDefinitions(source) {
  const definitions = new Map();
  const decorator = /@(Column|PrimaryColumn|PrimaryGeneratedColumn|CreateDateColumn|UpdateDateColumn)\s*\(/g;
  let match;

  while ((match = decorator.exec(source)) !== null) {
    let depth = 1;
    let cursor = decorator.lastIndex;
    let quote = null;
    for (; cursor < source.length && depth > 0; cursor += 1) {
      const character = source[cursor];
      if (quote) {
        if (character === quote && source[cursor - 1] !== '\\') quote = null;
      } else if (character === "'" || character === '"' || character === '`') {
        quote = character;
      } else if (character === '(') {
        depth += 1;
      } else if (character === ')') {
        depth -= 1;
      }
    }

    const remainder = source.slice(cursor);
    const property = remainder.match(/^\s*([A-Za-z_$][\w$]*)\s*[!?]?\s*:/);
    if (property) {
      const semicolon = remainder.indexOf(';', property[0].length);
      const declarationEnd =
        semicolon === -1
          ? property[0].length
          : semicolon + 1;
      definitions.set(
        property[1],
        source.slice(match.index, cursor + declarationEnd).trim(),
      );
    }
    decorator.lastIndex = cursor;
  }
  return definitions;
}

function changedColumnNames(baseSource, currentSource) {
  const baseColumns = columnDefinitions(baseSource);
  const currentColumns = columnDefinitions(currentSource);
  return [...new Set([...baseColumns.keys(), ...currentColumns.keys()])].filter(
    (name) => baseColumns.get(name) !== currentColumns.get(name),
  );
}

function columnNames(source) {
  return [...columnDefinitions(source).keys()];
}

function migrationColumns(source) {
  const addedColumns = [
    ...source.matchAll(
      /\b(?:ADD|ALTER|DROP)\s+COLUMN\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?["'`]?([A-Za-z_]\w*)/gi,
    ),
  ].map((match) => match[1]);
  const createTable = /\bCREATE\s+TABLE\b/gi;
  let match;
  while ((match = createTable.exec(source)) !== null) {
    const opening = source.indexOf('(', createTable.lastIndex);
    if (opening === -1) continue;
    let depth = 1;
    let cursor = opening + 1;
    let quote = null;
    for (; cursor < source.length && depth > 0; cursor += 1) {
      const character = source[cursor];
      if (quote) {
        if (character === quote && source[cursor - 1] !== '\\') quote = null;
      } else if (character === "'" || character === '"' || character === '`') {
        quote = character;
      } else if (character === '(') {
        depth += 1;
      } else if (character === ')') {
        depth -= 1;
      }
    }

    const body = source.slice(opening + 1, cursor - 1);
    let segment = '';
    depth = 0;
    quote = null;
    const columns = [];
    for (const character of body) {
      if (quote) {
        segment += character;
        if (character === quote) quote = null;
      } else if (character === "'" || character === '"' || character === '`') {
        quote = character;
        segment += character;
      } else if (character === '(') {
        depth += 1;
        segment += character;
      } else if (character === ')') {
        depth -= 1;
        segment += character;
      } else if (character === ',' && depth === 0) {
        columns.push(segment);
        segment = '';
      } else {
        segment += character;
      }
    }
    columns.push(segment);

    for (const definition of columns) {
      const column = definition.trim().match(
        /^["'`]?([A-Za-z_]\w*)["'`]?\s+(?!CONSTRAINT\b|PRIMARY\b|UNIQUE\b|CHECK\b|FOREIGN\b)/i,
      );
      if (column) addedColumns.push(column[1]);
    }
    createTable.lastIndex = cursor;
  }
  return [...new Set(addedColumns)];
}

function hasOwner(entry) {
  return entry && typeof entry.owner === 'string' && entry.owner.trim().length > 0;
}

function hasClassification(value) {
  return typeof value === 'string' && DATA_CLASSIFICATIONS.has(value);
}

function run() {
  const changedPaths = git([
    'diff',
    '--name-only',
    '--diff-filter=ACMRTD',
    `${baseRef}...HEAD`,
  ])
    .split('\n')
    .filter(Boolean);

  const errors = [];
  for (const filePath of changedPaths) {
    if (/\.entity\.ts$/.test(filePath)) {
      const entry = registry.entities[filePath];
      if (!hasOwner(entry)) {
        errors.push(`${filePath}: missing classification registry owner`);
        continue;
      }
      if (!entry.fields || typeof entry.fields !== 'object') {
        errors.push(`${filePath}: missing field classification map (${entry.owner})`);
        continue;
      }

      const currentPath = path.join(ROOT, filePath);
      const currentSource = fs.existsSync(currentPath)
        ? fs.readFileSync(currentPath, 'utf8')
        : '';
      const changedColumns = changedColumnNames(
        readBaseFile(filePath),
        currentSource,
      );
      for (const name of changedColumns) {
        if (!hasClassification(entry.fields[name])) {
          errors.push(
            `${filePath}.${name}: missing data classification and owning module (${entry.owner})`,
          );
        }
      }
    }

    if (/\/migrations\/.*\.(ts|js)$/.test(filePath)) {
      const entry = registry.migrations[filePath];
      if (!hasOwner(entry)) {
        errors.push(`${filePath}: missing classification registry owner`);
        continue;
      }
      if (!hasClassification(entry.classification)) {
        errors.push(`${filePath}: missing migration data classification (${entry.owner})`);
      }
      if (!entry.fields || typeof entry.fields !== 'object') {
        errors.push(`${filePath}: missing field classification map (${entry.owner})`);
        continue;
      }
      const currentPath = path.join(ROOT, filePath);
      const source = fs.existsSync(currentPath)
        ? fs.readFileSync(currentPath, 'utf8')
        : readBaseFile(filePath);
      for (const name of migrationColumns(source)) {
        if (!hasClassification(entry.fields[name])) {
          errors.push(
            `${filePath}.${name}: missing data classification and owning module (${entry.owner})`,
          );
        }
      }
    }
  }

  if (errors.length > 0) {
    console.error('data-classification-gate: blocked undocumented data changes:');
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `data-classification-gate: checked ${changedPaths.length} changed file(s); no missing classifications.`,
  );
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(
      `data-classification-gate: unable to inspect changes against ${baseRef}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  }
}

module.exports = {
  changedColumnNames,
  columnNames,
  migrationColumns,
  hasOwner,
  hasClassification,
};
