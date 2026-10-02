import { describe, expect, it } from "vitest";

import * as browserProofCore from "../../scripts/browser-release-proof-core.mjs";
import { QUALIFICATION_BROWSER_PROOFS } from "../../scripts/build-initial-operations-qualification.mjs";

type BrowserKind = "chromium" | "webkit";
type ResultStatus = "passed" | "failed" | "skipped" | "timedOut" | "interrupted";
type ProofCatalogEntry = { id: string; browser: BrowserKind; file: string; title: string };
type ReportInput = Record<string, unknown> | Uint8Array;
type ProofInput = { chromiumReports: ReportInput[]; webkitReports: ReportInput[] };
const {
    BROWSER_RELEASE_PROOF_CATALOG,
    BROWSER_RELEASE_PROOF_IDS,
    HOSTED_BROWSER_RELEASE_PROOF_IDS,
    BrowserReleaseProofError,
    deriveBrowserReleaseProofs,
    deriveHostedBrowserReleaseProofs,
} = browserProofCore as typeof browserProofCore & Record<string, unknown>;
const PROOF_CATALOG = BROWSER_RELEASE_PROOF_CATALOG as readonly ProofCatalogEntry[];
const PROOF_IDS = BROWSER_RELEASE_PROOF_IDS as readonly string[];
const HOSTED_PROOF_ID = "provisioning_entitlement_one_time_csv";

function report(browser: BrowserKind, mutate?: (value: Record<string, unknown>) => void) {
    const owners = new Map<string, {
        file: string;
        title: string;
        proofIds: string[];
    }>();
    for (const entry of PROOF_CATALOG.filter((candidate) => candidate.browser === browser)) {
        const key = `${entry.file}\0${entry.title}`;
        const owner = owners.get(key) ?? { file: entry.file, title: entry.title, proofIds: [] as string[] };
        owner.proofIds.push(entry.id);
        owners.set(key, owner);
    }
    const byFile = new Map<string, Array<ReturnType<typeof specForOwner>>>();
    for (const owner of owners.values()) {
        const reportFile = owner.file.replace(/^e2e\//, "");
        const specs = byFile.get(reportFile) ?? [];
        specs.push(specForOwner(reportFile, owner.title, owner.proofIds, browser));
        byFile.set(reportFile, specs);
    }
    const value: Record<string, unknown> = {
        config: {
            workers: 1,
            projects: [{
                id: browser === "chromium" ? "chromium" : "ios-standard-webkit",
                name: browser === "chromium" ? "chromium" : "ios-standard-webkit",
                retries: 0,
            }],
        },
        suites: [...byFile].map(([file, specs]) => ({
            title: file,
            file,
            column: 0,
            line: 0,
            specs,
            suites: [],
        })),
        errors: [],
        stats: { expected: owners.size, skipped: 0, unexpected: 0, flaky: 0 },
    };
    mutate?.(value);
    return value;
}

function specForOwner(file: string, title: string, proofIds: string[], browser: BrowserKind) {
    return {
        title,
        ok: true,
        tags: [],
        tests: [{
            timeout: 30_000,
            annotations: proofIds.map((description) => ({ type: "release-proof", description })),
            expectedStatus: "passed",
            projectId: browser === "chromium" ? "chromium" : "ios-standard-webkit",
            projectName: browser === "chromium" ? "chromium" : "ios-standard-webkit",
            results: [result("passed")],
            status: "expected",
        }],
        id: `${browser}-${file}-${title}`,
        file,
        line: 1,
        column: 1,
    };
}

function result(status: ResultStatus) {
    return {
        workerIndex: 0,
        parallelIndex: 0,
        status,
        duration: 1,
        error: undefined,
        errors: [],
        stdout: [],
        stderr: [],
        retry: 0,
        startTime: "2026-08-10T00:00:00.000Z",
        annotations: [],
        attachments: [],
        errorLocation: undefined,
    };
}

function hostedReport(status: ResultStatus = "passed", annotation = HOSTED_PROOF_ID) {
    const title = "hosted provision, CSV login, rotation, and old credential rejection";
    const hostedSpec = specForOwner(
        "student-credential-batch.spec.ts",
        title,
        [annotation],
        "chromium",
    );
    hostedSpec.tests[0].projectId = "student-credential-chromium";
    hostedSpec.tests[0].projectName = "student-credential-chromium";
    return {
        config: {
            workers: 1,
            projects: [{
                id: "student-credential-chromium",
                name: "student-credential-chromium",
                retries: 0,
            }],
        },
        suites: [{
            title: "student-credential-batch.spec.ts",
            file: "student-credential-batch.spec.ts",
            column: 0,
            line: 0,
            specs: [hostedSpec],
            suites: [],
        }],
        errors: [],
        stats: { expected: status === "passed" ? 1 : 0, skipped: 0, unexpected: status === "passed" ? 0 : 1, flaky: 0 },
    } as Record<string, unknown>;
}

function input(chromium = report("chromium"), webkit = report("webkit")): ProofInput {
    return {
        chromiumReports: Array.from({ length: 10 }, () => structuredClone(chromium)),
        webkitReports: [webkit],
    };
}

function allSpecs(value: Record<string, unknown>): Array<Record<string, unknown>> {
    return (value.suites as Array<Record<string, unknown>>)
        .flatMap((suite) => suite.specs as Array<Record<string, unknown>>);
}

function proofTest(value: Record<string, unknown>, proofId: string): Record<string, unknown> {
    const spec = allSpecs(value).find((candidate) => (
        (candidate.tests as Array<{ annotations: Array<{ description: string }> }>)[0]
            .annotations.some(({ description }) => description === proofId)
    ));
    expect(spec, `missing fixture proof ${proofId}`).toBeDefined();
    return (spec!.tests as Array<Record<string, unknown>>)[0];
}

describe("browser release proof core", () => {
    it("keeps the immutable expected IDs exactly aligned with qualification browser proofs", () => {
        expect(BROWSER_RELEASE_PROOF_IDS).toEqual(QUALIFICATION_BROWSER_PROOFS);
        expect(new Set(PROOF_IDS).size).toBe(PROOF_IDS.length);
        expect(PROOF_CATALOG.map(({ id }) => id)).toEqual(PROOF_IDS);
    });

    it("binds teacher feedback and live-monitor proofs to complete behavioral owners", () => {
        expect(PROOF_CATALOG.find(({ id }) => id === "teacher_core_results_feedback")).toMatchObject({
            file: "e2e/teacher-pages.spec.ts",
            title: "returns plain-text feedback through the teacher result flow and shows it in student review",
        });
        expect(PROOF_CATALOG.find(({ id }) => id === "teacher_core_live_monitor")).toMatchObject({
            file: "e2e/teacher-pages.spec.ts",
            title: "renders concrete live values, student grid, heatmap, and a countdown while controlling refresh",
        });
    });

    it("derives the one-time CSV proof only from its exact hosted credential owner", () => {
        expect(HOSTED_BROWSER_RELEASE_PROOF_IDS).toEqual([HOSTED_PROOF_ID]);
        expect(deriveHostedBrowserReleaseProofs({ hostedReports: [hostedReport()] }))
            .toEqual([HOSTED_PROOF_ID]);
    });

    it("rejects generic green, wrong-owner, unknown, and failed hosted credential reports", () => {
        const noAnnotation = hostedReport("passed", "student_core_identity_entry");
        const wrongOwner = hostedReport();
        ((wrongOwner.suites as Array<{ specs: Array<Record<string, unknown>> }>)[0].specs[0]).title =
            "random passing test";
        const failed = hostedReport("failed");
        const failedTest = ((failed.suites as Array<{ specs: Array<{ tests: Array<Record<string, unknown>> }> }>)[0]
            .specs[0].tests[0]);
        failedTest.status = "unexpected";
        failedTest.results = [result("failed")];
        for (const report of [noAnnotation, wrongOwner, failed]) {
            expect(() => deriveHostedBrowserReleaseProofs({ hostedReports: [report] }))
                .toThrow(BrowserReleaseProofError);
        }
    });

    it("rejects a generic all-green report with no release-proof annotations", () => {
        const chromium = report("chromium");
        for (const spec of allSpecs(chromium)) {
            (spec.tests as Array<{ annotations: unknown[] }>)[0].annotations = [];
        }
        expect(() => deriveBrowserReleaseProofs(input(chromium))).toThrow(BrowserReleaseProofError);
    });

    it("rejects a report missing one expected proof", () => {
        const chromium = report("chromium");
        const test = proofTest(chromium, "student_core_exact_submit") as {
            annotations: Array<{ type: string; description: string }>;
        };
        test.annotations = test.annotations.filter(({ description }) => description !== "student_core_exact_submit");
        expect(() => deriveBrowserReleaseProofs(input(chromium))).toThrow(BrowserReleaseProofError);
    });

    it.each([
        ["skipped", "skipped", "skipped"],
        ["flaky", "flaky", "passed"],
        ["failed", "unexpected", "failed"],
    ] as const)("rejects a %s proof occurrence", (_name, testStatus, resultStatus) => {
        const chromium = report("chromium");
        const test = proofTest(chromium, "student_core_exact_submit") as {
            status: string;
            results: Array<Record<string, unknown>>;
        };
        test.status = testStatus;
        test.results = resultStatus === "passed"
            ? [result("failed"), { ...result("passed"), retry: 1 }]
            : [result(resultStatus)];
        expect(() => deriveBrowserReleaseProofs(input(chromium))).toThrow(BrowserReleaseProofError);
    });

    it("rejects an unknown proof annotation", () => {
        const chromium = report("chromium");
        const test = proofTest(chromium, "student_core_exact_submit") as {
            annotations: Array<{ type: string; description: string }>;
        };
        test.annotations.push({ type: "release-proof", description: "student_core_invented" });
        expect(() => deriveBrowserReleaseProofs(input(chromium))).toThrow(BrowserReleaseProofError);
    });

    it.each(["file", "title"] as const)("rejects a proof claimed by the wrong %s owner", (field) => {
        const chromium = report("chromium");
        const spec = allSpecs(chromium).find((candidate) => (
            (candidate.tests as Array<{ annotations: Array<{ description: string }> }>)[0]
                .annotations.some(({ description }) => description === "student_core_exact_submit")
        ))!;
        spec[field] = field === "file" ? "random-passing.spec.ts" : "random passing test";
        expect(() => deriveBrowserReleaseProofs(input(chromium))).toThrow(BrowserReleaseProofError);
    });

    it("rejects conflicting duplicate ownership", () => {
        const chromium = report("chromium");
        const source = allSpecs(chromium).find((candidate) => (
            (candidate.tests as Array<{ annotations: Array<{ description: string }> }>)[0]
                .annotations.some(({ description }) => description === "student_core_exact_submit")
        ))!;
        const duplicate = structuredClone(source) as Record<string, unknown>;
        duplicate.title = "random passing test";
        (chromium.suites as Array<{ specs: Array<Record<string, unknown>> }>)[0].specs.push(duplicate);
        expect(() => deriveBrowserReleaseProofs(input(chromium))).toThrow(BrowserReleaseProofError);
    });

    it("accepts exact same-owner proof occurrences across ten Chromium reports and report bytes", () => {
        const reports = input();
        reports.chromiumReports = reports.chromiumReports.map((value) => Buffer.from(JSON.stringify(value)));
        reports.webkitReports = reports.webkitReports.map((value) => new TextEncoder().encode(JSON.stringify(value)));
        expect(deriveBrowserReleaseProofs(reports)).toEqual(BROWSER_RELEASE_PROOF_IDS);
    });

    it("rejects getters, non-plain prototypes, sparse arrays, and oversized report fan-out", () => {
        const getter = input();
        Object.defineProperty(getter.chromiumReports[0] as Record<string, unknown>, "suites", {
            enumerable: true,
            get: () => [],
        });
        const prototype = input();
        Object.setPrototypeOf(prototype.webkitReports[0] as Record<string, unknown>, { inherited: true });
        const sparse = input();
        sparse.chromiumReports.length = 11;
        const oversized = input();
        oversized.webkitReports = Array.from({ length: 17 }, () => report("webkit"));
        for (const value of [getter, prototype, sparse, oversized]) {
            expect(() => deriveBrowserReleaseProofs(value)).toThrow(BrowserReleaseProofError);
        }
    });
});
