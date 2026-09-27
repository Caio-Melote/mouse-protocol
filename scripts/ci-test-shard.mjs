#!/usr/bin/env node
// Runs one deterministic shard of the test suite for CI matrix builds.
// Usage: node scripts/ci-test-shard.mjs <shard-index> <shard-count>
// Files are sorted and dealt round-robin so every file runs in exactly one shard.
import { execFileSync, spawnSync } from "node:child_process";

const shard = Number(process.argv[2] ?? "0");
const count = Number(process.argv[3] ?? "1");
if (!Number.isInteger(shard) || !Number.isInteger(count) || shard < 0 || count < 1 || shard >= count) {
  console.error(`usage: ci-test-shard.mjs <shard-index 0..${count - 1}> <shard-count>`);
  process.exit(2);
}

const out = execFileSync("git", ["ls-files", "src/**/*.test.ts"], { encoding: "utf8" });
const files = out.split("\n").map((f) => f.trim()).filter(Boolean).sort();
const mine = files.filter((_, i) => i % count === shard);
if (mine.length === 0) {
  console.error("shard selected no test files");
  process.exit(1);
}
console.log(`shard ${shard + 1}/${count}: ${mine.length}/${files.length} files`);
const child = spawnSync("npx", ["tsx", "--test", ...mine], { stdio: "inherit" });
process.exit(child.status ?? 1);
