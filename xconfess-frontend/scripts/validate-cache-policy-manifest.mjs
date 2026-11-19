import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const manifestPath = path.join(root, "cache-policy-manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

const privateMarkers = [
  "auth",
  "account",
  "admin",
  "notification",
  "data-export",
  "dm",
  "profile",
  "privacy",
];

let failures = 0;
for (const [route, policy] of Object.entries(manifest.routes ?? {})) {
  if (policy !== "public" && policy !== "private") {
    console.error(`FAIL ${route}: invalid policy ${policy}`);
    failures++;
  }

  if (
    policy === "public" &&
    privateMarkers.some((marker) => route.toLowerCase().includes(marker))
  ) {
    console.error(`FAIL ${route}: personalized or account route marked public`);
    failures++;
  }

  if (policy === "private" && !route.includes("/api/") && !route.includes("/admin")) {
    console.error(`FAIL ${route}: private page route must be account-scoped`);
    failures++;
  }
}

if (failures > 0) process.exit(1);
console.log(`Cache policy manifest valid: ${Object.keys(manifest.routes).length} routes`);
