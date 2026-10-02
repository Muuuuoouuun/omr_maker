import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("initial capacity UX", () => {
    it("keeps the stable code through the student history client", () => {
        const client = source("src/lib/studentAttemptClient.ts");
        const history = source("src/app/student/history/page.tsx");
        expect(client).toContain("INITIAL_CAPACITY_EXCEEDED_ERROR");
        expect(history).toContain('remoteError === INITIAL_CAPACITY_EXCEEDED_ERROR');
        expect(history).toContain("INITIAL_CAPACITY_REMEDIATION_KO");
    });

    it("uses truthful catalog-or-history remediation in student and teacher list consumers", () => {
        const policy = source("src/lib/initialOperationsPolicy.ts");
        const dashboard = source("src/app/student/dashboard/page.tsx");
        const users = source("src/app/teacher/users/page.tsx");
        expect(policy).toContain("시험 목록 또는 응시 기록");
        expect(dashboard).toContain("INITIAL_CAPACITY_REMEDIATION_KO");
        expect(users).toContain("INITIAL_CAPACITY_REMEDIATION_KO");
        expect(users).toContain("INITIAL_CAPACITY_EXCEEDED_ERROR");
    });
});
