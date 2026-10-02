import { RELEASE_ATOMIC_CHECKS } from "./release-quality-core.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const MAX_REPORT_BYTES = 256 * 1024;
const MAX_REPORT_LINES = 8_192;
const MAX_MARKER_JSON_BYTES = 512;
const MAX_SUMMARY_BYTES = 16 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const UTF8_ENCODER = new TextEncoder();

export const LIVE_PG_RELEASE_PROOF_MARKER_PREFIX = "OMR_INITIAL_OPS_RELEASE_PROOF_V1 ";
export const LIVE_PG_RELEASE_WITNESS_MARKER_PREFIX = "OMR_INITIAL_OPS_RELEASE_WITNESS_V1 ";
export const LIVE_PG_ROLLBACK_PHASE_MARKER_PREFIX = "OMR_INITIAL_OPS_ROLLBACK_PHASE_V1 ";

export const LIVE_PG_RELEASE_PROOF_IDS = Object.freeze([
    ...RELEASE_ATOMIC_CHECKS.provisioning_entitlement.map(({ id }) => id),
    ...RELEASE_ATOMIC_CHECKS.data_integrity_isolation.map(({ id }) => id),
].filter((id) => id !== "provisioning_entitlement_one_time_csv"));

export const LIVE_PG_RELEASE_WITNESS_IDS = Object.freeze([
    "provisioning_entitlement_one_time_secret_nonpersistence",
]);

export const LIVE_PG_ROLLBACK_PHASES = Object.freeze([
    "boundary_asserted",
    "rollback_asserted",
    "reapplied",
    "final_asserted",
]);

export const LIVE_PG_RELEASE_PROOF_CATALOG = Object.freeze(
    LIVE_PG_RELEASE_PROOF_IDS.map((id, index) => Object.freeze({ id, ordinal: index + 1 })),
);

export class LivePgReleaseProofError extends Error {
    constructor() {
        super("Live PostgreSQL release proof evidence is invalid");
        this.name = "LivePgReleaseProofError";
    }
}

function fail() {
    throw new LivePgReleaseProofError();
}

function exactRecord(value, expectedKeys) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) fail();
    const expected = [...expectedKeys].sort();
    const actual = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail();
    for (const key of actual) {
        const descriptor = descriptors[key];
        if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set) fail();
    }
    return Object.fromEntries(actual.map((key) => [key, descriptors[key].value]));
}

function exactArray(value, exactLength) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
        || value.length !== exactLength) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== value.length + 1 || keys.at(-1) !== "length"
        || keys.slice(0, -1).some((key, index) => key !== String(index))) fail();
    return value.map((_, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set) fail();
        return descriptor.value;
    });
}

function boundedText(value, maximumBytes) {
    let text;
    try {
        if (typeof value === "string") text = value;
        else if (value instanceof Uint8Array) text = UTF8_DECODER.decode(value);
        else fail();
    } catch {
        fail();
    }
    if (UTF8_ENCODER.encode(text).byteLength > maximumBytes) fail();
    return text;
}

function markerJson(line, prefix, expectedKeys) {
    const encoded = line.slice(prefix.length);
    const bytes = UTF8_ENCODER.encode(encoded).byteLength;
    if (bytes < 2 || bytes > MAX_MARKER_JSON_BYTES) fail();
    let parsed;
    try {
        parsed = parseStrictJson(encoded);
    } catch {
        fail();
    }
    return exactRecord(parsed, expectedKeys);
}

function reportLines(report, expectedPhase, phaseOrdinal, finalReport) {
    const fields = exactRecord(report, ["stdout", "stderr"]);
    const stdout = boundedText(fields.stdout, MAX_REPORT_BYTES);
    const stderr = boundedText(fields.stderr, MAX_REPORT_BYTES);
    const prefixes = [
        LIVE_PG_RELEASE_PROOF_MARKER_PREFIX,
        LIVE_PG_RELEASE_WITNESS_MARKER_PREFIX,
        LIVE_PG_ROLLBACK_PHASE_MARKER_PREFIX,
    ];
    if (prefixes.some((prefix) => stderr.includes(prefix))) fail();
    const lines = stdout.split(/\r?\n/);
    if (lines.length > MAX_REPORT_LINES || lines.some((line) => line.includes("\r"))) fail();

    const phaseLines = lines.filter((line) => line.startsWith(LIVE_PG_ROLLBACK_PHASE_MARKER_PREFIX));
    if (phaseLines.length !== 1) fail();
    const phase = markerJson(
        phaseLines[0], LIVE_PG_ROLLBACK_PHASE_MARKER_PREFIX,
        ["schemaVersion", "ordinal", "phase"],
    );
    if (phase.schemaVersion !== 1 || phase.ordinal !== phaseOrdinal || phase.phase !== expectedPhase) fail();

    const proofLines = lines.filter((line) => line.startsWith(LIVE_PG_RELEASE_PROOF_MARKER_PREFIX));
    const witnessLines = lines.filter((line) => line.startsWith(LIVE_PG_RELEASE_WITNESS_MARKER_PREFIX));
    if (!finalReport && (proofLines.length !== 0 || witnessLines.length !== 0)) fail();
    if (finalReport) {
        if (proofLines.length !== LIVE_PG_RELEASE_PROOF_CATALOG.length
            || witnessLines.length !== LIVE_PG_RELEASE_WITNESS_IDS.length) fail();
        proofLines.forEach((line, index) => {
            const expected = LIVE_PG_RELEASE_PROOF_CATALOG[index];
            const proof = markerJson(
                line, LIVE_PG_RELEASE_PROOF_MARKER_PREFIX,
                ["schemaVersion", "ordinal", "proofId"],
            );
            if (proof.schemaVersion !== 1 || proof.ordinal !== expected.ordinal || proof.proofId !== expected.id) fail();
        });
        witnessLines.forEach((line, index) => {
            const witness = markerJson(
                line, LIVE_PG_RELEASE_WITNESS_MARKER_PREFIX,
                ["schemaVersion", "ordinal", "witnessId"],
            );
            if (witness.schemaVersion !== 1 || witness.ordinal !== index + 1
                || witness.witnessId !== LIVE_PG_RELEASE_WITNESS_IDS[index]) fail();
        });
    }
}

function derivedEvidence() {
    return Object.freeze({
        proofs: LIVE_PG_RELEASE_PROOF_IDS,
        witnesses: LIVE_PG_RELEASE_WITNESS_IDS,
        rollbackPhases: LIVE_PG_ROLLBACK_PHASES,
    });
}

export function deriveLivePgReleaseProofs(input) {
    const fields = exactRecord(input, ["reports"]);
    const reports = exactArray(fields.reports, LIVE_PG_ROLLBACK_PHASES.length);
    reports.forEach((report, index) => reportLines(
        report,
        LIVE_PG_ROLLBACK_PHASES[index],
        index + 1,
        index === LIVE_PG_ROLLBACK_PHASES.length - 1,
    ));
    return derivedEvidence();
}

export function parseLivePgReleaseProofSummary(input) {
    let value = input;
    if (typeof input === "string" || input instanceof Uint8Array) {
        try {
            value = parseStrictJson(boundedText(input, MAX_SUMMARY_BYTES));
        } catch {
            fail();
        }
    }
    const fields = exactRecord(value, ["schemaVersion", "proofs", "witnesses", "rollbackPhases"]);
    if (fields.schemaVersion !== 1) fail();
    const proofs = exactArray(fields.proofs, LIVE_PG_RELEASE_PROOF_IDS.length);
    const witnesses = exactArray(fields.witnesses, LIVE_PG_RELEASE_WITNESS_IDS.length);
    const rollbackPhases = exactArray(fields.rollbackPhases, LIVE_PG_ROLLBACK_PHASES.length);
    if (proofs.some((proof, index) => proof !== LIVE_PG_RELEASE_PROOF_IDS[index])
        || witnesses.some((witness, index) => witness !== LIVE_PG_RELEASE_WITNESS_IDS[index])
        || rollbackPhases.some((phase, index) => phase !== LIVE_PG_ROLLBACK_PHASES[index])) fail();
    return derivedEvidence();
}
