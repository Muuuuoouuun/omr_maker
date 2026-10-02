#!/usr/bin/env node

import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import {
    physicalDeviceEvidenceBytes,
    verifyPhysicalDeviceEvidence,
} from "./physical-device-evidence-core.mjs";

function fail() {
    throw new Error("unverified: physical_device_evidence_invalid");
}

function parseArgs(argv) {
    const result = { file: "", output: "" };
    for (const value of argv) {
        if (value.startsWith("--file=")) result.file = value.slice("--file=".length);
        else if (value.startsWith("--output=")) result.output = value.slice("--output=".length);
        else fail();
    }
    if (Boolean(result.file) === Boolean(result.output)) fail();
    const selected = result.file || result.output;
    if (!isAbsolute(selected) || selected.includes("\0")) fail();
    return result;
}

async function writeExclusive(path, bytes) {
    const parent = await lstat(dirname(path));
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) !== 0) fail();
    const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
        await handle.writeFile(bytes);
        await handle.sync();
        const stats = await handle.stat();
        if (!stats.isFile() || stats.size !== bytes.byteLength || (stats.mode & 0o777) !== 0o600) fail();
    } finally {
        await handle.close();
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    let encoded = process.env.OMR_PHYSICAL_DEVICE_EVIDENCE_B64 || "";
    if (args.file) {
        const stats = await lstat(args.file);
        if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size < 2 || stats.size > 16 * 1024) fail();
        encoded = (await readFile(args.file)).toString("base64");
    }
    const input = {
        encoded,
        expectedSha256: process.env.OMR_PHYSICAL_DEVICE_EVIDENCE_SHA256 || "",
        expectedBuildSha: process.env.OMR_BUILD_SHA || "",
        expectedPreviewArtifactDigest: process.env.OMR_PREVIEW_ARTIFACT_DIGEST || "",
        hmacSecret: process.env.OMR_PHYSICAL_DEVICE_EVIDENCE_HMAC_SECRET || "",
    };
    verifyPhysicalDeviceEvidence(input);
    if (args.output) await writeExclusive(args.output, physicalDeviceEvidenceBytes(encoded));
    process.stdout.write('{"status":"verified","code":"physical_device_evidence_verified"}\n');
}

main().catch(() => {
    process.stderr.write("unverified: physical_device_evidence_invalid\n");
    process.exitCode = 1;
});
