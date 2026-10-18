#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { repoRoot } = require('./sbom-utils');

function main() {
  const root = repoRoot();
  const provenancePath = path.join(root, 'sbom', 'provenance.json');

  if (!fs.existsSync(provenancePath)) {
    console.error(`Missing provenance manifest: ${provenancePath}`);
    process.exit(1);
  }

  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
  } catch (error) {
    console.error(`Provenance manifest is invalid JSON: ${error.message}`);
    process.exit(1);
  }

  if (!doc || typeof doc !== 'object') {
    console.error('Provenance manifest root must be an object.');
    process.exit(1);
  }

  if (!doc.generator || !doc.commit || !Array.isArray(doc.targets) || doc.targets.length === 0) {
    console.error('Provenance manifest is missing generator, commit, or target metadata.');
    process.exit(1);
  }

  for (const target of doc.targets) {
    if (!target.name || !target.artifact || !target.checksum) {
      console.error(`Provenance target metadata is incomplete for ${target.name || '<unknown>'}.`);
      process.exit(1);
    }
  }

  console.log(`Validated provenance manifest: ${path.relative(root, provenancePath)}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { main };
