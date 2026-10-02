import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
    attestPhysicalDeviceEvidence,
    canonicalPhysicalDeviceEvidence,
    verifyPhysicalDeviceEvidence,
} from "../../scripts/physical-device-evidence-core.mjs";

const BUILD_SHA = "a".repeat(40);
const PREVIEW_DIGEST = `sha256:${"b".repeat(64)}`;
const SECRET = "physical-device-evidence-secret-2026-qualification";
const NOW = Date.parse("2026-08-29T04:00:00.000Z");

function unsignedEvidence(overrides: Record<string, unknown> = {}) {
    const device = (platform: "android" | "ios") => ({
        platform,
        status: "passed",
        checkedAt: "2026-08-29T03:30:00.000Z",
        installed: "passed",
        takeover: "passed",
        handwriting: "passed",
        submission: "passed",
        feedback: "passed",
        reportSha256: (platform === "android" ? "c" : "d").repeat(64),
    });
    return {
        schemaVersion: 1,
        status: "passed",
        buildSha: BUILD_SHA,
        previewArtifactDigest: PREVIEW_DIGEST,
        generatedAt: "2026-08-29T03:45:00.000Z",
        android: device("android"),
        ios: device("ios"),
        ...overrides,
    };
}

function signedEvidence(overrides: Record<string, unknown> = {}) {
    const unsigned = unsignedEvidence(overrides);
    const integrity = `sha256:${createHash("sha256")
        .update(canonicalPhysicalDeviceEvidence(unsigned))
        .digest("hex")}`;
    const attested = { ...unsigned, integrity };
    const attestation = `hmac-sha256:${createHmac("sha256", SECRET)
        .update("omr.physical-device-evidence:v1\0")
        .update(canonicalPhysicalDeviceEvidence(attested))
        .digest("hex")}`;
    return { ...attested, attestation };
}

function encodedFixture(overrides: Record<string, unknown> = {}) {
    const bytes = Buffer.from(`${JSON.stringify(signedEvidence(overrides))}\n`, "utf8");
    return {
        encoded: bytes.toString("base64"),
        expectedSha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    };
}

describe("physical Android and iOS qualification evidence", () => {
    it("creates canonical dispatch bytes in a trusted attestor and round-trips them through verification", () => {
        const attested = attestPhysicalDeviceEvidence({
            unsigned: unsignedEvidence(),
            expectedBuildSha: BUILD_SHA,
            expectedPreviewArtifactDigest: PREVIEW_DIGEST,
            hmacSecret: SECRET,
            now: NOW,
        });

        expect(attested.bytes.at(-1)).toBe(0x0a);
        expect(attested.encoded).toBe(attested.bytes.toString("base64"));
        expect(attested.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(verifyPhysicalDeviceEvidence({
            encoded: attested.encoded,
            expectedSha256: attested.sha256,
            expectedBuildSha: BUILD_SHA,
            expectedPreviewArtifactDigest: PREVIEW_DIGEST,
            hmacSecret: SECRET,
            now: NOW,
        })).toEqual(attested.evidence);
    });

    it("accepts only a fresh exact-build, exact-preview, fully passed dual-device artifact", () => {
        const fixture = encodedFixture();
        expect(verifyPhysicalDeviceEvidence({
            ...fixture,
            expectedBuildSha: BUILD_SHA,
            expectedPreviewArtifactDigest: PREVIEW_DIGEST,
            hmacSecret: SECRET,
            now: NOW,
        })).toMatchObject({ status: "passed", buildSha: BUILD_SHA });
    });

    it.each([
        ["wrong build", { buildSha: "d".repeat(40) }],
        ["wrong preview", { previewArtifactDigest: `sha256:${"e".repeat(64)}` }],
        ["expired", { generatedAt: "2026-08-28T03:59:59.999Z" }],
        ["missing journey", { android: { ...signedEvidence().android, takeover: "failed" } }],
    ])("rejects %s evidence", (_label, override) => {
        const fixture = encodedFixture(override);
        expect(() => verifyPhysicalDeviceEvidence({
            ...fixture,
            expectedBuildSha: BUILD_SHA,
            expectedPreviewArtifactDigest: PREVIEW_DIGEST,
            hmacSecret: SECRET,
            now: NOW,
        })).toThrow(/Physical device evidence is invalid/);
    });

    it("rejects digest, attestation, and non-canonical base64 changes", () => {
        const fixture = encodedFixture();
        const tamperedBytes = Buffer.from(`${JSON.stringify({
            ...signedEvidence(),
            attestation: `hmac-sha256:${"0".repeat(64)}`,
        })}\n`, "utf8");
        for (const candidate of [
            { ...fixture, expectedSha256: `sha256:${"0".repeat(64)}` },
            { ...fixture, encoded: `${fixture.encoded}\n` },
            {
                encoded: tamperedBytes.toString("base64"),
                expectedSha256: `sha256:${createHash("sha256").update(tamperedBytes).digest("hex")}`,
            },
        ]) {
            expect(() => verifyPhysicalDeviceEvidence({
                ...candidate,
                expectedBuildSha: BUILD_SHA,
                expectedPreviewArtifactDigest: PREVIEW_DIGEST,
                hmacSecret: SECRET,
                now: NOW,
            })).toThrow(/Physical device evidence is invalid/);
        }
    });
});
