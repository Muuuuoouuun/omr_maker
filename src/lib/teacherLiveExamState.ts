import type { Attempt, Exam } from "@/types/omr";
import { rosterGroupMatchesStudent, type RosterGroup, type RosterStudent } from "@/lib/rosterStorage";

export type TeacherLiveExamPhase = "live" | "scheduled" | "ready" | "completed";

export interface TeacherLiveExamPresentation {
    label: string;
    description: string;
    tone: "primary" | "warning" | "success" | "muted";
}

export function mergeTeacherLiveExamAttempts<
    TExisting extends Pick<Attempt, "examId">,
    TRefreshed extends Pick<Attempt, "examId">,
>(
    existing: ReadonlyArray<TExisting>,
    examId: string,
    refreshed: ReadonlyArray<TRefreshed>,
    refreshFailed = false,
): Array<TExisting | TRefreshed> {
    if (refreshFailed) return [...existing];
    return [
        ...existing.filter(attempt => attempt.examId !== examId),
        ...refreshed,
    ];
}

export function selectTeacherLiveAssignedRosterStudents(
    exam: Pick<Exam, "accessConfig">,
    students: ReadonlyArray<RosterStudent>,
    groups: ReadonlyArray<RosterGroup>,
): RosterStudent[] {
    if (exam.accessConfig?.type !== "group") return [];
    const selectedKeys = new Set(
        (exam.accessConfig.groupIds || []).map(key => key.trim()).filter(Boolean),
    );
    if (selectedKeys.size === 0) return [];

    const selectedGroups = groups.filter(group => (
        selectedKeys.has(group.id.trim()) || selectedKeys.has(group.name.trim())
    ));
    return students.filter(student => {
        if (selectedGroups.some(group => rosterGroupMatchesStudent(group, student))) return true;
        const scopedGroup = student.id.includes("::") ? student.id.split("::")[0]?.trim() : "";
        return selectedKeys.has(student.group.trim()) || (!!scopedGroup && selectedKeys.has(scopedGroup));
    });
}

export function teacherLiveCatalogHasRemoteError(
    ...results: ReadonlyArray<{ remoteError?: string }>
): boolean {
    return results.some(result => !!result.remoteError);
}

export function teacherLiveCatalogShouldFail(
    allowExactDemo: boolean,
    ...results: ReadonlyArray<{ remoteError?: string }>
): boolean {
    return !allowExactDemo && teacherLiveCatalogHasRemoteError(...results);
}

function validTime(value: string | undefined): number | null {
    if (!value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}

export function classifyTeacherLiveExamPhase(
    exam: Pick<Exam, "archived" | "startAt" | "endAt">,
    attempts: ReadonlyArray<Pick<Attempt, "status">> = [],
    now = Date.now(),
): TeacherLiveExamPhase {
    if (exam.archived) return "completed";

    const startAt = validTime(exam.startAt);
    const endAt = validTime(exam.endAt);
    if (endAt !== null && endAt <= now) return "completed";
    if (startAt !== null && startAt > now) return "scheduled";
    if (attempts.some(attempt => attempt.status === "in_progress")) return "live";
    if ((startAt !== null && startAt <= now) || (endAt !== null && endAt > now)) return "live";
    return "ready";
}

export function teacherLiveExamPresentation(
    phase: TeacherLiveExamPhase,
    demo = false,
): TeacherLiveExamPresentation {
    if (demo) {
        return {
            label: "DEMO · 합성 데이터",
            description: "합성 응시 데이터이며 실제 학생 상태가 아닙니다.",
            tone: "muted",
        };
    }
    if (phase === "live") {
        return {
            label: "LIVE · 실시간 갱신",
            description: "제출과 문항 결과를 3초마다 갱신합니다.",
            tone: "primary",
        };
    }
    if (phase === "scheduled") {
        return {
            label: "준비 · 시작 전",
            description: "시작 시간이 되면 LIVE 상태로 전환됩니다.",
            tone: "primary",
        };
    }
    if (phase === "completed") {
        return {
            label: "완료 · 종료됨",
            description: "종료된 시험의 최종 제출 결과를 표시합니다.",
            tone: "success",
        };
    }
    return {
        label: "준비 · 응시 대기",
        description: "배포됐지만 시작 시간 또는 진행 중 응시가 없습니다.",
        tone: "muted",
    };
}

export function selectTeacherLiveExamId(
    exams: ReadonlyArray<Pick<Exam, "id" | "archived" | "startAt" | "endAt">>,
    attempts: ReadonlyArray<Pick<Attempt, "examId" | "status">>,
    currentId = "",
    now = Date.now(),
): string {
    if (exams.length === 0) return "";
    if (exams.some(exam => exam.id === currentId)) return currentId;
    const rank: Record<TeacherLiveExamPhase, number> = {
        live: 0,
        scheduled: 1,
        ready: 2,
        completed: 3,
    };
    // Phase classification only needs to know whether an exam has an active
    // attempt. Build that index once instead of filtering all attempts twice
    // for every comparison in a full exam sort.
    const activeExamIds = new Set<string>();
    for (const attempt of attempts) {
        if (attempt.status === "in_progress") activeExamIds.add(attempt.examId);
    }
    const activeAttempts = [{ status: "in_progress" as const }];
    const noAttempts: [] = [];
    let preferredId = "";
    let preferredRank = Number.POSITIVE_INFINITY;
    for (const exam of exams) {
        const phase = classifyTeacherLiveExamPhase(
            exam,
            activeExamIds.has(exam.id) ? activeAttempts : noAttempts,
            now,
        );
        // Strictly lower rank preserves the first catalog row on ties, as
        // the previous stable sort did. No later row can outrank a live exam.
        if (rank[phase] < preferredRank) {
            preferredId = exam.id;
            preferredRank = rank[phase];
            if (phase === "live") break;
        }
    }
    return preferredId;
}
