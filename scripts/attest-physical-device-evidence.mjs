#!/usr/bin/env node

import { isAbsolute } from "node:path";

import { attestPhysicalDeviceEvidence } from "./physical-device-evidence-core.mjs";
import { publishPrivateArtifact, readPrivateArtifact } from "./private-artifact-io.mjs";
import { parseStrictJson } from "./strict-json.mjs";

function fail() {
    throw new Error("unverified: physical_device_evidence_attestation_invalid");
}

function parseArgs(argv) {
    const result = { input: "", output: "" };
    const seen = new Set();
    for (const value of argv) {
        const separator = value.indexOf("=");
        const name = separator > 0 ? value.slice(0, separator) : "";
        const path = separator > 0 ? value.slice(separator + 1) : "";
        if ((name !== "--input" && name !== "--output") || seen.has(name)) fail();
        seen.add(name);
        if (!path || !isAbsolute(path) || path.includes("\0")) fail();
        if (name === "--input") result.input = path;
        else result.output = path;
    }
    if (!result.input || !result.output || result.input === result.output) fail();
    return result;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const raw = await readPrivateArtifact(args.input);
    let unsigned;
    try {
        unsigned = parseStrictJson(raw.toString("utf8"));
    } catch {
        fail();
    }
    const result = attestPhysicalDeviceEvidence({
        unsigned,
        expectedBuildSha: process.env.OMR_BUILD_SHA || "",
        expectedPreviewArtifactDigest: process.env.OMR_PREVIEW_ARTIFACT_DIGEST || "",
        hmacSecret: process.env.OMR_PHYSICAL_DEVICE_EVIDENCE_HMAC_SECRET || "",
    });
    await publishPrivateArtifact(args.output, result.bytes);
    process.stdout.write(`${JSON.stringify({
        status: "attested",
        physicalDeviceEvidenceB64: result.encoded,
        physicalDeviceEvidenceSha256: result.sha256,
    })}\n`);
}

main().catch(() => {
    process.stderr.write("unverified: physical_device_evidence_attestation_invalid\n");
    process.exitCode = 1;
});
