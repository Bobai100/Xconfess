const fs = require('node:fs');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(repositoryRoot, '.github', 'test-quarantine.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const quarantines = manifest.quarantines;
const scanRoots = [
  'xconfess-frontend/tests',
  'xconfess-frontend/app',
  'xconfess-backend/src',
  'xconfess-backend/test',
];
const today = new Date().toISOString().slice(0, 10);
const failures = [];
const registered = new Map();

if (!Array.isArray(quarantines)) {
  console.error('test-quarantine.json must contain a quarantines array.');
  process.exit(1);
}

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(entryPath);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [entryPath] : [];
  });
}

for (const quarantine of quarantines) {
  const required = ['file', 'testName', 'owner', 'expiresAt', 'classification', 'reason', 'issue'];
  for (const field of required) {
    if (typeof quarantine[field] !== 'string' || !quarantine[field].trim()) {
      failures.push(`Quarantine is missing a valid ${field}: ${JSON.stringify(quarantine)}`);
    }
  }

  if (!quarantine.file || !quarantine.testName) continue;
  const key = `${quarantine.file}::${quarantine.testName}`;
  if (registered.has(key)) failures.push(`Duplicate quarantine entry: ${key}`);
  registered.set(key, quarantine);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(quarantine.expiresAt || '') ||
      Number.isNaN(Date.parse(`${quarantine.expiresAt}T00:00:00Z`))) {
    failures.push(`Quarantine expiry must be an ISO date (YYYY-MM-DD): ${key}`);
  } else if (quarantine.expiresAt < today) {
    failures.push(`Quarantine expired on ${quarantine.expiresAt}: ${key}`);
  }
  if (!['product', 'infrastructure'].includes(quarantine.classification)) {
    failures.push(`Classification must be product or infrastructure: ${key}`);
  }
  if (!/^#\d+$/.test(quarantine.issue || '')) {
    failures.push(`Quarantine must reference its tracking issue: ${key}`);
  }
}

const skippedTests = new Set();
const staticSkip = /\b(?:test|it|describe)\.skip\s*\(\s*(['"`])([^'"`]+)\1/g;
for (const scanRoot of scanRoots) {
  for (const filePath of walk(path.join(repositoryRoot, scanRoot))) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const match of source.matchAll(staticSkip)) {
      const relativeFile = path.relative(repositoryRoot, filePath).split(path.sep).join('/');
      skippedTests.add(`${relativeFile}::${match[2]}`);
    }
  }
}

for (const skippedTest of skippedTests) {
  if (!registered.has(skippedTest)) {
    failures.push(`Skipped test is not registered for triage: ${skippedTest}`);
  }
}
for (const quarantine of quarantines) {
  const key = `${quarantine.file}::${quarantine.testName}`;
  if (!skippedTests.has(key)) {
    failures.push(`Quarantined test is not a static skip in source: ${key}`);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(`Validated ${quarantines.length} test quarantine(s).`);