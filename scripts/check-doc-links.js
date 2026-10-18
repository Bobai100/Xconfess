#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_ALLOWLIST = path.join(__dirname, 'data/doc-link-allowlist.json');
const IGNORED_DIRS = new Set(['.git', '.next', 'coverage', 'dist', 'node_modules']);
const TIMEOUT_MS = Number(process.env.DOC_LINK_TIMEOUT_MS || 5000);

function markdownFiles(root, entries = ['.']) {
  const files = [];
  const visit = (entry) => {
    const absolute = path.resolve(root, entry);
    if (!absolute.startsWith(`${root}${path.sep}`) && absolute !== root) {
      throw new Error(`Path is outside the repository: ${entry}`);
    }
    if (!fs.existsSync(absolute)) throw new Error(`Path does not exist: ${entry}`);
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) {
        if (!IGNORED_DIRS.has(name)) visit(path.join(absolute, name));
      }
    } else if (absolute.toLowerCase().endsWith('.md')) {
      files.push(absolute);
    }
  };
  for (const entry of entries) visit(entry);
  return [...new Set(files)].sort();
}

function stripCode(content) {
  return content
    .replace(/^\s*(```+|~~~+)[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, (block) =>
      block.replace(/[^\n]/g, ' '),
    )
    .replace(/(`+)(.*?)\1/g, (match) => match.replace(/[^\n]/g, ' '));
}

function extractLinks(content) {
  const source = stripCode(content);
  const links = [];
  const patterns = [
    /!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\s*\)/g,
    /^\s{0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gm,
    /\b(?:href|src)\s*=\s*["']([^"']+)["']/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const target = match[1] || match[2] || match[3];
      if (target) links.push({ target: target.trim(), index: match.index });
    }
  }
  return links;
}

function headingAnchors(content) {
  const anchors = new Set();
  const slugCounts = new Map();
  for (const match of stripCode(content).matchAll(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const heading = match[1].replace(/\s+\{[^}]*\}\s*$/, '').replace(/`([^`]*)`/g, '$1');
    const base = heading.toLowerCase().replace(/[^\w -]/g, '').trim().replace(/\s+/g, '-');
    const count = slugCounts.get(base) || 0;
    slugCounts.set(base, count + 1);
    anchors.add(count ? `${base}-${count}` : base);
  }
  for (const match of stripCode(content).matchAll(/\b(?:id|name)\s*=\s*["']([^"']+)["']/gi)) {
    anchors.add(match[1]);
  }
  return anchors;
}

function loadAllowlist(filePath = DEFAULT_ALLOWLIST, now = new Date()) {
  const entries = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(entries)) throw new Error('Link allowlist must be a JSON array.');
  const expired = [];
  for (const entry of entries) {
    if (!entry.host || !entry.reason || !/^\d{4}-\d{2}-\d{2}$/.test(entry.expiresOn || '')) {
      throw new Error('Each allowlist entry needs host, reason, and YYYY-MM-DD expiresOn fields.');
    }
    if (Number.isNaN(Date.parse(`${entry.expiresOn}T00:00:00Z`)) ||
        new Date(`${entry.expiresOn}T00:00:00Z`) < now) {
      expired.push(`${entry.host} (expired ${entry.expiresOn})`);
    }
  }
  return { entries, expired };
}

function lineAt(content, index) {
  return content.slice(0, index).split('\n').length;
}

function insideRoot(root, absolute) {
  const relative = path.relative(root, absolute);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveLocalTarget(root, sourceFile, target) {
  let decoded;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return { error: 'malformed percent-encoding' };
  }
  const hashIndex = decoded.indexOf('#');
  const pathname = (hashIndex < 0 ? decoded : decoded.slice(0, hashIndex)).split('?')[0];
  const anchor = hashIndex < 0 ? '' : decoded.slice(hashIndex + 1);
  const targetPath = pathname
    ? path.resolve(pathname.startsWith('/') ? root : path.dirname(sourceFile), pathname.replace(/^\//, ''))
    : sourceFile;
  if (!insideRoot(root, targetPath)) return { error: 'target escapes repository root' };

  let resolved = targetPath;
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    const candidates = ['README.md', 'index.md'];
    resolved = candidates.map((name) => path.join(resolved, name)).find(fs.existsSync) || resolved;
  }
  if (!fs.existsSync(resolved)) return { error: 'target does not exist' };
  if (anchor && resolved.toLowerCase().endsWith('.md')) {
    const anchors = headingAnchors(fs.readFileSync(resolved, 'utf8'));
    if (!anchors.has(anchor)) return { error: `anchor "${anchor}" does not exist` };
  }
  return {};
}

async function checkExternal(url, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let response = await fetchImpl(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
    if (response.status === 405 || response.status === 501) {
      response = await fetchImpl(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
      await response.body?.cancel();
    }
    return response.ok ? null : `HTTP ${response.status}`;
  } catch (error) {
    return error.name === 'AbortError' ? `timed out after ${TIMEOUT_MS}ms` : error.message;
  } finally {
    clearTimeout(timer);
  }
}

async function auditMarkdown(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const allowlist = options.allowlist || [];
  const files = markdownFiles(root, options.paths || ['.']);
  const failures = [];
  const externalUrls = new Set();

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    for (const link of extractLinks(content)) {
      if (!link.target || link.target.startsWith('#')) {
        if (link.target.startsWith('#')) {
          const result = resolveLocalTarget(root, file, link.target);
          if (result.error) failures.push(`${path.relative(root, file)}:${lineAt(content, link.index)} -> ${link.target} (${result.error})`);
        }
        continue;
      }
      let url;
      try {
        url = new URL(link.target);
      } catch {
        const result = resolveLocalTarget(root, file, link.target);
        if (result.error) failures.push(`${path.relative(root, file)}:${lineAt(content, link.index)} -> ${link.target} (${result.error})`);
        continue;
      }
      if (url.protocol === 'mailto:' || url.protocol === 'tel:') continue;
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        failures.push(`${path.relative(root, file)}:${lineAt(content, link.index)} -> ${link.target} (unsupported URL protocol)`);
      } else {
        externalUrls.add(url.href);
      }
    }
  }

  const now = options.now || new Date();
  const expired = allowlist.filter((entry) => new Date(`${entry.expiresOn}T00:00:00Z`) < now);
  for (const entry of expired) failures.push(`allowlist:${entry.host} (expired ${entry.expiresOn})`);
  for (const url of externalUrls) {
    const host = new URL(url).hostname;
    if (allowlist.some((entry) => entry.host === host && new Date(`${entry.expiresOn}T00:00:00Z`) >= now)) continue;
    if (options.checkExternal === false) continue;
    const error = await (options.checkExternalUrl || checkExternal)(url, options.fetchImpl);
    if (error) failures.push(`external ${url} (${error})`);
  }
  return failures;
}

async function main() {
  const { entries, expired } = loadAllowlist();
  for (const item of expired) console.error(`Expired external-link exception: ${item}`);
  const failures = await auditMarkdown({ allowlist: entries });
  if (failures.length) {
    for (const failure of failures) console.error(failure);
    console.error(`Documentation link audit failed: ${failures.length} issue(s).`);
    process.exitCode = 1;
  } else {
    console.log('Documentation link audit passed.');
  }
}

if (require.main === module) main().catch((error) => {
  console.error(`Documentation link audit failed: ${error.message}`);
  process.exitCode = 1;
});

module.exports = { auditMarkdown, extractLinks, headingAnchors, loadAllowlist, markdownFiles };