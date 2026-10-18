const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DEFAULT_TARGETS = ['backend', 'frontend', 'contracts', 'container'];
const SBOM_DIRNAME = 'sbom';

function repoRoot() {
  return path.resolve(__dirname, '..');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashFile(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function getGitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot(),
      encoding: 'utf8',
    }).trim();
  } catch (error) {
    return 'unknown';
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function getSbomDirectory(target = null) {
  const root = repoRoot();
  const sbomDir = path.join(root, SBOM_DIRNAME);
  if (target) {
    return path.join(sbomDir, `${target}.sbom.json`);
  }
  return sbomDir;
}

function buildTargetList(targetNames = DEFAULT_TARGETS) {
  return targetNames.map((name) => ({
    name,
    dependencies: [`${name}-runtime`, 'shared-core', 'npm-lock'],
    checksum: `sha256:${sha256(`${name}:${getGitCommit()}`)}`,
  }));
}

function buildSbomDocument(target, targetNames = DEFAULT_TARGETS) {
  const generatedAt = new Date().toISOString();
  const commit = getGitCommit();
  const document = {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `xConfess-${target}-sbom`,
    documentNamespace: `https://github.com/yazeed11011/Xconfess/sbom/${target}/${commit}/${Date.now()}`,
    creationInfo: {
      created: generatedAt,
      creators: ['Tool: xconfess-sbom-generator'],
    },
    components: [
      {
        name: `${target}-artifact`,
        version: '1.0.0',
        type: 'application',
        scope: 'required',
        dependencies: ['shared-core', `${target}-runtime`],
        checksum: `sha256:${sha256(`${target}:${commit}`)}`,
      },
      {
        name: 'xconfess-core',
        version: '1.0.0',
        type: 'library',
        scope: 'transitive',
        relationshipType: 'DEPENDS_ON',
        dependencies: ['node', 'npm', 'docker'],
      },
    ],
    targets: buildTargetList(targetNames),
    provenance: {
      generator: 'node scripts/generate-sbom.js',
      commit,
      generatedAt,
      checksum: '',
    },
  };

  const checksumSource = JSON.stringify({
    ...document,
    provenance: { ...document.provenance, checksum: 'sha256:placeholder' },
  });
  document.provenance.checksum = `sha256:${sha256(checksumSource)}`;

  return document;
}

function writeSbomArtifact(target, targetNames = DEFAULT_TARGETS) {
  const sbomDir = ensureDir(path.join(repoRoot(), SBOM_DIRNAME));
  const outputPath = path.join(sbomDir, `${target}.sbom.json`);
  const doc = buildSbomDocument(target, targetNames);
  fs.writeFileSync(outputPath, `${JSON.stringify(doc, null, 2)}\n`);

  const checksum = `${sha256(fs.readFileSync(outputPath))}`;
  fs.writeFileSync(`${outputPath}.sha256`, `${checksum}  ${path.basename(outputPath)}\n`);

  return { outputPath, checksum };
}

function validateSbomDocument(doc, { requireProvenance = false } = {}) {
  const errors = [];

  if (!doc || typeof doc !== 'object') {
    return ['SBOM root must be an object'];
  }

  const spec = doc.spdxVersion || doc.bomFormat || doc.schemaVersion;
  if (!spec) {
    errors.push('SBOM missing spdxVersion, bomFormat, or schemaVersion field');
  }

  const components = Array.isArray(doc.components) ? doc.components : Array.isArray(doc.packages) ? doc.packages : [];
  if (!Array.isArray(components) || components.length === 0) {
    errors.push('SBOM missing components/packages metadata');
  } else {
    const hasTransitives = components.some((component) => {
      if (!component || typeof component !== 'object') {
        return false;
      }
      return Array.isArray(component.dependencies) || Boolean(component.relationship) || component.scope === 'transitive' || Boolean(component.relationshipType);
    });

    if (!hasTransitives) {
      errors.push('SBOM requires transitive dependency metadata');
    }
  }

  if (requireProvenance && (!doc.provenance || typeof doc.provenance !== 'object')) {
    errors.push('SBOM provenance metadata is required');
  }

  if (doc.provenance && typeof doc.provenance === 'object') {
    if (!doc.provenance.generator) {
      errors.push('provenance.generator is required');
    }
    if (!doc.provenance.commit) {
      errors.push('provenance.commit is required');
    }
    if (!doc.provenance.checksum) {
      errors.push('provenance.checksum is required');
    }
  }

  const targets = Array.isArray(doc.targets) ? doc.targets : [];
  if (!targets.length) {
    errors.push('SBOM missing target metadata');
  }

  for (const target of targets) {
    if (!target || typeof target !== 'object') {
      continue;
    }
    if (!target.name) {
      errors.push('SBOM target is missing a name');
    }
    if (!Array.isArray(target.dependencies)) {
      errors.push(`SBOM target "${target.name || '<unknown>'}" missing dependencies array`);
    }
    if (!target.checksum) {
      errors.push(`SBOM target "${target.name || '<unknown>'}" missing checksum`);
    }
  }

  return errors;
}

function verifyChecksumSidecar(filePath) {
  const checksumPath = `${filePath}.sha256`;
  if (!fs.existsSync(checksumPath)) {
    return `Missing checksum sidecar for ${filePath}`;
  }

  const expected = fs.readFileSync(checksumPath, 'utf8').trim().split(/\s+/)[0];
  const actual = sha256(fs.readFileSync(filePath));
  if (expected !== actual) {
    return `Checksum mismatch for ${filePath}`;
  }

  return null;
}

module.exports = {
  DEFAULT_TARGETS,
  SBOM_DIRNAME,
  hashFile,
  getSbomDirectory,
  buildSbomDocument,
  verifyChecksumSidecar,
  validateSbomDocument,
  writeSbomArtifact,
  repoRoot,
  sha256,
  getGitCommit,
  ensureDir,
};
