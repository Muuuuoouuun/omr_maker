import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    open,
    readFile,
    readdir,
    realpath,
    rename,
    symlink,
    unlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
    RELEASE_ARTIFACT_CATALOG,
    RELEASE_ATOMIC_CHECKS,
    RELEASE_DIMENSIONS,
    RELEASE_HARD_GATE_PREDICATES,
    RELEASE_HARD_GATES,
    scoreReleaseEvidence,
} from "../../scripts/release-quality-core.mjs";
import {
    parseReleaseScoreArgs,
    runReleaseScoreCli,
} from "../../scripts/score-release-quality.mjs";

const BUILD_SHA = "a".repeat(40);
const SCORER_SHA = "b".repeat(40);
const ENVIRONMENT_DIGEST = "c".repeat(64);
const NOW = new Date("2026-08-09T00:00:00.000Z");
const ARBITRARY_BYTES = Buffer.from("bounded but semantically meaningless evidence\n", "utf8");
const ARTIFACT_PATH = "/private/release/evidence-student_core.json";
type EvidenceStatus = "passed" | "failed" | "skipped" | "unverified";
type AtomicCheck = { id: string; weightTenths: number };
type FixtureEvidenceState = Record<string, {
    checks: Record<string, EvidenceStatus>;
    hardGates: Record<string, EvidenceStatus>;
}>;
const FIXTURE_EVIDENCE = new WeakMap<object, FixtureEvidenceState>();

function artifact(kind: (typeof RELEASE_DIMENSIONS)[number], overrides: Record<string, unknown> = {}) {
    const catalog = RELEASE_ARTIFACT_CATALOG[kind];
    const defaultFreshUntil = NOW.toISOString();
    const defaultGeneratedAt = new Date(NOW.getTime() - catalog.maxAgeMs).toISOString();
    return {
        id: catalog.id,
        kind,
        evidenceClass: catalog.evidenceClass,
        path: `/private/release/evidence-${kind}.json`,
        sha256: "0".repeat(64),
        generatedAt: defaultGeneratedAt,
        freshUntil: defaultFreshUntil,
        buildSha: BUILD_SHA,
        environmentDigest: ENVIRONMENT_DIGEST,
        status: "verified",
        ...overrides,
    };
}

function failedCheckIndexes(scoreTenths: number, weights: number[]): Set<number> {
    const deficit = 100 - scoreTenths;
    for (let mask = 0; mask < 2 ** weights.length; mask += 1) {
        const indexes = weights.map((_, index) => index).filter((index) => (mask & (1 << index)) !== 0);
        if (indexes.reduce((sum, index) => sum + weights[index], 0) === deficit) return new Set(indexes);
    }
    throw new Error(`unsupported fixture score ${scoreTenths}`);
}

function manifest(scores: Partial<Record<(typeof RELEASE_DIMENSIONS)[number], number>> = {}) {
    const evidenceState: FixtureEvidenceState = {};
    const result = {
        schemaVersion: 1,
        buildSha: BUILD_SHA,
        environmentDigest: ENVIRONMENT_DIGEST,
        generatedAt: NOW.toISOString(),
        artifacts: RELEASE_DIMENSIONS.map((kind) => artifact(kind)),
        dimensions: RELEASE_DIMENSIONS.map((id) => {
            const scoreTenths = scores[id] ?? 100;
            const catalog = RELEASE_ATOMIC_CHECKS[id] as AtomicCheck[];
            const failed = failedCheckIndexes(scoreTenths, catalog.map((check: AtomicCheck) => check.weightTenths));
            evidenceState[id] = {
                checks: Object.fromEntries(catalog.map((check: AtomicCheck, index: number) => [
                    check.id,
                    failed.has(index) ? "failed" : "passed",
                ])),
                hardGates: {},
            };
            return {
                id,
                checks: catalog.map((check: AtomicCheck) => ({
                    ...check,
                    artifactId: RELEASE_ARTIFACT_CATALOG[id].id,
                })),
            };
        }),
        hardGates: RELEASE_HARD_GATES.map((id) => ({
            id,
            artifactId: RELEASE_ARTIFACT_CATALOG[
                RELEASE_DIMENSIONS.find((kind) => RELEASE_ARTIFACT_CATALOG[kind].hardGates.includes(id))!
            ].id,
        })),
    };
    for (const gate of result.hardGates) {
        const kind = RELEASE_DIMENSIONS.find((candidate) => RELEASE_ARTIFACT_CATALOG[candidate].hardGates.includes(gate.id))!;
        evidenceState[kind].hardGates[gate.id] = "passed";
    }
    FIXTURE_EVIDENCE.set(result, evidenceState);
    for (const descriptor of result.artifacts) {
        refreshArtifact(result, descriptor.kind);
    }
    return result;
}

function artifactEvidenceBytes(
    input: ReturnType<typeof manifest>,
    kind: (typeof RELEASE_DIMENSIONS)[number],
    overrides: { checks?: Record<string, EvidenceStatus>; hardGates?: Record<string, EvidenceStatus> } = {},
) {
    const descriptor = input.artifacts.find((candidate) => candidate.kind === kind)!;
    const state = FIXTURE_EVIDENCE.get(input)?.[kind];
    const checkStatuses = { ...(state?.checks ?? {}), ...(overrides.checks ?? {}) };
    const hardGateStatuses = { ...(state?.hardGates ?? {}), ...(overrides.hardGates ?? {}) };
    return Buffer.from(`${JSON.stringify({
        schemaVersion: 1,
        kind,
        buildSha: descriptor.buildSha,
        environmentDigest: descriptor.environmentDigest,
        generatedAt: descriptor.generatedAt,
        status: descriptor.status,
        checks: (RELEASE_ATOMIC_CHECKS[kind] as AtomicCheck[]).map(({ id }: AtomicCheck) => ({
            id,
            status: checkStatuses[id] ?? "passed",
        })),
        hardGates: RELEASE_ARTIFACT_CATALOG[kind].hardGates.map((id) => ({
            id,
            status: hardGateStatuses[id] ?? "passed",
        })),
    })}\n`, "utf8");
}

function refreshArtifact(input: ReturnType<typeof manifest>, kind: (typeof RELEASE_DIMENSIONS)[number]) {
    const descriptor = input.artifacts.find((candidate) => candidate.kind === kind)!;
    descriptor.sha256 = createHash("sha256").update(artifactEvidenceBytes(input, kind)).digest("hex");
}

function setAtomicStatus(
    input: ReturnType<typeof manifest>,
    kind: (typeof RELEASE_DIMENSIONS)[number],
    checkIndex: number,
    status: EvidenceStatus,
) {
    const state = FIXTURE_EVIDENCE.get(input)!;
    state[kind].checks[RELEASE_ATOMIC_CHECKS[kind][checkIndex].id] = status;
    refreshArtifact(input, kind);
}

function setAtomicStatusById(
    input: ReturnType<typeof manifest>,
    checkId: string,
    status: EvidenceStatus,
) {
    const kind = RELEASE_DIMENSIONS.find((candidate) => (
        RELEASE_ATOMIC_CHECKS[candidate] as AtomicCheck[]
    ).some((check) => check.id === checkId))!;
    const state = FIXTURE_EVIDENCE.get(input)!;
    state[kind].checks[checkId] = status;
    refreshArtifact(input, kind);
}

function setHardGateStatus(input: ReturnType<typeof manifest>, gateId: string, status: EvidenceStatus) {
    const kind = RELEASE_DIMENSIONS.find((candidate) => RELEASE_ARTIFACT_CATALOG[candidate].hardGates.includes(gateId))!;
    FIXTURE_EVIDENCE.get(input)![kind].hardGates[gateId] = status;
    refreshArtifact(input, kind);
}

function scoringDependencies(input: ReturnType<typeof manifest>, rawOverrides: Partial<Record<(typeof RELEASE_DIMENSIONS)[number], Buffer>> = {}) {
    const byPath = new Map(input.artifacts.map((descriptor) => [
        descriptor.path,
        rawOverrides[descriptor.kind] ?? artifactEvidenceBytes(input, descriptor.kind),
    ]));
    return {
        now: () => NOW,
        scorerSha: SCORER_SHA,
        readArtifact: async (path: string) => {
            const bytes = byPath.get(path);
            if (!bytes) throw new Error("unexpected artifact");
            return bytes;
        },
    };
}

async function cliFixture(scores: Parameters<typeof manifest>[0] = {}) {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "omr-release-score-")));
    await chmod(temporary, 0o700);
    const manifestPath = join(temporary, "manifest.json");
    const outputPath = join(temporary, "score.json");
    const input = manifest(scores);
    const artifactPaths: string[] = [];
    for (const [index, descriptor] of input.artifacts.entries()) {
        const artifactPath = join(temporary, `artifact-${index}.json`);
        artifactPaths.push(artifactPath);
        await writeFile(artifactPath, artifactEvidenceBytes(input, descriptor.kind), { mode: 0o600, flag: "wx" });
        descriptor.path = artifactPath;
    }
    await writeFile(manifestPath, `${JSON.stringify(input)}\n`, { mode: 0o600, flag: "wx" });
    return { temporary, artifactPaths, manifestPath, outputPath, input };
}

describe("release quality scorer", () => {
    it("exports the exact ten release dimensions", () => {
        expect(RELEASE_DIMENSIONS).toEqual([
            "student_core",
            "teacher_core",
            "provisioning_entitlement",
            "data_integrity_isolation",
            "code_supply_chain",
            "browser_determinism",
            "ux_accessibility_responsiveness",
            "hosted_deployment",
            "capacity_observability",
            "recovery_release",
        ]);
    });

    it("fixes ten checks and 100 tenths per dimension including teacher login and load states", () => {
        const teacherChecks = (RELEASE_ATOMIC_CHECKS.teacher_core as AtomicCheck[]).map((check) => check.id);

        expect(teacherChecks).toContain("teacher_core_teacher_login");
        expect(teacherChecks).toContain("teacher_core_truthful_load_states");
        for (const dimension of RELEASE_DIMENSIONS) {
            const checks = RELEASE_ATOMIC_CHECKS[dimension] as AtomicCheck[];
            expect(checks).toHaveLength(10);
            expect(checks.reduce((sum, check) => sum + check.weightTenths, 0)).toBe(100);
        }
    });

    it("scores exact tenths and accepts the mean and minimum boundary", async () => {
        const input = manifest({
            student_core: 87,
            teacher_core: 100,
            provisioning_entitlement: 100,
            data_integrity_isolation: 100,
            code_supply_chain: 93,
            browser_determinism: 90,
            ux_accessibility_responsiveness: 93,
            hosted_deployment: 87,
            capacity_observability: 90,
            recovery_release: 90,
        });
        setAtomicStatusById(input, "browser_determinism_zero_order_dependence", "passed");
        setAtomicStatusById(input, "browser_determinism_credential_boundary", "failed");
        setAtomicStatusById(input, "recovery_release_object_hashes", "passed");
        setAtomicStatusById(input, "recovery_release_credential_revocation", "failed");

        await expect(scoreReleaseEvidence(input, scoringDependencies(input))).resolves.toMatchObject({
            schemaVersion: 1,
            status: "go",
            buildSha: BUILD_SHA,
            environmentDigest: ENVIRONMENT_DIGEST,
            scorerSha: SCORER_SHA,
            mean: 9.3,
            minimum: 8.7,
            dimensions: {
                student_core: 8.7,
                teacher_core: 10,
                recovery_release: 9,
            },
            hardGateFailures: [],
            evidenceFailures: [],
        });
    });

    it("gates on exact integer tenths instead of a rounded display mean", async () => {
        const input = manifest(Object.fromEntries(RELEASE_DIMENSIONS.map((dimension, index) => [
            dimension,
            index < 5 ? 93 : 92,
        ])));

        const result = await scoreReleaseEvidence(input, scoringDependencies(input));

        expect(result.mean).toBe(9.25);
        expect(result.minimum).toBe(9.2);
        expect(result.status).toBe("no_go");
    });

    it.each([
        ["failed", "core_e2e"],
        ["skipped", "unexplained_skips"],
        ["unverified", "hundred_user_load"],
    ])("forces no_go when hard gate evidence is %s", async (status, gateId) => {
        const input = manifest();
        setHardGateStatus(input, gateId, status as EvidenceStatus);

        const result = await scoreReleaseEvidence(input, scoringDependencies(input));

        expect(result.status).toBe("no_go");
        expect(result.hardGateFailures).toContain(gateId);
    });

    it.each([
        ["core_e2e", "browser_determinism_zero_retry"],
        ["health_readiness", "hosted_deployment_health_sha"],
        ["production_boundary", "data_integrity_isolation_tenant_isolation"],
        ["hundred_user_load", "capacity_observability_hundred_user_load"],
        ["submission_integrity", "data_integrity_isolation_submission_replay"],
        ["data_exposure", "data_integrity_isolation_storage_isolation"],
        ["secret_hygiene", "code_supply_chain_secret_scan"],
        ["log_hygiene", "capacity_observability_log_redaction"],
        ["sink_alert_heartbeat", "capacity_observability_cleanup_heartbeat"],
        ["restore_rpo_rto", "recovery_release_rpo"],
        ["production_vulnerabilities", "code_supply_chain_production_audit"],
        ["unexplained_skips", "browser_determinism_skip_accounting"],
    ])("does not let a passed %s gate contradict failed atomic evidence", async (gateId, checkId) => {
        const input = manifest();
        setAtomicStatusById(input, checkId, "failed");

        const result = await scoreReleaseEvidence(input, scoringDependencies(input));

        expect(result.hardGateFailures).toContain(gateId);
        expect(result.status).toBe("no_go");
    });

    it("exports a complete immutable hard-gate predicate catalog", () => {
        const fixedCheckIds = new Set(RELEASE_DIMENSIONS.flatMap((dimension) => (
            RELEASE_ATOMIC_CHECKS[dimension] as AtomicCheck[]
        ).map((check) => check.id)));

        expect(Object.keys(RELEASE_HARD_GATE_PREDICATES).sort()).toEqual([...RELEASE_HARD_GATES].sort());
        expect(Object.isFrozen(RELEASE_HARD_GATE_PREDICATES)).toBe(true);
        expect(RELEASE_HARD_GATES.every((gate) => Object.isFrozen(RELEASE_HARD_GATE_PREDICATES[gate]))).toBe(true);
        expect(RELEASE_HARD_GATES.every((gate) => (
            RELEASE_HARD_GATE_PREDICATES[gate] as string[]
        ).every((checkId) => fixedCheckIds.has(checkId)))).toBe(true);
    });

    it.each([
        ["wrong hash", { sha256: "0".repeat(64) }],
        ["wrong build", { buildSha: "c".repeat(40) }],
        ["expired", { freshUntil: "2026-08-08T23:59:59.999Z" }],
        ["unverified", { status: "unverified" }],
    ])("scores evidence as zero and fails closed when an artifact is %s", async (_label, overrides) => {
        const input = manifest();
        input.artifacts = RELEASE_DIMENSIONS.map((kind) => artifact(kind, overrides));

        const result = await scoreReleaseEvidence(input, scoringDependencies(input));

        expect(result.status).toBe("no_go");
        expect(result.minimum).toBe(0);
        expect(result.evidenceFailures).not.toHaveLength(0);
        expect(result.hardGateFailures).toEqual(RELEASE_HARD_GATES);
    });

    it("rejects an empty artifact even when its declared hash matches", async () => {
        const input = manifest();
        input.artifacts = RELEASE_DIMENSIONS.map((kind) => artifact(kind, {
            sha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
        }));

        const result = await scoreReleaseEvidence(input, {
            ...scoringDependencies(input),
            readArtifact: async () => Buffer.alloc(0),
        });

        expect(result.status).toBe("no_go");
        expect(result.evidenceFailures).toContainEqual({
            artifactId: RELEASE_ARTIFACT_CATALOG.student_core.id,
            code: "artifact_unreadable",
        });
    });

    it.each([
        ["null", null],
        ["array", []],
        ["unsupported version", { ...manifest(), schemaVersion: 2 }],
        ["uppercase build SHA", { ...manifest(), buildSha: "A".repeat(40) }],
        ["extra top-level key", { ...manifest(), secret: "must-not-be-accepted" }],
    ])("rejects a malformed %s envelope", async (_label, input) => {
        await expect(scoreReleaseEvidence(input, scoringDependencies(manifest()))).rejects.toMatchObject({
            name: "ReleaseQualityError",
        });
    });

    it("rejects symbol-key extensions to an otherwise exact envelope", async () => {
        const input = manifest();
        Object.defineProperty(input, Symbol("hidden"), { value: "not-allowlisted" });

        await expect(scoreReleaseEvidence(input, scoringDependencies(manifest()))).rejects.toMatchObject({
            code: "invalid_manifest",
        });
    });

    it("rejects getters without evaluating them", async () => {
        const input = manifest();
        let getterCalls = 0;
        Object.defineProperty(input, "buildSha", {
            enumerable: true,
            get: () => {
                getterCalls += 1;
                return BUILD_SHA;
            },
        });

        await expect(scoreReleaseEvidence(input, scoringDependencies(manifest()))).rejects.toMatchObject({
            code: "invalid_manifest",
        });
        expect(getterCalls).toBe(0);
    });

    it("rejects array element getters without evaluating them", async () => {
        const input = manifest();
        let getterCalls = 0;
        Object.defineProperty(input.artifacts, 0, {
            enumerable: true,
            get: () => {
                getterCalls += 1;
                return artifact("student_core");
            },
        });

        await expect(scoreReleaseEvidence(input, scoringDependencies(manifest()))).rejects.toMatchObject({
            code: "invalid_manifest",
        });
        expect(getterCalls).toBe(0);
    });

    it("rejects huge and sparse bounded arrays", async () => {
        const huge = manifest();
        huge.artifacts = Array.from({ length: 257 }, (_, index) => artifact("student_core", { id: `artifact-${index}` }));
        await expect(scoreReleaseEvidence(huge, scoringDependencies(manifest()))).rejects.toMatchObject({
            code: "invalid_manifest",
        });

        const sparse = manifest();
        sparse.dimensions = new Array(RELEASE_DIMENSIONS.length);
        sparse.dimensions[0] = manifest().dimensions[0];
        await expect(scoreReleaseEvidence(sparse, scoringDependencies(manifest()))).rejects.toMatchObject({
            code: "invalid_manifest",
        });
    });

    it("rejects duplicate artifact and atomic-check IDs", async () => {
        const duplicateArtifact = manifest();
        duplicateArtifact.artifacts.push(artifact("student_core"));
        await expect(scoreReleaseEvidence(duplicateArtifact, scoringDependencies(manifest()))).rejects.toMatchObject({
            name: "ReleaseQualityError",
        });

        const duplicateCheck = manifest();
        duplicateCheck.dimensions[1].checks[0].id = duplicateCheck.dimensions[0].checks[0].id;
        await expect(scoreReleaseEvidence(duplicateCheck, scoringDependencies(manifest()))).rejects.toMatchObject({
            code: "duplicate_id",
        });
    });

    it("rejects manifest-selected atomic check IDs and reweighted tenths", async () => {
        const input = manifest();
        input.dimensions[0].checks = [
            { id: "operator-selected", weightTenths: 99, artifactId: RELEASE_ARTIFACT_CATALOG.student_core.id },
            { id: "token-failure-hidden", weightTenths: 1, artifactId: RELEASE_ARTIFACT_CATALOG.student_core.id },
        ];

        await expect(scoreReleaseEvidence(input, scoringDependencies(manifest()))).rejects.toMatchObject({
            name: "ReleaseQualityError",
        });
    });

    it("rejects manifest-controlled freshness beyond the evidence-class TTL", async () => {
        const input = manifest();
        input.artifacts[0] = artifact("student_core", { freshUntil: "2099-01-01T00:00:00.000Z" });
        refreshArtifact(input, "student_core");

        const result = await scoreReleaseEvidence(input, scoringDependencies(input));

        expect(result.status).toBe("no_go");
        expect(result.evidenceFailures).toContainEqual({
            artifactId: RELEASE_ARTIFACT_CATALOG.student_core.id,
            code: "artifact_ttl_exceeded",
        });
    });

    it("invalidates hosted evidence when its environment identity changes", async () => {
        const input = manifest();
        const hosted = input.artifacts.find((descriptor) => descriptor.kind === "hosted_deployment")!;
        hosted.environmentDigest = "d".repeat(64);
        refreshArtifact(input, "hosted_deployment");

        const result = await scoreReleaseEvidence(input, scoringDependencies(input));

        expect(result.status).toBe("no_go");
        expect(result.evidenceFailures).toContainEqual({
            artifactId: RELEASE_ARTIFACT_CATALOG.hosted_deployment.id,
            code: "artifact_wrong_environment",
        });
    });

    it("does not treat one arbitrary hashed blob as evidence for every catalog kind", async () => {
        const input = manifest();
        for (const descriptor of input.artifacts) {
            descriptor.sha256 = createHash("sha256").update(ARBITRARY_BYTES).digest("hex");
        }
        const raw = Object.fromEntries(RELEASE_DIMENSIONS.map((kind) => [kind, ARBITRARY_BYTES]));

        const result = await scoreReleaseEvidence(input, scoringDependencies(input, raw));

        expect(result.status).toBe("no_go");
        expect(result.minimum).toBe(0);
        expect(result.evidenceFailures).toHaveLength(RELEASE_DIMENSIONS.length);
        expect(result.evidenceFailures.every((failure) => failure.code === "artifact_schema_invalid")).toBe(true);
    });

    it("derives atomic status from the fixed artifact payload rather than manifest claims", async () => {
        const input = manifest();
        const studentEvidence = artifactEvidenceBytes(input, "student_core", {
            checks: {
                [RELEASE_ATOMIC_CHECKS.student_core[1].id]: "failed",
                [RELEASE_ATOMIC_CHECKS.student_core[2].id]: "failed",
            },
        });
        input.artifacts[0].sha256 = createHash("sha256").update(studentEvidence).digest("hex");

        const result = await scoreReleaseEvidence(input, scoringDependencies(input, {
            student_core: studentEvidence,
        }));

        expect(result.dimensions).toMatchObject({ student_core: 8.5 });
        expect(result.status).toBe("no_go");
    });

    it("accepts freshness exactly at the inclusive boundary", async () => {
        const input = manifest();

        await expect(scoreReleaseEvidence(input, scoringDependencies(input))).resolves.toMatchObject({
            status: "go",
            minimum: 10,
        });
    });

    it("does not accept a symlink as a hashed artifact", async () => {
        const fixture = await cliFixture();
        const linkedArtifact = join(fixture.temporary, "linked-artifact.json");
        await symlink(fixture.artifactPaths[0], linkedArtifact, "file");
        fixture.input.artifacts[0] = artifact("student_core", { path: linkedArtifact });

        const result = await scoreReleaseEvidence(fixture.input, {
            now: () => NOW,
            scorerSha: SCORER_SHA,
        });

        expect(result.status).toBe("no_go");
        expect(result.evidenceFailures).toContainEqual({
            artifactId: RELEASE_ARTIFACT_CATALOG.student_core.id,
            code: "artifact_unreadable",
        });
    });

    it("fails closed when an artifact claims to postdate its manifest", async () => {
        const input = manifest();
        input.artifacts[0] = artifact("student_core", {
            generatedAt: "2026-08-09T00:00:00.001Z",
            freshUntil: "2026-08-10T00:00:00.001Z",
        });
        refreshArtifact(input, "student_core");

        const result = await scoreReleaseEvidence(input, scoringDependencies(input));

        expect(result.status).toBe("no_go");
        expect(result.evidenceFailures).toContainEqual({
            artifactId: RELEASE_ARTIFACT_CATALOG.student_core.id,
            code: "artifact_after_manifest",
        });
    });

    it.each([
        ["skipped", "no_go"],
        ["unverified", "go"],
    ])("scores an atomic %s check as zero", async (status, expectedStatus) => {
        const input = manifest();
        setAtomicStatus(input, "student_core", 0, status as EvidenceStatus);

        const result = await scoreReleaseEvidence(input, scoringDependencies(input));

        expect(result.dimensions).toMatchObject({ student_core: 8.7 });
        expect(result.status).toBe(expectedStatus);
    });

    it("treats any otherwise score-tolerable skipped atomic check as an unexplained-skip hard gate", async () => {
        const input = manifest();
        setAtomicStatus(input, "student_core", 2, "skipped");

        const result = await scoreReleaseEvidence(input, scoringDependencies(input));

        expect(result.minimum).toBe(9.3);
        expect(result.hardGateFailures).toContain("unexplained_skips");
        expect(result.status).toBe("no_go");
    });

    it("scores a missing referenced artifact as zero without leaking its path", async () => {
        const input = manifest();
        const dependencies = scoringDependencies(input);
        input.artifacts[0].path = "/private/release/missing-evidence.json";

        const result = await scoreReleaseEvidence(input, dependencies);

        expect(result.dimensions).toMatchObject({ student_core: 0 });
        expect(result.evidenceFailures).toContainEqual({
            artifactId: RELEASE_ARTIFACT_CATALOG.student_core.id,
            code: "artifact_unreadable",
        });
        expect(JSON.stringify(result)).not.toContain(ARTIFACT_PATH);
    });

    it("accepts only the exact equals-form CLI arguments", () => {
        expect(parseReleaseScoreArgs([
            "--manifest=/private/release/manifest.json",
            "--output=/private/release/score.json",
        ])).toEqual({
            manifestPath: "/private/release/manifest.json",
            outputPath: "/private/release/score.json",
        });
        for (const argv of [
            ["--manifest", "/private/release/manifest.json", "--output=/private/release/score.json"],
            ["--manifest=/private/release/manifest.json"],
            ["--manifest=/a", "--manifest=/b", "--output=/c"],
            ["--manifest=/a", "--output=/b", "--unknown=value"],
            ["--output=/b", "--manifest=relative.json"],
        ]) {
            expect(() => parseReleaseScoreArgs(argv)).toThrow();
        }
    });

    it("atomically publishes a 0600 GO score into a canonical 0700 parent", async () => {
        const fixture = await cliFixture();

        const outcome = await runReleaseScoreCli({
            argv: [`--manifest=${fixture.manifestPath}`, `--output=${fixture.outputPath}`],
        }, {
            now: () => NOW,
            scorerSha: SCORER_SHA,
            generateTempName: () => "c".repeat(32),
        });

        expect(outcome).toMatchObject({
            exitCode: 0,
            diagnostic: "verified: release_quality_go",
            result: { status: "go", buildSha: BUILD_SHA, scorerSha: SCORER_SHA },
        });
        const published = await lstat(fixture.outputPath);
        expect(published.mode & 0o777).toBe(0o600);
        expect(JSON.parse(await readFile(fixture.outputPath, "utf8"))).toMatchObject({
            status: "go",
            buildSha: BUILD_SHA,
            scorerSha: SCORER_SHA,
        });
        await expect(lstat(join(fixture.temporary, `.score.json.${"c".repeat(32)}.tmp`))).rejects.toThrow();
    });

    it("publishes NO-GO evidence but returns exit 1", async () => {
        const fixture = await cliFixture({ recovery_release: 85 });

        const outcome = await runReleaseScoreCli({
            argv: [`--manifest=${fixture.manifestPath}`, `--output=${fixture.outputPath}`],
        }, {
            now: () => NOW,
            scorerSha: SCORER_SHA,
            generateTempName: () => "d".repeat(32),
        });

        expect(outcome).toMatchObject({
            exitCode: 1,
            diagnostic: "no_go: release_quality_gate_failed",
            result: { status: "no_go", minimum: 8.5 },
        });
        expect(JSON.parse(await readFile(fixture.outputPath, "utf8"))).toMatchObject({ status: "no_go" });
    });

    it("rejects existing output, unsafe parents, and symlinked parents without publication", async () => {
        const existing = await cliFixture();
        await writeFile(existing.outputPath, "existing", { mode: 0o600, flag: "wx" });
        await expect(runReleaseScoreCli({
            argv: [`--manifest=${existing.manifestPath}`, `--output=${existing.outputPath}`],
        }, { now: () => NOW, scorerSha: SCORER_SHA })).rejects.toMatchObject({ code: "unsafe_output" });
        expect(await readFile(existing.outputPath, "utf8")).toBe("existing");

        const unsafe = await cliFixture();
        await chmod(unsafe.temporary, 0o755);
        await expect(runReleaseScoreCli({
            argv: [`--manifest=${unsafe.manifestPath}`, `--output=${unsafe.outputPath}`],
        }, { now: () => NOW, scorerSha: SCORER_SHA })).rejects.toMatchObject({ code: "unsafe_output" });

        const linked = await cliFixture();
        const linkContainer = await realpath(await mkdtemp(join(tmpdir(), "omr-release-link-")));
        await chmod(linkContainer, 0o700);
        const parentLink = join(linkContainer, "linked-parent");
        await symlink(linked.temporary, parentLink, "dir");
        const linkedOutput = join(parentLink, "score.json");
        await expect(runReleaseScoreCli({
            argv: [`--manifest=${linked.manifestPath}`, `--output=${linkedOutput}`],
        }, { now: () => NOW, scorerSha: SCORER_SHA })).rejects.toMatchObject({ code: "unsafe_output" });
        await expect(lstat(linkedOutput)).rejects.toThrow();
    });

    it("cleans its owned temporary inode when initial output stat fails", async () => {
        const fixture = await cliFixture();

        await expect(runReleaseScoreCli({
            argv: [`--manifest=${fixture.manifestPath}`, `--output=${fixture.outputPath}`],
        }, {
            now: () => NOW,
            scorerSha: SCORER_SHA,
            generateTempName: () => "e".repeat(32),
            fs: {
                open: async (path: string, flags: string | number, mode?: number) => {
                    const handle = await open(path, flags, mode);
                    if (flags !== "wx") return handle;
                    return {
                        chmod: (nextMode: number) => handle.chmod(nextMode),
                        writeFile: (data: string, options: object) => handle.writeFile(data, options),
                        sync: () => handle.sync(),
                        stat: async () => { throw new Error("injected-sensitive-stat-error"); },
                        close: () => handle.close(),
                    };
                },
            },
        })).rejects.toMatchObject({ code: "unsafe_output" });

        await expect(lstat(fixture.outputPath)).rejects.toThrow();
        expect((await readdir(fixture.temporary)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });

    it("fails when its output parent is replaced after publication", async () => {
        const fixture = await cliFixture();
        const movedParent = `${fixture.temporary}-moved`;
        let replaced = false;

        await expect(runReleaseScoreCli({
            argv: [`--manifest=${fixture.manifestPath}`, `--output=${fixture.outputPath}`],
        }, {
            now: () => NOW,
            scorerSha: SCORER_SHA,
            generateTempName: () => "f".repeat(32),
            fs: {
                unlink: async (path: string) => {
                    await unlink(path);
                    if (!path.endsWith(".tmp") || replaced) return;
                    replaced = true;
                    await rename(fixture.temporary, movedParent);
                    await mkdir(fixture.temporary, { mode: 0o700 });
                },
            },
        })).rejects.toMatchObject({ code: "unsafe_output" });

        expect(replaced).toBe(true);
        await expect(lstat(fixture.outputPath)).rejects.toThrow();
    });

    it("fails closed on duplicate JSON keys without publishing or exposing content", async () => {
        const fixture = await cliFixture();
        const duplicateManifest = join(fixture.temporary, "duplicate.json");
        await writeFile(duplicateManifest, `{"schemaVersion":1,"schemaVersion":1,"secret":"do-not-log"}\n`, {
            mode: 0o600,
            flag: "wx",
        });

        await expect(runReleaseScoreCli({
            argv: [`--manifest=${duplicateManifest}`, `--output=${fixture.outputPath}`],
        }, { now: () => NOW, scorerSha: SCORER_SHA })).rejects.toMatchObject({ code: "invalid_manifest" });
        await expect(lstat(fixture.outputPath)).rejects.toThrow();
    });

    it("registers the strict CLI and documents sealed release evidence semantics", () => {
        const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
        const evidenceTemplate = readFileSync(resolve("docs/operations/release-evidence-template.md"), "utf8");

        expect(packageJson.scripts["release:score"]).toBe("node scripts/score-release-quality.mjs");
        expect(evidenceTemplate).toContain("release quality manifest 절대 경로");
        expect(evidenceTemplate).toContain("release quality manifest SHA-256");
        expect(evidenceTemplate).toContain("release quality score 절대 경로");
        expect(evidenceTemplate).toContain("release quality score SHA-256");
        expect(evidenceTemplate).toContain("scorer SHA");
        expect(evidenceTemplate).toContain("`go` / `no_go` / `unverified`");
        expect(evidenceTemplate).toContain("missing, expired, wrong-SHA, skipped, unverified");
        expect(evidenceTemplate).toContain("100개 fixed atomic check");
        expect(evidenceTemplate).toContain("24시간");
        expect(evidenceTemplate).toContain("30일");
        expect(evidenceTemplate).toContain("environmentDigest");
        expect(evidenceTemplate).toContain("hard gate `passed`가 atomic failure를 덮어쓸 수 없습니다");
    });
});
