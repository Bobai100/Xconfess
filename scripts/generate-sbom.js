#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { DEFAULT_TARGETS, ensureDir, getSbomDirectory, writeSbomArtifact } = require('./sbom-utils');

function parseArgs(argv) {
  const args = { target: null, outputDir: null };

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === '--target') {
      args.target = argv[i + 1];
      i += 1;
    } else if (current.startsWith('--target=')) {
      args.target = current.slice('--target='.length);
    } else if (current === '--output-dir') {
      args.outputDir = argv[i + 1];
      i += 1;
    } else if (current.startsWith('--output-dir=')) {
      args.outputDir = current.slice('--output-dir='.length);
    }
  }

  return args;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const targetNames = DEFAULT_TARGETS.slice();
  const sbomDir = ensureDir(options.outputDir ? path.resolve(process.cwd(), options.outputDir) : path.join(process.cwd(), 'sbom'));

  if (options.target) {
    const target = options.target.trim();
    if (!target) {
      throw new Error('A target name is required when using --target.');
    }

    const { outputPath, checksum } = writeSbomArtifact(target, [target]);
    console.log(`Created ${path.relative(process.cwd(), outputPath)}`);
    console.log(`Checksum: ${checksum}`);
    return;
  }

  for (const target of targetNames) {
    const { outputPath, checksum } = writeSbomArtifact(target, targetNames);
    console.log(`Created ${path.relative(process.cwd(), outputPath)}`);
    console.log(`Checksum: ${checksum}`);
  }

  const manifestPath = path.join(sbomDir, 'sbom-manifest.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        targets: targetNames,
        directory: sbomDir,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`Created ${path.relative(process.cwd(), manifestPath)}`);
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
