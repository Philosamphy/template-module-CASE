/**
 * tesseract.js (OCR for JPG/PNG intake uploads) requires wasm-feature-detect.
 * Newer releases of that package ship a `sourcePhaseImports` probe built with
 * `import.source(...)`, syntax that only parses on Node >= 24. On Node 22 the
 * require throws a SyntaxError inside tesseract's worker startup, which is an
 * uncaught exception and kills the whole API process mid-upload.
 *
 * The probe is never used by tesseract (it only reads `simd`), so replace that
 * one entry with a harmless `false` and leave the rest of the bundle intact.
 * Runs from `postinstall`, and is a no-op once the file no longer needs it.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let target;
try {
  // Resolve from tesseract.js so we patch the copy the OCR worker actually
  // loads, not whatever this workspace happens to hoist.
  const fromTesseract = createRequire(require.resolve("tesseract.js"));
  target = fromTesseract.resolve("wasm-feature-detect");
} catch {
  // The package is optional for tests and tooling; nothing to do.
  console.log("[patch-wasm-feature-detect] wasm-feature-detect not installed, skipping.");
  process.exit(0);
}

const source = await readFile(target, "utf8");
if (!source.includes("import.source(")) {
  console.log("[patch-wasm-feature-detect] already compatible.");
  process.exit(0);
}

const patched = source.replace(
  /sourcePhaseImports:[\s\S]*?,streamingCompilation:/,
  "sourcePhaseImports:async()=>!1,streamingCompilation:",
);

if (patched === source) {
  console.error(
    "[patch-wasm-feature-detect] could not locate the unsupported probe — OCR will crash on Node < 24.",
  );
  process.exit(1);
}

await writeFile(target, patched, "utf8");
console.log("[patch-wasm-feature-detect] removed unsupported import.source() probe.");
