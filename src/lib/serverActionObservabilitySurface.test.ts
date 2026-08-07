import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("core server action observability surface", () => {
    it.each([
        ["src/app/actions/studentAttempt.ts", "student-exam-open"],
        ["src/app/actions/studentAttempt.ts", "student-submit"],
        ["src/app/actions/teacherExam.ts", "teacher-exam-save"],
        ["src/app/actions/teacherRoster.ts", "teacher-roster-save"],
        ["src/app/actions/feedback.ts", "feedback-save"],
        ["src/app/actions/feedback.ts", "feedback-return"],
        ["src/app/actions/feedback.ts", "feedback-read"],
        ["src/app/actions/teacherExam.ts", "teacher-exam-read"],
        ["src/app/actions/teacherRoster.ts", "teacher-roster-read"],
    ])("reports thrown failures from %s through %s", (path, context) => {
        const action = source(path);
        expect(action).toContain('import { reportServerError } from "@/lib/reportServerError"');
        expect(action).toContain(`await reportServerError("${context}", error)`);
    });

    it("never passes an action payload into the operational reporter", () => {
        const actionSources = [
            "src/app/actions/studentAttempt.ts",
            "src/app/actions/teacherExam.ts",
            "src/app/actions/teacherRoster.ts",
            "src/app/actions/feedback.ts",
        ].map(source).join("\n");
        expect(actionSources).not.toMatch(
            /reportServerError\([^,]+,\s*(?:exam|submission|snapshot|feedback)\s*\)/,
        );
        expect(actionSources).not.toContain("error instanceof Error ? error.message");
    });
});
