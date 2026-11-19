const fs = require("node:fs");
const path = require("node:path");
const { gzipSync } = require("node:zlib");

function normalizeRoute(route) {
  const withoutRouteGroups = route
    .split("/")
    .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")))
    .join("/");
  const withoutPageSuffix = withoutRouteGroups.replace(/\/page$/, "");
  return withoutPageSuffix || "/";
}

function evaluateBudgets({ nextDir, manifest, budgets }) {
  if (!manifest || typeof manifest.pages !== "object" || manifest.pages === null) {
    throw new Error("The app build manifest does not contain a pages map.");
  }

  const staticDir = path.resolve(nextDir, "static");
  return budgets.map(({ route, maxGzipKB }) => {
    if (typeof route !== "string" || !Number.isFinite(maxGzipKB) || maxGzipKB <= 0) {
      throw new Error("Each route budget must include a route and positive maxGzipKB.");
    }

    const routeEntries = Object.entries(manifest.pages).filter(
      ([manifestRoute]) => normalizeRoute(manifestRoute) === route,
    );
    if (routeEntries.length === 0) {
      throw new Error(`No app build manifest entry found for ${route}.`);
    }

    const chunks = [
      ...new Set(
        routeEntries.flatMap(([, assets]) =>
          Array.isArray(assets) ? assets.filter((asset) => asset.endsWith(".js")) : [],
        ),
      ),
    ];
    if (chunks.length === 0) {
      throw new Error(`No JavaScript chunks found in the app build manifest for ${route}.`);
    }

    const measuredChunks = chunks.map((chunk) => {
      const chunkPath = path.resolve(nextDir, chunk);
      if (!chunkPath.startsWith(`${staticDir}${path.sep}`)) {
        throw new Error(`Manifest chunk is outside the static output directory: ${chunk}`);
      }
      if (!fs.existsSync(chunkPath)) {
        throw new Error(`Manifest chunk is missing from the build output: ${chunk}`);
      }
      const gzipBytes = gzipSync(fs.readFileSync(chunkPath)).byteLength;
      return { file: chunk, gzipBytes };
    });

    const gzipBytes = measuredChunks.reduce((total, chunk) => total + chunk.gzipBytes, 0);
    return {
      route,
      maxGzipBytes: maxGzipKB * 1024,
      gzipBytes,
      chunks: measuredChunks.sort((a, b) => b.gzipBytes - a.gzipBytes),
      passed: gzipBytes <= maxGzipKB * 1024,
    };
  });
}

function formatKB(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function run() {
  const repoDir = path.resolve(__dirname, "..");
  const nextDir = path.join(repoDir, "xconfess-frontend", ".next");
  const manifestPath = path.join(nextDir, "app-build-manifest.json");
  const budgetsPath = path.join(__dirname, "frontend-route-budgets.json");

  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      "Next.js app build manifest not found. Run `npm run frontend:build` before checking route budgets.",
    );
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const budgets = JSON.parse(fs.readFileSync(budgetsPath, "utf8"));
  const results = evaluateBudgets({ nextDir, manifest, budgets });
  let failed = false;

  for (const result of results) {
    const status = result.passed ? "PASS" : "FAIL";
    console.log(
      `${status} ${result.route}: ${formatKB(result.gzipBytes)} / ${formatKB(result.maxGzipBytes)} gzip`,
    );
    if (!result.passed) {
      failed = true;
      console.error("  Largest route chunks:");
      for (const chunk of result.chunks.slice(0, 3)) {
        console.error(`  - ${chunk.file}: ${formatKB(chunk.gzipBytes)} gzip`);
      }
    }
  }

  if (failed) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(`Frontend route budget check failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { evaluateBudgets, normalizeRoute };
