#!/usr/bin/env node
// Chorus CLI entry. Resolves dist/ when published, falls back to tsx for dev.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distEntry = resolve(__dirname, "../dist/cli/index.js");

if (existsSync(distEntry)) {
  await import(distEntry);
} else {
  // Dev / unpublished install — register tsx and run from src.
  const tsx = await import("tsx/esm/api");
  tsx.register();
  await import(resolve(__dirname, "../src/cli/index.ts"));
}
