#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
    formatRestoreApplyStatusLine,
    resolveRestoreTargetApplyConfig,
    runRestoreTargetApply,
} from "./restore-target-apply-core.mjs";

async function main() {
    try {
        const cwd = resolve(import.meta.dirname, "..");
        const config = resolveRestoreTargetApplyConfig({
            argv: process.argv.slice(2),
            env: process.env,
            cwd,
        });
        const result = await runRestoreTargetApply(config);
        process.stdout.write(formatRestoreApplyStatusLine(result));
    } catch {
        process.stdout.write(`${JSON.stringify({
            schemaVersion: 1,
            status: "unverified",
            code: "restore_target_apply_not_verified",
        })}\n`);
        process.exitCode = 1;
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main();
}
