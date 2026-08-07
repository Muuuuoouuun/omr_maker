import { describe, expect, it } from "vitest";
import { classifyTeacherLiveExamPhase } from "./teacherLiveExamState";
import * as teacherLiveExamState from "./teacherLiveExamState";

describe("teacher live exam state", () => {
    it("provides a lifecycle classifier for the live monitor", async () => {
        const modulePath = "./teacherLiveExamState";
        const liveState = await import(modulePath).catch(() => ({}));

        expect(liveState).toHaveProperty("classifyTeacherLiveExamPhase");
        expect((liveState as { classifyTeacherLiveExamPhase?: unknown }).classifyTeacherLiveExamPhase)
            .toBeTypeOf("function");
    });

    it("provides presentation and initial-selection helpers", () => {
        expect(teacherLiveExamState).toHaveProperty("teacherLiveExamPresentation");
        expect(teacherLiveExamState).toHaveProperty("selectTeacherLiveExamId");
        expect(teacherLiveExamState).toHaveProperty("mergeTeacherLiveExamAttempts");
    });

    it("replaces only the polled exam while preserving other exam attempt state", () => {
        const existing = [
            { id: "a-old", examId: "exam-a", status: "in_progress" as const },
            { id: "b-live", examId: "exam-b", status: "in_progress" as const },
        ];
        const refreshed = [
            { id: "a-new", examId: "exam-a", status: "completed" as const },
        ];

        expect(teacherLiveExamState.mergeTeacherLiveExamAttempts(existing, "exam-a", refreshed))
            .toEqual([existing[1], refreshed[0]]);
    });

    it("keeps cached attempts when the selected-exam refresh fails", () => {
        const existing = [
            { id: "a-live", examId: "exam-a", status: "in_progress" as const },
            { id: "b-live", examId: "exam-b", status: "in_progress" as const },
        ];

        expect(teacherLiveExamState.mergeTeacherLiveExamAttempts(existing, "exam-a", [], true))
            .toEqual(existing);
    });

    const now = Date.parse("2026-08-05T09:00:00.000Z");

    it("marks only an open schedule or an in-progress attempt as live", () => {
        expect(classifyTeacherLiveExamPhase({
            startAt: "2026-08-05T08:00:00.000Z",
            endAt: "2026-08-05T10:00:00.000Z",
        }, [], now)).toBe("live");
        expect(classifyTeacherLiveExamPhase({}, [{ status: "in_progress" }], now)).toBe("live");
        expect(classifyTeacherLiveExamPhase({}, [], now)).toBe("ready");
    });

    it("keeps future and ended exams out of the live state", () => {
        expect(classifyTeacherLiveExamPhase({
            startAt: "2026-08-05T10:00:00.000Z",
            endAt: "2026-08-05T11:00:00.000Z",
        }, [{ status: "in_progress" }], now)).toBe("scheduled");
        expect(classifyTeacherLiveExamPhase({
            startAt: "2026-08-05T07:00:00.000Z",
            endAt: "2026-08-05T08:00:00.000Z",
        }, [{ status: "in_progress" }], now)).toBe("completed");
        expect(classifyTeacherLiveExamPhase({ archived: true }, [{ status: "in_progress" }], now))
            .toBe("completed");
    });

    it("uses distinct, factual presentation copy for live, ready, completed, and demo states", () => {
        expect(teacherLiveExamState.teacherLiveExamPresentation("live")).toEqual({
            label: "LIVE · 실시간 갱신",
            description: "제출과 문항 결과를 3초마다 갱신합니다.",
            tone: "primary",
        });
        expect(teacherLiveExamState.teacherLiveExamPresentation("scheduled")).toMatchObject({
            label: "준비 · 시작 전",
            tone: "primary",
        });
        expect(teacherLiveExamState.teacherLiveExamPresentation("ready")).toMatchObject({
            label: "준비 · 응시 대기",
            tone: "muted",
        });
        expect(teacherLiveExamState.teacherLiveExamPresentation("completed")).toMatchObject({
            label: "완료 · 종료됨",
            tone: "success",
        });
        expect(teacherLiveExamState.teacherLiveExamPresentation("ready", true)).toEqual({
            label: "DEMO · 합성 데이터",
            description: "합성 응시 데이터이며 실제 학생 상태가 아닙니다.",
            tone: "muted",
        });
    });

    it("selects a live exam first while preserving a teacher's valid selection", () => {
        const exams = [
            { id: "ended", endAt: "2026-08-05T08:00:00.000Z" },
            { id: "scheduled", startAt: "2026-08-05T10:00:00.000Z" },
            { id: "live", startAt: "2026-08-05T08:00:00.000Z", endAt: "2026-08-05T10:00:00.000Z" },
            { id: "ready" },
        ];
        const attempts = [{ examId: "ready", status: "completed" as const }];

        expect(teacherLiveExamState.selectTeacherLiveExamId(exams, attempts, "", now)).toBe("live");
        expect(teacherLiveExamState.selectTeacherLiveExamId(exams, attempts, "scheduled", now))
            .toBe("scheduled");
    });
});
