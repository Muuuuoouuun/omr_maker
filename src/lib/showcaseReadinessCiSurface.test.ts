import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8");
const helpers = () => readFileSync(join(process.cwd(), "e2e/helpers.ts"), "utf8");

type Measurement = {
    phase: string;
    project: string;
    scenario: string;
    repeatEachIndex: number;
    retry: number;
    report: { version: number; outcome: string; events: unknown[] };
};

function measurements(scenarios = ["live-pause"], project = "ios-se-webkit"): Measurement[] {
    return scenarios.flatMap(scenario => Array.from({ length: 5 }, (_, repeatEachIndex) => ({
        phase: "repeat", project, scenario, repeatEachIndex, retry: 0,
        report: { version: 1, outcome: "passed", events: [] },
    })));
}

function verifyMeasurements(records: Measurement[], shard = "1") {
    const marker = 'node - "${{ matrix.shard }}" <<\'NODE\'';
    const script = workflow.split(marker)[1].split("\n          NODE")[0]
        .split("\n").map(line => line.replace(/^ {10}/, "")).join("\n");
    const directory = mkdtempSync(join(tmpdir(), "omr-showcase-measurements-"));
    try {
        const output = join(directory, "showcase-entry-diagnostics");
        mkdirSync(output);
        records.forEach((record, index) => writeFileSync(join(output, `${index}.json`), JSON.stringify(record)));
        return spawnSync(process.execPath, ["-", shard], {
            input: script, cwd: directory, encoding: "utf8", env: { NODE_ENV: "test" }, timeout: 5_000,
        });
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

describe("showcase readiness CI regression coverage", () => {
    it("repeats all four prior failures on their original WebKit project", () => {
        expect(workflow).toContain("project=ios-se-webkit");
        expect(workflow).toContain("teacher live pause stops data refresh without freezing or resuming a stale countdown");
        expect(workflow).toContain("project=tablet-ios-webkit-teacher");
        expect(workflow).toContain("connects dashboard metrics to the next analysis action|progressively reveals showcase exam results on a 390px phone");
        expect(workflow).toContain("project=tablet-ios-webkit-landscape-teacher");
        expect(workflow).toContain("keeps mobile roster search and detail actions clear of data-source toasts");
    });

    it("adds five repetitions without retries, timeout expansion, or raw traces", () => {
        expect(workflow).toContain("--repeat-each=5 --retries=0 --trace=off");
        const repeat = workflow.split("- name: Repeat previous showcase readiness failures without retries")[1]
            .split("- name: Upload sanitized showcase entry diagnostics")[0];
        expect(repeat).not.toMatch(/--(?:timeout|workers|max-failures)=/);
    });

    it("uploads only the allowlisted JSON directory even after a recovered failure", () => {
        const upload = workflow.split("- name: Upload sanitized showcase entry diagnostics")[1]
            .split("\n  build:")[0];
        expect(upload).toContain("if: ${{ !cancelled() }}");
        expect(upload).toContain("path: showcase-entry-diagnostics/*.json");
        expect(upload).not.toContain("test-results/");
        expect(upload).not.toContain("playwright-report/");
    });

    it("preserves workflow permissions and the existing full iOS suite", () => {
        expect(workflow).toContain("permissions:\n  contents: read");
        expect(workflow).toContain("run: npm run test:e2e:ios-webkit -- --shard=${{ matrix.shard }}/3");
        expect(workflow).not.toContain("actions: write");
    });

    it("separates full-suite records from repeated cases without filename collisions", () => {
        expect(workflow).toContain('OMR_SHOWCASE_ENTRY_PHASE: "suite"');
        expect(workflow).toContain('OMR_SHOWCASE_ENTRY_PHASE: "repeat"');
        expect(helpers()).toContain('process.env.OMR_SHOWCASE_ENTRY_PHASE === "repeat" ? "repeat" : "suite"');
        expect(helpers()).toContain('`${phase}-${testKey}-${info.repeatEachIndex}-${info.retry}-${showcaseDiagnosticSequence++}.json`');
        expect(workflow).toContain("- name: Verify all five attempts of each prior failure were measured");
        expect(workflow).toContain("assert.equal(records.length, 5 * expected.scenarios.length");
        expect(workflow).toContain("record.repeatEachIndex === repeat && record.retry === 0");
        expect(workflow).toContain("assert.equal(attempts.length, 1");
    });

    it("preserves readiness assertions and enables observation only explicitly", () => {
        const helper = helpers();
        expect(helper).toContain('process.env.OMR_SHOWCASE_ENTRY_DIAGNOSTICS === "1"');
        expect(helper).toContain("{ timeout: 25_000 }");
        expect(helper).toContain('=== "webkit" ? 45_000 : 30_000');
        expect(helper).toContain('name: "데모 계정 대시보드 개요"');
        expect(helper).toContain('await page.waitForLoadState("networkidle")');
    });

    it("keeps teacher auth-dialog credentials in the active runtime fixture, not literal fill arguments", () => {
        const ios = readFileSync(join(process.cwd(), "e2e/ios-mobile-layout.spec.ts"), "utf8");
        expect(ios).toContain("const { identifier, password } = teacherLoginFixture();");
        const credentialFields = ios.split("\n").filter(line => line.includes("await authDialog.getByPlaceholder("));
        expect(credentialFields).toHaveLength(2);
        expect(credentialFields[0]).toContain(".fill(identifier)");
        expect(credentialFields[1]).toContain(".fill(password)");
        for (const field of credentialFields) expect(field).not.toMatch(/\.fill\(["']/);
    });

    it("validates all five cases per scenario and excludes full-suite observations", () => {
        for (const [shard, scenarios, project] of [
            ["1", ["live-pause"], "ios-se-webkit"],
            ["2", ["metrics-next-action", "progressive-results"], "tablet-ios-webkit-teacher"],
            ["3", ["roster-toast"], "tablet-ios-webkit-landscape-teacher"],
        ] as const) {
            const records = measurements([...scenarios], project);
            const result = verifyMeasurements([...records, { ...records[0], phase: "suite" }], shard);
            expect(result.status).toBe(0);
            expect(JSON.parse(result.stdout)).toEqual({ measuredAttempts: 5 * scenarios.length, retries: 0 });
        }
    });

    it("fails when a measured attempt is missing or duplicated", () => {
        const records = measurements();
        expect(verifyMeasurements(records.slice(1)).status).not.toBe(0);
        expect(verifyMeasurements([records[0], ...records.slice(0, 4)]).status).not.toBe(0);
    });

    it("rejects retried, wrong-project, and out-of-range repeat metadata", () => {
        const records = measurements();
        for (const change of [{ retry: 1 }, { project: "other" }, { repeatEachIndex: 5 }]) {
            expect(verifyMeasurements([{ ...records[0], ...change }, ...records.slice(1)]).status).not.toBe(0);
        }
    });

    it("keeps failed readiness observations while rejecting incomplete diagnostic payloads", () => {
        const records = measurements();
        records[0].report.outcome = "failed";
        expect(verifyMeasurements(records).status).toBe(0);
        records[0].report.version = 0;
        expect(verifyMeasurements(records).status).not.toBe(0);
    });
});
