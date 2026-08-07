import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const livePage = readFileSync(
    join(process.cwd(), "src/app/teacher/live/page.tsx"),
    "utf8",
);

describe("teacher live selected-attempt request fencing", () => {
    it("binds readiness to both the selected exam and the latest request generation", () => {
        expect(livePage).toContain("selectedAttemptRequestGenerationRef");
        expect(livePage).toContain("selectedExamIdRef");
        expect(livePage).toMatch(
            /selectedAttemptDetails\.examId === selectedExamId[\s\S]*selectedAttemptDetails\.requestGeneration === selectedAttemptRequestGenerationRef\.current/,
        );
    });

    it("drops a late response before it can merge attempts or mark details ready", () => {
        const loadStart = livePage.indexOf("const loadSelectedAttemptDetails = useCallback");
        const loadEnd = livePage.indexOf("const refreshFromStorage", loadStart);
        const loader = livePage.slice(loadStart, loadEnd);
        const awaitResponse = loader.indexOf("await Promise.all");
        const generationGuard = loader.indexOf("selectedAttemptRequestGenerationRef.current !== requestGeneration");
        const examGuard = loader.indexOf("selectedExamIdRef.current !== examId");
        const merge = loader.indexOf("mergeTeacherLiveExamAttempts");
        const ready = loader.indexOf('status: "ready"');

        expect(loadStart).toBeGreaterThan(-1);
        expect(awaitResponse).toBeGreaterThan(-1);
        expect(generationGuard).toBeGreaterThan(awaitResponse);
        expect(examGuard).toBeGreaterThan(awaitResponse);
        expect(merge).toBeGreaterThan(generationGuard);
        expect(ready).toBeGreaterThan(merge);
    });

    it("hides answer-derived analytics and force-finish while details are not current", () => {
        expect(livePage).toMatch(/const answerDetailedAttempts = useMemo\([\s\S]*selectedAttemptDetailsReady \|\| isDemoLive \? liveAttempts : \[\]/);
        expect(livePage).toContain("submittedAttempts: answerDetailedAttempts");
        expect(livePage).toContain("disabled={!isDemoLive && !selectedAttemptDetailsReady}");
    });

    it("schedules the next selected-exam poll only after the current request settles", () => {
        const pollStart = livePage.indexOf("// Poll only the selected exam every 3s");
        const pollEnd = livePage.indexOf("const selectedExam =", pollStart);
        const pollEffect = livePage.slice(pollStart, pollEnd);
        const awaitRefresh = pollEffect.indexOf("await refreshSelectedAttempts()");
        const scheduleNext = pollEffect.indexOf("setTimeout(poll, 3000)", awaitRefresh);

        expect(pollStart).toBeGreaterThan(-1);
        expect(awaitRefresh).toBeGreaterThan(-1);
        expect(scheduleNext).toBeGreaterThan(awaitRefresh);
        expect(pollEffect).not.toContain("setInterval");
    });

    it("keeps current rich rows ready while a background refresh is pending", () => {
        expect(livePage).toContain('status: isBackgroundRefresh ? "refreshing" : "loading"');
        expect(livePage).toMatch(
            /\(selectedAttemptDetails\.status === "ready" \|\| selectedAttemptDetails\.status === "refreshing"\)/,
        );
    });
});
