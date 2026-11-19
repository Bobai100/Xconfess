const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { afterEach, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { evaluateBudgets, normalizeRoute } = require("../check-frontend-budget");

const temporaryDirectories = [];

function createBuildOutput(chunks) {
  const nextDir = fs.mkdtempSync(path.join(os.tmpdir(), "xconfess-budget-"));
  temporaryDirectories.push(nextDir);
  for (const [file, contents] of Object.entries(chunks)) {
    const chunkPath = path.join(nextDir, file);
    fs.mkdirSync(path.dirname(chunkPath), { recursive: true });
    fs.writeFileSync(chunkPath, contents);
  }
  return nextDir;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("frontend route bundle budgets", () => {
  it("normalizes app-router route groups and page entries", () => {
    assert.equal(normalizeRoute("/(dashboard)/admin/page"), "/admin");
    assert.equal(normalizeRoute("/page"), "/");
  });

  it("measures each route's own shared and route-specific JavaScript chunks", () => {
    const nextDir = createBuildOutput({
      "static/chunks/shared.js": "shared bundle",
      "static/chunks/home.js": "home bundle",
      "static/chunks/admin.js": "admin bundle",
    });
    const results = evaluateBudgets({
      nextDir,
      manifest: {
        pages: {
          "/page": ["static/chunks/shared.js", "static/chunks/home.js"],
          "/(dashboard)/admin/page": ["static/chunks/shared.js", "static/chunks/admin.js"],
        },
      },
      budgets: [
        { route: "/", maxGzipKB: 5 },
        { route: "/admin", maxGzipKB: 5 },
      ],
    });

    assert.equal(results.length, 2);
    assert.deepEqual(
      results[0].chunks.map(({ file }) => file).sort(),
      ["static/chunks/home.js", "static/chunks/shared.js"],
    );
    assert.deepEqual(
      results[1].chunks.map(({ file }) => file).sort(),
      ["static/chunks/admin.js", "static/chunks/shared.js"],
    );
    assert.ok(results.every(({ passed }) => passed));
  });

  it("fails explicitly when a configured route is absent", () => {
    assert.throws(
      () =>
        evaluateBudgets({
          nextDir: createBuildOutput({}),
          manifest: { pages: { "/page": ["static/chunks/home.js"] } },
          budgets: [{ route: "/admin", maxGzipKB: 10 }],
        }),
      /No app build manifest entry found for \/admin\./,
    );
  });

  it("marks a route that exceeds its gzip limit as failed", () => {
    const incompressibleContent = Buffer.from(
      Array.from({ length: 4096 }, (_, index) => index % 256),
    );
    const nextDir = createBuildOutput({
      "static/chunks/admin.js": incompressibleContent,
    });
    const [result] = evaluateBudgets({
      nextDir,
      manifest: { pages: { "/admin/page": ["static/chunks/admin.js"] } },
      budgets: [{ route: "/admin", maxGzipKB: 0.1 }],
    });

    assert.equal(result.passed, false);
    assert.ok(result.gzipBytes > result.maxGzipBytes);
    assert.equal(result.chunks[0].file, "static/chunks/admin.js");
  });
});
