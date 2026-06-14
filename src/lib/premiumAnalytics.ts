import type { Attempt, Exam, FocusLossEvent, Question, QuestionTiming } from "@/types/omr";

export interface WeaknessGroup {
    key: string;
    title: string;
    basis: string;
    questionIds: number[];
    questionNumbers: number[];
    wrongCount: number;
    totalCount: number;
    wrongRate: number;
    labels: string[];
    concepts: string[];
    recommendedAction: string;
}

export interface SimilarQuestionGroup extends WeaknessGroup {
    attemptCount: number;
}

export interface AttemptBehaviorSummary {
    totalTrackedTimeSec: number;
    averageTimeSec: number;
    slowQuestionNumbers: number[];
    rushedQuestionNumbers: number[];
    revisitedQuestionNumbers: number[];
    focusLossCount: number;
    focusLossQuestionNumbers: number[];
}

type GroupKind = "source" | "concept" | "unit" | "label";

const BASIS_BY_KIND: Record<GroupKind, string> = {
    source: "같은 지문/작품",
    concept: "같은 개념",
    unit: "같은 단원",
    label: "같은 라벨",
};

function uniqueSorted(values: Array<string | undefined>): string[] {
    return Array.from(new Set(values.filter((value): value is string => !!value))).sort((a, b) => a.localeCompare(b, "ko"));
}

function groupValue(question: Question, kind: GroupKind): string | undefined {
    if (kind === "source") return question.tags?.source?.trim();
    if (kind === "concept") return question.tags?.concept?.trim() || question.label?.trim();
    if (kind === "unit") return question.tags?.unit?.trim();
    return question.label?.trim();
}

function isWrongOrUnanswered(question: Question, attempt: Attempt): boolean {
    if (question.answer === undefined || question.answer === null) return false;
    const selected = attempt.answers[question.id];
    return selected === undefined || selected === null || selected === 0 || selected !== question.answer;
}

function groupKey(kind: GroupKind, title: string): string {
    return `${kind}:${title}`;
}

function makeWeaknessGroup(
    kind: GroupKind,
    title: string,
    questions: Question[],
    wrongCount: number,
    totalCount: number,
): WeaknessGroup {
    const questionNumbers = questions.map(q => q.number).sort((a, b) => a - b);
    const basis = BASIS_BY_KIND[kind];
    return {
        key: groupKey(kind, title),
        title,
        basis,
        questionIds: questions.map(q => q.id).sort((a, b) => a - b),
        questionNumbers,
        wrongCount,
        totalCount,
        wrongRate: totalCount > 0 ? Math.round((wrongCount / totalCount) * 100) : 0,
        labels: uniqueSorted(questions.map(q => q.label)),
        concepts: uniqueSorted(questions.map(q => q.tags?.concept)),
        recommendedAction: `${basis} ${questions.length}문항 재시험`,
    };
}

function sortGroups<T extends WeaknessGroup>(groups: T[]): T[] {
    return [...groups].sort((a, b) => {
        if (b.wrongRate !== a.wrongRate) return b.wrongRate - a.wrongRate;
        if (b.wrongCount !== a.wrongCount) return b.wrongCount - a.wrongCount;
        const aFirst = a.questionNumbers[0] ?? Number.MAX_SAFE_INTEGER;
        const bFirst = b.questionNumbers[0] ?? Number.MAX_SAFE_INTEGER;
        if (aFirst !== bFirst) return aFirst - bFirst;
        return a.title.localeCompare(b.title, "ko");
    });
}

export function buildRetakeQuestionIds(exam: Exam, attempt: Attempt): number[] {
    return exam.questions
        .filter(question => isWrongOrUnanswered(question, attempt))
        .map(question => question.id)
        .sort((a, b) => a - b);
}

export function buildStudentWeaknessGroups(exam: Exam, attempt: Attempt): WeaknessGroup[] {
    const wrongQuestions = exam.questions.filter(question => isWrongOrUnanswered(question, attempt));
    const consumed = new Set<number>();
    const groups: WeaknessGroup[] = [];

    const addGroupsForKind = (kind: GroupKind, requireRepeatedInExam = false) => {
        const byValue = new Map<string, Question[]>();
        for (const question of wrongQuestions) {
            if (consumed.has(question.id)) continue;
            const value = groupValue(question, kind);
            if (!value) continue;
            if (requireRepeatedInExam) {
                const sameInExam = exam.questions.filter(item => groupValue(item, kind) === value).length;
                if (sameInExam < 2) continue;
            }
            byValue.set(value, [...(byValue.get(value) || []), question]);
        }

        for (const [value, questions] of byValue.entries()) {
            questions.forEach(question => consumed.add(question.id));
            groups.push(makeWeaknessGroup(kind, value, questions, questions.length, questions.length));
        }
    };

    addGroupsForKind("source", true);
    addGroupsForKind("concept");
    addGroupsForKind("unit");
    addGroupsForKind("label");

    return sortGroups(groups);
}

export function buildSimilarQuestionGroups(exam: Exam, attempts: Attempt[]): SimilarQuestionGroup[] {
    const bySource = new Map<string, Question[]>();
    for (const question of exam.questions) {
        const title = groupValue(question, "source")
            || groupValue(question, "concept")
            || groupValue(question, "unit")
            || groupValue(question, "label");
        if (!title) continue;
        const kind: GroupKind = groupValue(question, "source") ? "source"
            : groupValue(question, "concept") ? "concept"
                : groupValue(question, "unit") ? "unit"
                    : "label";
        const key = groupKey(kind, title);
        bySource.set(key, [...(bySource.get(key) || []), question]);
    }

    const groups: SimilarQuestionGroup[] = [];
    for (const [key, questions] of bySource.entries()) {
        const [kindRaw, ...titleParts] = key.split(":");
        const kind = kindRaw as GroupKind;
        const title = titleParts.join(":");
        let wrongCount = 0;
        let totalCount = 0;

        for (const attempt of attempts) {
            for (const question of questions) {
                totalCount++;
                if (isWrongOrUnanswered(question, attempt)) wrongCount++;
            }
        }

        groups.push({
            ...makeWeaknessGroup(kind, title, questions, wrongCount, totalCount),
            attemptCount: attempts.length,
        });
    }

    return sortGroups(groups);
}

function uniqueQuestionNumbers(events: FocusLossEvent[]): number[] {
    return Array.from(new Set(
        events
            .map(event => event.questionNumber)
            .filter((value): value is number => typeof value === "number")
    )).sort((a, b) => a - b);
}

export function summarizeAttemptBehavior(attempt: Attempt): AttemptBehaviorSummary {
    const timings: QuestionTiming[] = attempt.questionTimings || [];
    const totalTrackedTimeSec = timings.reduce((sum, timing) => sum + Math.max(0, timing.totalTimeSec), 0);
    const averageTimeSec = timings.length > 0 ? Math.round(totalTrackedTimeSec / timings.length) : 0;
    const slowThreshold = averageTimeSec > 0 ? averageTimeSec * 1.5 : Number.POSITIVE_INFINITY;
    const rushedThreshold = averageTimeSec > 0 ? averageTimeSec * 0.4 : Number.NEGATIVE_INFINITY;
    const focusLossEvents = attempt.focusLossEvents || [];

    return {
        totalTrackedTimeSec,
        averageTimeSec,
        slowQuestionNumbers: timings
            .filter(timing => timing.totalTimeSec >= slowThreshold)
            .map(timing => timing.questionNumber)
            .sort((a, b) => a - b),
        rushedQuestionNumbers: timings
            .filter(timing => timing.totalTimeSec <= rushedThreshold)
            .map(timing => timing.questionNumber)
            .sort((a, b) => a - b),
        revisitedQuestionNumbers: timings
            .filter(timing => timing.revisitCount > 0 || timing.visitCount > 1)
            .map(timing => timing.questionNumber)
            .sort((a, b) => a - b),
        focusLossCount: focusLossEvents.length || attempt.tabFociLostCount || 0,
        focusLossQuestionNumbers: uniqueQuestionNumbers(focusLossEvents),
    };
}
