import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmodSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const BUILD_SHA = "a".repeat(40);
const PREVIEW_DIGEST = `sha256:${"b".repeat(64)}`;
const SECRET = "physical-device-evidence-secret-2026-qualification";
const roots: string[] = [];

function root() {
    const path = mkdtempSync(resolve(process.cwd(), ".omr-device-attestor-test-"));
    chmodSync(path, 0o700);
    roots.push(path);
    return path;
}

function unsignedEvidence() {
    const device = (platform: "android" | "ios") => ({
        platform,
        status: "passed",
        checkedAt: new Date().toISOString(),
        installed: "passed",
        takeover: "passed",
        handwriting: "passed",
        submission: "passed",
        feedback: "passed",
        reportSha256: createHash("sha256").update(`${platform}-report`).digest("hex"),
    });
    return {
        schemaVersion: 1,
        status: "passed",
        buildSha: BUILD_SHA,
        previewArtifactDigest: PREVIEW_DIGEST,
        generatedAt: new Date().toISOString(),
        android: device("android"),
        ios: device("ios"),
    };
}

function inputFile(parent: string, name = "input.json") {
    const path = join(parent, name);
    writeFileSync(path, `${JSON.stringify(unsignedEvidence())}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
}

function invoke(input: string, output: string) {
    return spawnSync(process.execPath, [
        resolve(process.cwd(), "scripts/attest-physical-device-evidence.mjs"),
        `--input=${input}`,
        `--output=${output}`,
    ], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
            ...process.env,
            OMR_BUILD_SHA: BUILD_SHA,
            OMR_PREVIEW_ARTIFACT_DIGEST: PREVIEW_DIGEST,
            OMR_PHYSICAL_DEVICE_EVIDENCE_HMAC_SECRET: SECRET,
        },
    });
}

afterEach(() => {
    for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("trusted physical-device attestor CLI filesystem boundary", () => {
    it("publishes one private canonical artifact and returns the exact dispatch material", () => {
        const privateRoot = root();
        const input = inputFile(privateRoot);
        const output = join(privateRoot, "evidence.json");
        const result = invoke(input, output);

        expect(result.status, result.stderr).toBe(0);
        expect(lstatSync(output).mode & 0o777).toBe(0o600);
        const summary = JSON.parse(result.stdout);
        const bytes = readFileSync(output);
        expect(summary).toMatchObject({
            status: "attested",
            physicalDeviceEvidenceB64: bytes.toString("base64"),
            physicalDeviceEvidenceSha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        });
    });

    it("rejects an input beneath a group-writable ancestor even when the file itself is 0600", () => {
        const privateRoot = root();
        const unsafe = join(privateRoot, "unsafe");
        mkdirSync(unsafe, { mode: 0o770 });
        chmodSync(unsafe, 0o770);
        const result = invoke(inputFile(unsafe), join(privateRoot, "evidence.json"));

        expect(result.status).toBe(1);
        expect(result.stderr).toBe("unverified: physical_device_evidence_attestation_invalid\n");
    });

    it("rejects input and output paths that traverse an ancestor symlink", () => {
        const privateRoot = root();
        const real = join(privateRoot, "real");
        const inner = join(real, "inner");
        mkdirSync(inner, { recursive: true, mode: 0o700 });
        chmodSync(real, 0o700);
        chmodSync(inner, 0o700);
        const linked = join(privateRoot, "linked");
        symlinkSync(real, linked, "dir");

        expect(invoke(inputFile(inner), join(linked, "inner", "evidence.json")).status).toBe(1);
        expect(invoke(join(linked, "inner", "input.json"), join(privateRoot, "evidence.json")).status).toBe(1);
    });

    it("uses handle-bound no-follow reads and atomic inode-bound publication", () => {
        const source = readFileSync(resolve(process.cwd(), "scripts/private-artifact-io.mjs"), "utf8");
        const cli = readFileSync(resolve(process.cwd(), "scripts/attest-physical-device-evidence.mjs"), "utf8");
        const readBoundary = source.slice(
            source.indexOf("export async function readPrivateArtifact"),
            source.indexOf("async function outputBoundary"),
        );

        expect(source).toContain("O_NOFOLLOW");
        expect(source).toContain("handle.stat()");
        expect(source).toContain("stats.dev !== opened.dev");
        expect(source).toContain("stats.ino !== opened.ino");
        expect(source).toContain("await fs.link(temporaryPath, outputPath)");
        expect(source).toContain("await directoryHandle.sync()");
        expect(source).toContain("await fs.realpath(boundary.parentPath)");
        expect(readBoundary).not.toContain("try { await handle.close(); } catch {}");
        expect(cli).not.toContain("readFile(args.input)");
    });
});
