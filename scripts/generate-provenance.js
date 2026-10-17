#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { DEFAULT_TARGETS, ensureDir, getGitCommit, hashFile, repoRoot } = require('./sbom-utils');

function buildManifest() {
  const root = repoRoot();
  const sbomDir = ensureDir(path.join(root, 'sbom'));
  const commit = getGitCommit();
  const generatedAt = new Date().toISOString();
  const targets = DEFAULT_TARGETS.map((target) => {
    const filePath = path.join(sbomDir, `${target}.sbom.json`);
    const checksum = fs.existsSync(filePath) ? hashFile(filePath) : 'missing';

    return {
      name: target,
      artifact: `xconfess-${target}.tar.gz`,
      commit,
      checksum,
      generatedAt,
    };
  });

  return {
    schemaVersion: '1.0',
    generator: 'node scripts/generate-provenance.js',
    commit,
    generatedAt,
    repository: 'https://github.com/yazeed11011/Xconfess',
    targets,
  };
}

function main() {
  const root = repoRoot();
  const sbomDir = ensureDir(path.join(root, 'sbom'));
  const manifest = buildManifest();
  const outputPath = path.join(sbomDir, 'provenance.json');
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Created ${path.relative(root, outputPath)}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { buildManifest, main };
