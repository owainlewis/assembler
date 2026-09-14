import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("every locked install script has a reviewed, version-pinned decision", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  const pending = new Set(Object.keys(manifest.allowScripts));
  for (const [path, entry] of Object.entries(lock.packages) as [string, { name?: string; version?: string; hasInstallScript?: boolean }][]) {
    if (!entry.hasInstallScript) continue;
    const name = entry.name ?? path.split("node_modules/").at(-1);
    const key = `${name}@${entry.version}`;
    assert.equal(typeof manifest.allowScripts[key], "boolean", `Review install scripts for ${key} and record a pinned allow/deny decision`);
    pending.delete(key);
  }
  assert.deepEqual([...pending], [], "Remove stale or unversioned install-script decisions");
  assert.equal(manifest.allowScripts["esbuild@0.28.2"], true);
  // The published fsevents tarball ships its binary, without an install script.
  // Registry/lock metadata can still advertise one; no build permission is needed.
  assert.equal(manifest.allowScripts["fsevents@2.3.3"], false);
});
