#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { DEFAULT_TARGETS, repoRoot, validateSbomDocument, verifyChecksumSidecar } = require('./sbom-utils');

function parseArgs(argv) {
  const args = { requireProvenance: false, sbomDir: path.join(repoRoot(), 'sbom') };

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === '--require-provenance') {
      args.requireProvenance = true;
    } else if (current === '--sbom-dir') {
      args.sbomDir = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
    } else if (current.startsWith('--sbom-dir=')) {
      args.sbomDir = path.resolve(process.cwd(), current.slice('--sbom-dir='.length));
    }
  }

  return args;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const sbomDir = options.sbomDir;

  if (!fs.existsSync(sbomDir)) {
    console.error(`SBOM directory not found: ${sbomDir}`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(sbomDir)
    .filter((name) => name.endsWith('.sbom.json'))
    .sort();

  const required = [...DEFAULT_TARGETS];
  const present = new Set(files.map((file) => file.replace(/\.sbom\.json$/, '')));
  const missing = required.filter((target) => !present.has(target));
  if (missing.length > 0) {
    console.error(`Missing SBOM files for: ${missing.join(', ')}`);
    process.exit(1);
  }

  let failed = false;

  for (const fileName of files) {
    const filePath = path.join(sbomDir, fileName);
    let doc;

    try {
      doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      console.error(`${filePath}: Invalid JSON (${error.message})`);
      failed = true;
      continue;
    }

    const errors = validateSbomDocument(doc, { requireProvenance: options.requireProvenance });
    const sidecarError = verifyChecksumSidecar(filePath);

    if (errors.length > 0 || sidecarError) {
      failed = true;
      console.error(`${filePath}:`);
      for (const error of errors) {
        console.error(`  - ${error}`);
      }
      if (sidecarError) {
        console.error(`  - ${sidecarError}`);
      }
    }
  }

  if (failed) {
    process.exit(1);
  }

  console.log(`Validated ${files.length} SBOM artifact(s) in ${sbomDir}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { main, parseArgs };
