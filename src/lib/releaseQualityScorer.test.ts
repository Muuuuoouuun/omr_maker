import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, lstat, mkdtemp, open, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
    RELEASE_DIMENSIONS,
    RELEASE_HARD_GATES,
    scoreReleaseEvidence,
} from "../../scripts/release-quality-core.mjs";
import {
    parseReleaseScoreArgs,
    runReleaseScoreCli,
} from "../../scripts/score-release-quality.mjs";

const BUILD_SHA = "a".repeat(40);
const SCORER_SHA = "b".repeat(40);
const NOW = new Date("2026-08-09T00:00:00.000Z");
const ARTIFACT_BYTES = Buffer.from("bounded verified evidence\n", "utf8");
const ARTIFACT_PATH = "/private/release/evidence.json";

function artifact(overrides: Record<string, unknown> = {}) {
    return {
        id: "verified-evidence",
        path: ARTIFACT_PATH,
        sha256: createHash("sha256").update(ARTIFACT_BYTES).digest("hex"),
        generatedAt: "2026-08-08T23:00:00.000Z",
        freshUntil: "2026-08-10T00:00:00.000Z",
        buildSha: BUILD_SHA,
        status: "verified",
        ...overrides,
    };
}

function manifest(scores: Partial<Record<(typeof RELEASE_DIMENSIONS)[number], number>> = {}) {
    return {
        schemaVersion: 1,
        buildSha: BUILD_SHA,
        generatedAt: "2026-08-08T23:30:00.000Z",
        artifacts: [artifact()],
        dimensions: RELEASE_DIMENSIONS.map((id) => {
            const scoreTenths = scores[id] ?? 100;
            return {
                id,
                checks: scoreTenths === 100
                    ? [{ id: `${id}-complete`, weightTenths: 100, status: "passed", artifactId: "verified-evidence" }]
                    : [
                        { id: `${id}-passing`, weightTenths: scoreTenths, status: "passed", artifactId: "verified-evidence" },
                        { id: `${id}-missing`, weightTenths: 100 - scoreTenths, status: "failed", artifactId: "verified-evidence" },
                    ],
            };
        }),
        hardGates: RELEASE_HARD_GATES.map((id) => ({
            id,
            status: "passed",
            artifactId: "verified-evidence",
        })),
    };
}

const scoringDependencies = {
    now: () => NOW,
    scorerSha: SCORER_SHA,
    readArtifact: async (path: string) => {
        if (path !== ARTIFACT_PATH) throw new Error("unexpected artifact");
        return ARTIFACT_BYTES;
    },
};

async function cliFixture(scores: Parameters<typeof manifest>[0] = {}) {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "omr-release-score-")));
    await chmod(temporary, 0o700);
    const artifactPath = join(temporary, "artifact.json");
    const manifestPath = join(temporary, "manifest.json");
    const outputPath = join(temporary, "score.json");
    await writeFile(artifactPath, ARTIFACT_BYTES, { mode: 0o600, flag: "wx" });
    const input = manifest(scores);
    input.artifacts = [artifact({ path: artifactPath })];
    await writeFile(manifestPath, `${JSON.stringify(input)}\n`, { mode: 0o600, flag: "wx" });
    return { temporary, artifactPath, manifestPath, outputPath, input };
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

    it("scores exact tenths and accepts the mean and minimum boundary", async () => {
        const input = manifest({
            student_core: 87,
            teacher_core: 93,
            provisioning_entitlement: 93,
            data_integrity_isolation: 93,
            code_supply_chain: 94,
            browser_determinism: 94,
            ux_accessibility_responsiveness: 94,
            hosted_deployment: 94,
            capacity_observability: 94,
            recovery_release: 94,
        });

        await expect(scoreReleaseEvidence(input, scoringDependencies)).resolves.toMatchObject({
            schemaVersion: 1,
            status: "go",
            buildSha: BUILD_SHA,
            scorerSha: SCORER_SHA,
            mean: 9.3,
            minimum: 8.7,
            dimensions: {
                student_core: 8.7,
                teacher_core: 9.3,
                recovery_release: 9.4,
            },
            hardGateFailures: [],
            evidenceFailures: [],
        });
    });

    it.each([
        ["failed", "core_e2e"],
        ["skipped", "unexplained_skips"],
        ["unverified", "hundred_user_load"],
    ])("forces no_go when hard gate evidence is %s", async (status, gateId) => {
        const input = manifest();
        const gate = input.hardGates.find((candidate) => candidate.id === gateId)!;
        gate.status = status;

        const result = await scoreReleaseEvidence(input, scoringDependencies);

        expect(result.status).toBe("no_go");
        expect(result.hardGateFailures).toContain(gateId);
    });

    it.each([
        ["wrong hash", { sha256: "0".repeat(64) }],
        ["wrong build", { buildSha: "c".repeat(40) }],
        ["expired", { freshUntil: "2026-08-08T23:59:59.999Z" }],
        ["unverified", { status: "unverified" }],
    ])("scores evidence as zero and fails closed when an artifact is %s", async (_label, overrides) => {
        const input = manifest();
        input.artifacts = [artifact(overrides)];

        const result = await scoreReleaseEvidence(input, scoringDependencies);

        expect(result.status).toBe("no_go");
        expect(result.minimum).toBe(0);
        expect(result.evidenceFailures).not.toHaveLength(0);
        expect(result.hardGateFailures).toEqual(RELEASE_HARD_GATES);
    });

    it("rejects an empty artifact even when its declared hash matches", async () => {
        const input = manifest();
        input.artifacts = [artifact({
            sha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
        })];

        const result = await scoreReleaseEvidence(input, {
            ...scoringDependencies,
            readArtifact: async () => Buffer.alloc(0),
        });

        expect(result.status).toBe("no_go");
        expect(result.evidenceFailures).toContainEqual({
            artifactId: "verified-evidence",
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
        await expect(scoreReleaseEvidence(input, scoringDependencies)).rejects.toMatchObject({
            name: "ReleaseQualityError",
        });
    });

    it("rejects symbol-key extensions to an otherwise exact envelope", async () => {
        const input = manifest();
        Object.defineProperty(input, Symbol("hidden"), { value: "not-allowlisted" });

        await expect(scoreReleaseEvidence(input, scoringDependencies)).rejects.toMatchObject({
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

        await expect(scoreReleaseEvidence(input, scoringDependencies)).rejects.toMatchObject({
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
                return artifact();
            },
        });

        await expect(scoreReleaseEvidence(input, scoringDependencies)).rejects.toMatchObject({
            code: "invalid_manifest",
        });
        expect(getterCalls).toBe(0);
    });

    it("rejects huge and sparse bounded arrays", async () => {
        const huge = manifest();
        huge.artifacts = Array.from({ length: 257 }, (_, index) => artifact({ id: `artifact-${index}` }));
        await expect(scoreReleaseEvidence(huge, scoringDependencies)).rejects.toMatchObject({
            code: "invalid_manifest",
        });

        const sparse = manifest();
        sparse.dimensions = new Array(RELEASE_DIMENSIONS.length);
        sparse.dimensions[0] = manifest().dimensions[0];
        await expect(scoreReleaseEvidence(sparse, scoringDependencies)).rejects.toMatchObject({
            code: "invalid_manifest",
        });
    });

    it("rejects duplicate artifact and atomic-check IDs", async () => {
        const duplicateArtifact = manifest();
        duplicateArtifact.artifacts.push(artifact());
        await expect(scoreReleaseEvidence(duplicateArtifact, scoringDependencies)).rejects.toMatchObject({
            code: "duplicate_id",
        });

        const duplicateCheck = manifest();
        duplicateCheck.dimensions[1].checks[0].id = duplicateCheck.dimensions[0].checks[0].id;
        await expect(scoreReleaseEvidence(duplicateCheck, scoringDependencies)).rejects.toMatchObject({
            code: "duplicate_id",
        });
    });

    it("accepts freshness exactly at the inclusive boundary", async () => {
        const input = manifest();
        input.artifacts = [artifact({ freshUntil: NOW.toISOString() })];

        await expect(scoreReleaseEvidence(input, scoringDependencies)).resolves.toMatchObject({
            status: "go",
            minimum: 10,
        });
    });

    it("does not accept a symlink as a hashed artifact", async () => {
        const fixture = await cliFixture();
        const linkedArtifact = join(fixture.temporary, "linked-artifact.json");
        await symlink(fixture.artifactPath, linkedArtifact, "file");
        fixture.input.artifacts = [artifact({ path: linkedArtifact })];

        const result = await scoreReleaseEvidence(fixture.input, {
            now: () => NOW,
            scorerSha: SCORER_SHA,
        });

        expect(result.status).toBe("no_go");
        expect(result.evidenceFailures).toContainEqual({
            artifactId: "verified-evidence",
            code: "artifact_unreadable",
        });
    });

    it("fails closed when an artifact claims to postdate its manifest", async () => {
        const input = manifest();
        input.artifacts = [artifact({ generatedAt: "2026-08-08T23:45:00.000Z" })];

        const result = await scoreReleaseEvidence(input, scoringDependencies);

        expect(result.status).toBe("no_go");
        expect(result.evidenceFailures).toContainEqual({
            artifactId: "verified-evidence",
            code: "artifact_after_manifest",
        });
    });

    it.each(["skipped", "unverified"])("scores an atomic %s check as zero", async (status) => {
        const input = manifest();
        input.dimensions[0].checks[0].status = status;

        const result = await scoreReleaseEvidence(input, scoringDependencies);

        expect(result.dimensions).toMatchObject({ student_core: 0 });
        expect(result.status).toBe("no_go");
    });

    it("treats any otherwise score-tolerable skipped atomic check as an unexplained-skip hard gate", async () => {
        const input = manifest();
        input.dimensions[0].checks = [
            { id: "student-most", weightTenths: 99, status: "passed", artifactId: "verified-evidence" },
            { id: "student-skipped", weightTenths: 1, status: "skipped", artifactId: "verified-evidence" },
        ];

        const result = await scoreReleaseEvidence(input, scoringDependencies);

        expect(result.minimum).toBe(9.9);
        expect(result.hardGateFailures).toContain("unexplained_skips");
        expect(result.status).toBe("no_go");
    });

    it("scores a missing referenced artifact as zero without leaking its path", async () => {
        const input = manifest();
        input.dimensions[0].checks[0].artifactId = "missing-evidence";

        const result = await scoreReleaseEvidence(input, scoringDependencies);

        expect(result.dimensions).toMatchObject({ student_core: 0 });
        expect(result.evidenceFailures).toContainEqual({
            artifactId: "missing-evidence",
            code: "missing_artifact",
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
        const fixture = await cliFixture({ recovery_release: 86 });

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
            result: { status: "no_go", minimum: 8.6 },
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
    });
});
