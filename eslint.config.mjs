import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "public/pdf.worker.min.mjs",
    "public/react-pdf.worker.min.mjs",
    "playwright-report/**",
    "test-results/**",
    // Capacitor native shell (generated Android/Gradle project + web-dir fallback).
    "android/**",
    "mobile/**",
    // Linked git worktrees carry their own .next/ build output, and the ".next/**"
    // entry above only anchors at the repo root — so a single active worktree was
    // enough to bury `npm run lint` under ~40k findings from minified chunks.
    ".worktrees/**",
  ]),
]);

export default eslintConfig;
