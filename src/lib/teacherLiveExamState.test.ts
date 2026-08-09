import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

    it("uses every student in the assigned roster groups as the live participation denominator", () => {
        const selectAssigned = (teacherLiveExamState as Record<string, unknown>)
            .selectTeacherLiveAssignedRosterStudents;
        expect(selectAssigned).toBeTypeOf("function");
        if (typeof selectAssigned !== "function") return;

        const groups = [
            { id: "group-a", name: "A반", count: 2, avgScore: 0, color: "#111" },
            { id: "group-b", name: "B반", count: 1, avgScore: 0, color: "#222" },
        ];
        const students = [
            { id: "student-1", name: "민준", email: "", group: "A반", avatar: "#111", avgScore: 0, examsTaken: 0, lastActive: "", trend: "flat", status: "active" },
            { id: "student-2", name: "서연", email: "", group: "A반", avatar: "#222", avgScore: 0, examsTaken: 0, lastActive: "", trend: "flat", status: "active" },
            { id: "student-3", name: "도윤", email: "", group: "B반", avatar: "#333", avgScore: 0, examsTaken: 0, lastActive: "", trend: "flat", status: "active" },
        ] as const;

        const assignedById = selectAssigned({ accessConfig: { type: "group", groupIds: ["group-a"] } }, students, groups);
        const assignedByName = selectAssigned({ accessConfig: { type: "group", groupIds: ["A반"] } }, students, groups);
        expect(assignedById.map((student: { id: string }) => student.id)).toEqual(["student-1", "student-2"]);
        expect(assignedByName.map((student: { id: string }) => student.id)).toEqual(["student-1", "student-2"]);

        const page = readFileSync(join(process.cwd(), "src/app/teacher/live/page.tsx"), "utf8");
        expect(page).toContain("loadTeacherRosterSnapshot");
        expect(page).toContain("assignedRosterStudents");
        expect(page).toContain("attemptMatchesStudentProfile");
    });

    it("distinguishes a failed live catalog read from a successful empty catalog and exposes retry", () => {
        const hasRemoteError = (teacherLiveExamState as Record<string, unknown>)
            .teacherLiveCatalogHasRemoteError;
        expect(hasRemoteError).toBeTypeOf("function");
        if (typeof hasRemoteError !== "function") return;

        expect(hasRemoteError({ items: [], remoteError: "offline" }, { items: [] })).toBe(true);
        expect(hasRemoteError({ items: [] }, { items: [] })).toBe(false);

        const page = readFileSync(join(process.cwd(), "src/app/teacher/live/page.tsx"), "utf8");
        expect(page).toContain('type LiveCatalogLoadStatus = "loading" | "ready" | "failed"');
        expect(page).toContain('data-testid="teacher-live-catalog-error"');
        expect(page).toContain("시험과 응시 현황을 서버에서 불러오지 못했습니다.");
        expect(page).toContain("setCatalogLoadRequest(request => request + 1)");
        expect(page).toContain("다시 시도");
    });

    it("lets an exact mockup session reach deterministic demo readiness without remote catalog authority", () => {
        const shouldFail = (teacherLiveExamState as Record<string, unknown>)
            .teacherLiveCatalogShouldFail;
        expect(shouldFail).toBeTypeOf("function");
        if (typeof shouldFail !== "function") return;

        const failed = { items: [], remoteError: "offline" };
        const empty = { items: [] };
        expect(shouldFail(false, failed, empty, empty)).toBe(true);
        expect(shouldFail(true, failed, failed, failed)).toBe(false);
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
