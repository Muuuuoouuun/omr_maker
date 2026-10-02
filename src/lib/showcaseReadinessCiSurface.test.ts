import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8");
const helpers = () => readFileSync(join(process.cwd(), "e2e/helpers.ts"), "utf8");

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

    it("preserves readiness assertions and enables observation only explicitly", () => {
        const helper = helpers();
        expect(helper).toContain('process.env.OMR_SHOWCASE_ENTRY_DIAGNOSTICS === "1"');
        expect(helper).toContain("{ timeout: 25_000 }");
        expect(helper).toContain('=== "webkit" ? 45_000 : 30_000');
        expect(helper).toContain('name: "데모 계정 대시보드 개요"');
        expect(helper).toContain('await page.waitForLoadState("networkidle")');
    });
});
