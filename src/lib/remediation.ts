export type RemediationState = "assigned" | "overdue" | "recheck" | "awaiting_review" | "confirmed" | "paused" | "handoff";
export interface RemediationCase {
    sourceAttemptId: string;
    examId: string;
    examTitle: string;
    studentName: string;
    className: string;
    assigneeName: string;
    dueAt: string;
    revision: number;
    state: RemediationState;
    targetCount: number;
    correctedCount: number;
    submittedCount: number;
    evidenceKey: string;
    note: string;
    canManage: boolean;
}
export interface RemediationCandidate {
    sourceAttemptId: string;
    examTitle: string;
    studentName: string;
    className: string;
    wrongCount: number;
}
export interface RemediationDashboard {
    cases: RemediationCase[];
    candidates: RemediationCandidate[];
    hasMore: boolean;
    canAssign: boolean;
    planEnabled: boolean;
}
export type RemediationCommand =
    | { op: "load"; page?: number }
    | { op: "assign"; sourceAttemptIds: string[]; dueAt: string }
    | { op: "confirm" | "pause" | "resume"; sourceAttemptId: string; expectedRevision: number; evidenceKey: string; note: string };

export type StudentRemediationCase = Pick<RemediationCase, "sourceAttemptId" | "examId" | "examTitle" | "dueAt" | "state" | "correctedCount" | "targetCount">;
export function parseStudentRemediation(value: unknown): StudentRemediationCase[] | null {
    if (!Array.isArray(value) || value.length > 50) return null;
    const parsed = parseRemediationDashboard({ cases: value.map(c => ({ ...c, studentName: "", className: "", assigneeName: "",
        revision: 1, note: "", evidenceKey: "0".repeat(32), submittedCount: c?.correctedCount, canManage: false })),
        candidates: [], hasMore: false, canAssign: false, planEnabled: false });
    return parsed?.cases.map(c => ({ sourceAttemptId: c.sourceAttemptId, examId: c.examId, examTitle: c.examTitle,
        dueAt: c.dueAt, state: c.state, correctedCount: c.correctedCount, targetCount: c.targetCount })) ?? null;
}

export const REMEDIATION_STATE_LABELS: Record<RemediationState, string> = {
    assigned: "보강 배정", overdue: "기한 초과", recheck: "재오답 점검", awaiting_review: "교사 확인 필요",
    confirmed: "교사 확인 완료", paused: "보류", handoff: "담당·재원 확인 필요",
};
const priority: Record<RemediationState, number> = { recheck: 0, overdue: 1, awaiting_review: 2, handoff: 3, assigned: 4, paused: 5, confirmed: 6 };
export function sortRemediationCases(cases: RemediationCase[]): RemediationCase[] {
    return [...cases].sort((a, b) => priority[a.state] - priority[b.state] || Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.sourceAttemptId.localeCompare(b.sourceAttemptId));
}
export function validRemediationCommand(value: unknown): value is RemediationCommand {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const input = value as Record<string, unknown>;
    const id = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 256 && v.trim() === v;
    if (input.op === "load") return Object.keys(input).length === 1 || (Object.keys(input).length === 2
        && Number.isSafeInteger(input.page) && Number(input.page) >= 0 && Number(input.page) <= 10000);
    if (input.op === "assign") return Object.keys(input).length === 3
        && Array.isArray(input.sourceAttemptIds) && input.sourceAttemptIds.length > 0 && input.sourceAttemptIds.length <= 20
        && input.sourceAttemptIds.every(id) && new Set(input.sourceAttemptIds).size === input.sourceAttemptIds.length
        && typeof input.dueAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(input.dueAt) && Number.isFinite(Date.parse(input.dueAt));
    return ["confirm", "pause", "resume"].includes(String(input.op)) && Object.keys(input).length === 5
        && id(input.sourceAttemptId) && Number.isSafeInteger(input.expectedRevision) && Number(input.expectedRevision) > 0
        && typeof input.evidenceKey === "string" && /^[a-f0-9]{32}$/.test(input.evidenceKey)
        && typeof input.note === "string" && input.note.trim().length >= (input.op === "resume" ? 0 : 5) && input.note.length <= 500;
}

/** Only allow bounded display fields across the server/client boundary. */
export function parseRemediationDashboard(value: unknown): RemediationDashboard | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const v = value as RemediationDashboard;
    if (!Array.isArray(v.cases) || v.cases.length > 50 || !Array.isArray(v.candidates) || v.candidates.length > 50
        || typeof v.hasMore !== "boolean" || typeof v.canAssign !== "boolean" || typeof v.planEnabled !== "boolean") return null;
    const text = (s: unknown, max = 256) => typeof s === "string" && s.length <= max;
    const count = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 500;
    if (v.cases.some(c => !c || !Object.hasOwn(REMEDIATION_STATE_LABELS, c.state) || !text(c.sourceAttemptId) || !text(c.examId)
        || !text(c.examTitle, 500) || !text(c.studentName) || !text(c.className) || !text(c.assigneeName)
        || !c.sourceAttemptId || !c.examId || !text(c.note, 500) || !text(c.dueAt) || !Number.isFinite(Date.parse(c.dueAt)) || !Number.isSafeInteger(c.revision) || c.revision < 1
        || !count(c.targetCount) || c.targetCount < 1 || !count(c.correctedCount) || c.correctedCount > c.targetCount
        || !count(c.submittedCount) || c.submittedCount > c.targetCount || c.correctedCount > c.submittedCount || typeof c.canManage !== "boolean"
        || typeof c.evidenceKey !== "string" || !/^[a-f0-9]{32}$/.test(c.evidenceKey))) return null;
    if (v.candidates.some(c => !c || !text(c.sourceAttemptId) || !text(c.examTitle, 500) || !text(c.studentName)
        || !text(c.className) || !count(c.wrongCount) || c.wrongCount < 1)) return null;
    return { cases: sortRemediationCases(v.cases.map(c => ({
        sourceAttemptId: c.sourceAttemptId, examId: c.examId, examTitle: c.examTitle, studentName: c.studentName,
        className: c.className, assigneeName: c.assigneeName, dueAt: c.dueAt, revision: c.revision, state: c.state,
        targetCount: c.targetCount, correctedCount: c.correctedCount, submittedCount: c.submittedCount,
        evidenceKey: c.evidenceKey, note: c.note, canManage: c.canManage,
    }))), candidates: v.candidates.map(c => ({ sourceAttemptId: c.sourceAttemptId, examTitle: c.examTitle,
        studentName: c.studentName, className: c.className, wrongCount: c.wrongCount })),
    hasMore: v.hasMore, canAssign: v.canAssign, planEnabled: v.planEnabled };
}
