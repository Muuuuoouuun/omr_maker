import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
    resolve(process.cwd(), "src/components/dashboard/tabs/ExamAnalyticsTab.tsx"),
    "utf8",
);

describe("exam analytics original-question recovery copy", () => {
    it("describes the same exam's missed questions without promising new similar questions", () => {
        const recoveryCopy = source.match(/actionCopy: weakConcept\s*\?\s*(`[^`]+`)/)?.[1];
        expect(recoveryCopy).toBe('`${weakConcept.concept} 보강 후 ${weakConcept.questionNumbers.slice(0, 4).join(", ")}번 관련 오답 재응시`');
    });

    it("keeps canonical retake links gated by exact submitted question cohorts", () => {
        expect(source).toContain("exactTeacherCanonicalWrongRetakeCohorts(canonicalSnapshot, sourceAttemptId, questionIds)");
        expect(source).toContain("if (requiresCanonicalSnapshot && !cohortKeys) return null;");
        expect(source).toContain("return buildRetakeHref(selectedExam.id, sourceAttemptId, questionIds, mode, {");
        expect(source).toContain("...(cohortKeys ? { cohortKeys } : {})");
    });
});
