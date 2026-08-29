import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { parseStrictJson } from "./strict-json.mjs";

const BUILD_SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const HMAC = /^hmac-sha256:[a-f0-9]{64}$/;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_ENCODED_BYTES = 24 * 1024;
const MAX_DECODED_BYTES = 16 * 1024;
const FRESHNESS_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const DOMAIN = "omr.physical-device-evidence:v1\0";

const TOP_LEVEL_KEYS = Object.freeze([
    "android", "attestation", "buildSha", "generatedAt", "integrity", "ios",
    "previewArtifactDigest", "schemaVersion", "status",
]);
const UNSIGNED_TOP_LEVEL_KEYS = Object.freeze([
    "android", "buildSha", "generatedAt", "ios", "previewArtifactDigest", "schemaVersion", "status",
]);
const DEVICE_KEYS = Object.freeze([
    "checkedAt", "feedback", "handwriting", "installed", "platform", "reportSha256",
    "status", "submission", "takeover",
]);

export class PhysicalDeviceEvidenceError extends Error {
    constructor() {
        super("Physical device evidence is invalid");
        this.name = "PhysicalDeviceEvidenceError";
    }
}

function fail() {
    throw new PhysicalDeviceEvidenceError();
}

function plainRecord(value, expectedKeys) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) fail();
    const actual = [...keys].sort();
    const expected = [...expectedKeys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail();
    for (const key of actual) {
        const descriptor = descriptors[key];
        if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set) fail();
    }
    return Object.fromEntries(actual.map((key) => [key, descriptors[key].value]));
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === "object") {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) fail();
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
    }
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    fail();
}

export function canonicalPhysicalDeviceEvidence(value) {
    return JSON.stringify(stableValue(value));
}

export function physicalDeviceEvidenceBytes(encoded) {
    if (
        typeof encoded !== "string"
        || encoded.length < 4
        || encoded.length > MAX_ENCODED_BYTES
        || !CANONICAL_BASE64.test(encoded)
    ) fail();
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.byteLength < 2 || bytes.byteLength > MAX_DECODED_BYTES || bytes.toString("base64") !== encoded) fail();
    return bytes;
}

export function attestPhysicalDeviceEvidence(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) fail();
    const {
        unsigned: rawUnsigned,
        expectedBuildSha,
        expectedPreviewArtifactDigest,
        hmacSecret,
        now = Date.now(),
    } = input;
    const unsigned = plainRecord(rawUnsigned, UNSIGNED_TOP_LEVEL_KEYS);
    const integrity = `sha256:${createHash("sha256")
        .update(canonicalPhysicalDeviceEvidence(unsigned))
        .digest("hex")}`;
    const attestation = `hmac-sha256:${createHmac("sha256", typeof hmacSecret === "string" ? hmacSecret : "")
        .update(DOMAIN)
        .update(canonicalPhysicalDeviceEvidence({ ...unsigned, integrity }))
        .digest("hex")}`;
    const evidence = { ...unsigned, integrity, attestation };
    const bytes = Buffer.from(`${canonicalPhysicalDeviceEvidence(evidence)}\n`, "utf8");
    const encoded = bytes.toString("base64");
    const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    verifyPhysicalDeviceEvidence({
        encoded,
        expectedSha256: sha256,
        expectedBuildSha,
        expectedPreviewArtifactDigest,
        hmacSecret,
        now,
    });
    return Object.freeze({ evidence: Object.freeze(evidence), bytes, encoded, sha256 });
}

function canonicalIso(value) {
    if (typeof value !== "string") fail();
    const milliseconds = Date.parse(value);
    if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== value) fail();
    return milliseconds;
}

function secureEqual(actual, expected) {
    if (typeof actual !== "string" || typeof expected !== "string") return false;
    const left = Buffer.from(actual, "utf8");
    const right = Buffer.from(expected, "utf8");
    return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function validateDevice(raw, platform, generatedAt, now) {
    const device = plainRecord(raw, DEVICE_KEYS);
    if (
        device.platform !== platform
        || device.status !== "passed"
        || !DIGEST.test(`sha256:${device.reportSha256}`)
    ) fail();
    for (const key of ["installed", "takeover", "handwriting", "submission", "feedback"]) {
        if (device[key] !== "passed") fail();
    }
    const checkedAt = canonicalIso(device.checkedAt);
    if (
        checkedAt > now + CLOCK_SKEW_MS
        || now - checkedAt > FRESHNESS_MS
        || checkedAt > generatedAt + CLOCK_SKEW_MS
    ) fail();
    return device;
}

export function verifyPhysicalDeviceEvidence(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) fail();
    const {
        encoded,
        expectedSha256,
        expectedBuildSha,
        expectedPreviewArtifactDigest,
        hmacSecret,
        now = Date.now(),
    } = input;
    if (
        !BUILD_SHA.test(expectedBuildSha)
        || !DIGEST.test(expectedPreviewArtifactDigest)
        || !DIGEST.test(expectedSha256)
        || typeof hmacSecret !== "string"
        || hmacSecret.length < 32
        || hmacSecret.length > 512
        || /\s/.test(hmacSecret)
        || !Number.isSafeInteger(now)
    ) fail();

    const bytes = physicalDeviceEvidenceBytes(encoded);
    const actualSha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (!secureEqual(actualSha256, expectedSha256)) fail();

    let parsed;
    try {
        parsed = parseStrictJson(bytes.toString("utf8"));
    } catch {
        fail();
    }
    const evidence = plainRecord(parsed, TOP_LEVEL_KEYS);
    if (
        evidence.schemaVersion !== 1
        || evidence.status !== "passed"
        || evidence.buildSha !== expectedBuildSha
        || evidence.previewArtifactDigest !== expectedPreviewArtifactDigest
        || !DIGEST.test(evidence.integrity)
        || !HMAC.test(evidence.attestation)
    ) fail();

    const generatedAt = canonicalIso(evidence.generatedAt);
    if (generatedAt > now + CLOCK_SKEW_MS || now - generatedAt > FRESHNESS_MS) fail();
    const android = validateDevice(evidence.android, "android", generatedAt, now);
    const ios = validateDevice(evidence.ios, "ios", generatedAt, now);
    if (android.reportSha256 === ios.reportSha256) fail();

    const { integrity, attestation, ...unsigned } = evidence;
    const expectedIntegrity = `sha256:${createHash("sha256")
        .update(canonicalPhysicalDeviceEvidence(unsigned))
        .digest("hex")}`;
    if (!secureEqual(integrity, expectedIntegrity)) fail();
    const expectedAttestation = `hmac-sha256:${createHmac("sha256", hmacSecret)
        .update(DOMAIN)
        .update(canonicalPhysicalDeviceEvidence({ ...unsigned, integrity }))
        .digest("hex")}`;
    if (!secureEqual(attestation, expectedAttestation)) fail();
    return Object.freeze({ ...evidence, android: Object.freeze(android), ios: Object.freeze(ios) });
}
