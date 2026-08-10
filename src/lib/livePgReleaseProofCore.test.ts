import { describe, expect, it } from "vitest";

import * as livePgProofCore from "../../scripts/live-pg-release-proof-core.mjs";
import { RELEASE_ATOMIC_CHECKS } from "../../scripts/release-quality-core.mjs";

type AtomicCheck = { id: string };
const EXPECTED_IDS = [
    ...(RELEASE_ATOMIC_CHECKS.provisioning_entitlement as readonly AtomicCheck[]).map(({ id }) => id),
    ...(RELEASE_ATOMIC_CHECKS.data_integrity_isolation as readonly AtomicCheck[]).map(({ id }) => id),
].filter((id) => id !== "provisioning_entitlement_one_time_csv");
const EXPECTED_WITNESSES = ["provisioning_entitlement_one_time_secret_nonpersistence"];
const EXPECTED_ROLLBACK_PHASES = [
    "boundary_asserted", "rollback_asserted", "reapplied", "final_asserted",
];

const {
    LIVE_PG_RELEASE_PROOF_IDS,
    LIVE_PG_RELEASE_PROOF_MARKER_PREFIX,
    LIVE_PG_RELEASE_WITNESS_IDS,
    LIVE_PG_RELEASE_WITNESS_MARKER_PREFIX,
    LIVE_PG_ROLLBACK_PHASES,
    LIVE_PG_ROLLBACK_PHASE_MARKER_PREFIX,
    LivePgReleaseProofError,
    deriveLivePgReleaseProofs,
    parseLivePgReleaseProofSummary,
} = livePgProofCore as typeof livePgProofCore & Record<string, unknown>;

function marker(proofId: string, index: number): string {
    return `${LIVE_PG_RELEASE_PROOF_MARKER_PREFIX}${JSON.stringify({
        schemaVersion: 1,
        ordinal: index + 1,
        proofId,
    })}`;
}

function proofStdout(ids = EXPECTED_IDS): string {
    return [
        "BEGIN",
        "SET",
        ...ids.flatMap((id, index) => ["DO", marker(id, index)]),
        `${LIVE_PG_RELEASE_WITNESS_MARKER_PREFIX}${JSON.stringify({
            schemaVersion: 1,
            ordinal: 1,
            witnessId: EXPECTED_WITNESSES[0],
        })}`,
        "ROLLBACK",
    ].join("\n") + "\n";
}

function phaseStdout(phase: string, ordinal: number, includeProofs = false): string {
    const phaseMarker = `${LIVE_PG_ROLLBACK_PHASE_MARKER_PREFIX}${JSON.stringify({
        schemaVersion: 1,
        ordinal,
        phase,
    })}`;
    return includeProofs ? `${phaseMarker}\n${proofStdout()}` : `${phaseMarker}\n`;
}

function reports() {
    return EXPECTED_ROLLBACK_PHASES.map((phase, index) => ({
        stdout: phaseStdout(phase, index + 1, index === EXPECTED_ROLLBACK_PHASES.length - 1),
        stderr: "",
    }));
}

describe("live PostgreSQL release proof core", () => {
    it("keeps the immutable expected IDs exactly aligned with the nineteen PostgreSQL atomics", () => {
        expect(LIVE_PG_RELEASE_PROOF_IDS).toEqual(EXPECTED_IDS);
        expect(new Set(LIVE_PG_RELEASE_PROOF_IDS).size).toBe(19);
        expect(LIVE_PG_RELEASE_WITNESS_IDS).toEqual(EXPECTED_WITNESSES);
        expect(LIVE_PG_ROLLBACK_PHASES).toEqual(EXPECTED_ROLLBACK_PHASES);
    });

    it("derives exact proofs and the secret witness only from the ordered four-phase PostgreSQL transcript", () => {
        const transcript = reports();
        transcript[0].stderr = "psql warning without a marker\n";
        expect(deriveLivePgReleaseProofs({ reports: transcript })).toEqual({
            proofs: EXPECTED_IDS,
            witnesses: EXPECTED_WITNESSES,
            rollbackPhases: EXPECTED_ROLLBACK_PHASES,
        });
    });

    it.each([
        ["missing", () => proofStdout(EXPECTED_IDS.slice(0, -1))],
        ["duplicate", () => proofStdout().replace("ROLLBACK", `${marker(EXPECTED_IDS[0], 1)}\nROLLBACK`)],
        ["unknown", () => proofStdout().replace(EXPECTED_IDS[4], "provisioning_entitlement_invented")],
        ["out-of-order", () => {
            const lines = proofStdout().split("\n");
            const first = lines.indexOf(marker(EXPECTED_IDS[0], 0));
            const second = lines.indexOf(marker(EXPECTED_IDS[1], 1));
            [lines[first], lines[second]] = [lines[second], lines[first]];
            return lines.join("\n");
        }],
        ["malformed", () => proofStdout().replace(marker(EXPECTED_IDS[0], 0), `${LIVE_PG_RELEASE_PROOF_MARKER_PREFIX}{broken`) ],
    ])("rejects %s stdout markers", (_name, mutate) => {
        const transcript = reports();
        transcript[3].stdout = `${phaseStdout(EXPECTED_ROLLBACK_PHASES[3], 4)}${mutate()}`;
        expect(() => deriveLivePgReleaseProofs({ reports: transcript }))
            .toThrow(LivePgReleaseProofError);
    });

    it("rejects stderr-only markers even when all stdout markers otherwise pass", () => {
        const transcript = reports();
        transcript[3].stdout = transcript[3].stdout.replace(marker(EXPECTED_IDS.at(-1)!, EXPECTED_IDS.length - 1), "");
        transcript[3].stderr = marker(EXPECTED_IDS.at(-1)!, EXPECTED_IDS.length - 1);
        expect(() => deriveLivePgReleaseProofs({ reports: transcript })).toThrow(LivePgReleaseProofError);
    });

    it("rejects missing, duplicate, unknown, or out-of-order rollback phase markers", () => {
        for (const transcript of [
            reports().slice(1),
            [reports()[0], reports()[0], reports()[2], reports()[3]],
            reports().map((report, index) => index === 1
                ? { ...report, stdout: report.stdout.replace("rollback_asserted", "invented") } : report),
            [reports()[1], reports()[0], reports()[2], reports()[3]],
        ]) expect(() => deriveLivePgReleaseProofs({ reports: transcript })).toThrow(LivePgReleaseProofError);
    });

    it("rejects the atomic one-time CSV ID as a PostgreSQL marker", () => {
        const transcript = reports();
        transcript[3].stdout = transcript[3].stdout.replace(
            "ROLLBACK",
            `${LIVE_PG_RELEASE_PROOF_MARKER_PREFIX}${JSON.stringify({
                schemaVersion: 1, ordinal: 20, proofId: "provisioning_entitlement_one_time_csv",
            })}\nROLLBACK`,
        );
        expect(() => deriveLivePgReleaseProofs({ reports: transcript })).toThrow(LivePgReleaseProofError);
    });

    it("rejects accessor, prototype, sparse-summary, and oversized inputs", () => {
        const accessor = { stderr: "" } as Record<string, unknown>;
        Object.defineProperty(accessor, "stdout", { enumerable: true, get: () => proofStdout() });
        const prototype = Object.assign(Object.create({ inherited: true }), { stdout: proofStdout(), stderr: "" });
        const sparseProofs = [...EXPECTED_IDS];
        delete sparseProofs[3];
        const oversizedOutput = "x".repeat(256 * 1024 + 1);
        const oversizedMarker = `${LIVE_PG_RELEASE_PROOF_MARKER_PREFIX}${"x".repeat(4_096)}`;

        expect(() => deriveLivePgReleaseProofs({ reports: [accessor, ...reports().slice(1)] }))
            .toThrow(LivePgReleaseProofError);
        expect(() => deriveLivePgReleaseProofs({ reports: [prototype, ...reports().slice(1)] }))
            .toThrow(LivePgReleaseProofError);
        expect(() => parseLivePgReleaseProofSummary({
            schemaVersion: 1, proofs: sparseProofs,
            witnesses: EXPECTED_WITNESSES, rollbackPhases: EXPECTED_ROLLBACK_PHASES,
        }))
            .toThrow(LivePgReleaseProofError);
        expect(() => deriveLivePgReleaseProofs({ reports: [
            { stdout: oversizedOutput, stderr: "" }, ...reports().slice(1),
        ] }))
            .toThrow(LivePgReleaseProofError);
        expect(() => deriveLivePgReleaseProofs({ reports: [
            ...reports().slice(0, -1), { stdout: oversizedMarker, stderr: "" },
        ] }))
            .toThrow(LivePgReleaseProofError);
    });

    it("strictly validates the bounded verifier summary instead of accepting caller claims", () => {
        const expected = {
            proofs: EXPECTED_IDS,
            witnesses: EXPECTED_WITNESSES,
            rollbackPhases: EXPECTED_ROLLBACK_PHASES,
        };
        const summary = Buffer.from(JSON.stringify({ schemaVersion: 1, ...expected }));
        expect(parseLivePgReleaseProofSummary(summary)).toEqual(expected);
        expect(() => parseLivePgReleaseProofSummary(Buffer.from(JSON.stringify({
            schemaVersion: 1,
            proofs: EXPECTED_IDS.slice(1),
            witnesses: EXPECTED_WITNESSES,
            rollbackPhases: EXPECTED_ROLLBACK_PHASES,
        })))).toThrow(LivePgReleaseProofError);
        expect(() => parseLivePgReleaseProofSummary({
            schemaVersion: 1,
            proofs: EXPECTED_IDS,
            witnesses: EXPECTED_WITNESSES,
            rollbackPhases: EXPECTED_ROLLBACK_PHASES,
            injected: true,
        })).toThrow(LivePgReleaseProofError);
    });
});
