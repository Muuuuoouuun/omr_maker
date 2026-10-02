import type {
    LoadTeacherIndividualAssignmentResult,
} from "@/lib/individualAssignmentGateway";
import type { Exam } from "@/types/omr";
import type { StudentAssignmentPreview, StudentAttemptSummary } from "@/lib/studentExamContract";
import { resolveAssignmentLifecycle } from "@/lib/assignmentLifecycle";

export interface ReviewOnlyCompletedAssignment {
    id: string;
    title: string;
    createdAt: string;
    lifecycle: "closed";
    reviewOnly: true;
    attemptId: string;
    answeredQuestionCount?: number;
}

/** Converts a device-local Exam into the same fail-closed lifecycle shape as a server preview. */
export function localStudentAssignmentPreview(exam: Exam, now: string): StudentAssignmentPreview {
    return {
        id: exam.id,
        title: exam.title,
        createdAt: exam.createdAt,
        ...(exam.updatedAt ? { updatedAt: exam.updatedAt } : {}),
        ...(typeof exam.durationMin === "number" ? { durationMin: exam.durationMin } : {}),
        ...(exam.startAt ? { startsAt: exam.startAt } : {}),
        ...(exam.endAt ? { endsAt: exam.endAt } : {}),
        ...(typeof exam.archived === "boolean" ? { archived: exam.archived } : {}),
        lifecycle: resolveAssignmentLifecycle({
            state: exam.archived ? "archived" : "open",
            startsAt: exam.startAt,
            endsAt: exam.endAt,
            now,
        }),
        access: {
            type: exam.accessConfig?.type === "targeted"
                ? "targeted"
                : exam.accessConfig?.type === "group"
                    ? "group"
                    : "public",
            entryCheck: "required",
        },
    };
}

/** Restores exact-scope review navigation for completions omitted from active rows. */
export function buildMissingCompletedReviewAssignments(
    visibleAssignmentScopes: ReadonlySet<string>,
    attempts: readonly StudentAttemptSummary[],
): ReviewOnlyCompletedAssignment[] {
    const reviewAttempts = new Map<string, StudentAttemptSummary>();
    for (const attempt of attempts) {
        if (attempt.status !== "completed") continue;
        const identity = attemptScopeKey(attempt);
        if (visibleAssignmentScopes.has(identity)) continue;
        const current = reviewAttempts.get(identity);
        const currentTime = current ? Date.parse(current.finishedAt) : Number.NEGATIVE_INFINITY;
        const candidateTime = Date.parse(attempt.finishedAt);
        if (
            !current
            || (Number.isFinite(candidateTime) ? candidateTime : Number.NEGATIVE_INFINITY) > currentTime
            || (candidateTime === currentTime && attempt.id > current.id)
        ) reviewAttempts.set(identity, attempt);
    }

    return [...reviewAttempts.values()]
        .sort((left, right) => right.finishedAt.localeCompare(left.finishedAt) || left.examId.localeCompare(right.examId))
        .map(attempt => ({
            id: attempt.assignmentId || attempt.retakeSourceAttemptId ? attempt.id : attempt.examId,
            title: attempt.examTitle,
            createdAt: attempt.startedAt,
            lifecycle: "closed" as const,
            reviewOnly: true as const,
            attemptId: attempt.id,
            ...(attempt.answeredQuestionCount ? { answeredQuestionCount: attempt.answeredQuestionCount } : {}),
        }));
}

type AssignmentLike = Pick<StudentAssignmentPreview,
    "id" | "assignmentId" | "assignmentRevision" | "assignmentMode" | "retakeSourceAttemptId"
>;

function assignmentRevision(value: unknown): number | null {
    return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

/** Stable identity shared by active rows and attempts; never falls back across assignments. */
export function assignmentAttemptScopeKey(assignment: AssignmentLike): string {
    if (!assignment.assignmentId) return `exam:${assignment.id}:base`;
    const revision = assignmentRevision(assignment.assignmentRevision);
    return revision
        ? `assignment:${assignment.assignmentId}:revision:${revision}`
        : `invalid-assignment:${assignment.assignmentId}`;
}

function attemptScopeKey(attempt: StudentAttemptSummary): string {
    if (attempt.assignmentId) {
        const revision = assignmentRevision(attempt.assignmentRevision);
        return revision
            ? `assignment:${attempt.assignmentId}:revision:${revision}`
            : `legacy-assignment:${attempt.id}`;
    }
    if (attempt.retakeSourceAttemptId) return `retake:${attempt.id}`;
    return `exam:${attempt.examId}:base`;
}

function attemptMatchesAssignmentScope(
    assignment: AssignmentLike,
    attempt: StudentAttemptSummary,
): boolean {
    if (attempt.examId !== assignment.id) return false;
    const expectedRevision = assignmentRevision(assignment.assignmentRevision);
    if (assignment.assignmentId && !expectedRevision) return false;
    if (assignment.assignmentId && (
        attempt.assignmentId !== assignment.assignmentId
        || assignmentRevision(attempt.assignmentRevision) !== expectedRevision
    )) return false;
    if (assignment.assignmentMode === "retake") {
        return !!assignment.assignmentId
            && !!assignment.retakeSourceAttemptId
            && attempt.retakeSourceAttemptId === assignment.retakeSourceAttemptId;
    }
    if (assignment.assignmentId) {
        return !attempt.retakeSourceAttemptId;
    }
    return !attempt.assignmentId && !attempt.retakeSourceAttemptId;
}

/** Returns null for a targeted assignment that lacks its immutable revision. */
export function studentAssignmentDraftStorageKey(
    examId: string,
    ownerKey: string,
    assignment: Pick<AssignmentLike, "assignmentId" | "assignmentRevision">,
    retakeSegment: string,
): string | null {
    if (!examId || !ownerKey || !retakeSegment) return null;
    const revision = assignmentRevision(assignment.assignmentRevision);
    if (assignment.assignmentId && !revision) return null;
    const tuple = [
        "student-assignment-draft",
        2,
        examId,
        ownerKey,
        assignment.assignmentId || null,
        revision,
        retakeSegment,
    ] as const;
    return `omr_draft:v2:${encodeURIComponent(JSON.stringify(tuple))}`;
}

type StudentDraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const MAX_LEGACY_STUDENT_DRAFT_RECOVERY_BYTES = 512 * 1024;

function plainRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype;
}

function boundedLegacyDraft(value: string): Record<string, unknown> | null {
    if (new TextEncoder().encode(value).byteLength > MAX_LEGACY_STUDENT_DRAFT_RECOVERY_BYTES) return null;
    try {
        const parsed: unknown = JSON.parse(value);
        if (!plainRecord(parsed)) return null;
        const allowed = [
            "answers", "subQuestionAnswers", "drawings", "drawingsRef", "timeRemaining",
            "startedAt", "submissionId", "savedAt",
        ];
        if (Object.keys(parsed).some(key => !allowed.includes(key))
            || !plainRecord(parsed.answers)
            || !plainRecord(parsed.subQuestionAnswers)
            || (parsed.drawings !== undefined && !plainRecord(parsed.drawings))
            || (parsed.drawingsRef !== undefined && (
                !plainRecord(parsed.drawingsRef)
                || Object.keys(parsed.drawingsRef).some(key => key !== "store" && key !== "key")
                || parsed.drawingsRef.store !== "indexeddb"
                || typeof parsed.drawingsRef.key !== "string"
                || !parsed.drawingsRef.key.trim()
                || parsed.drawingsRef.key.length > 512
            ))
            || (parsed.timeRemaining !== undefined
                && (!Number.isFinite(parsed.timeRemaining) || Number(parsed.timeRemaining) < 0))
            || (parsed.startedAt !== undefined && !Number.isFinite(Date.parse(String(parsed.startedAt))))
            || (parsed.savedAt !== undefined && !Number.isFinite(Date.parse(String(parsed.savedAt))))
            || (parsed.submissionId !== undefined && (
                typeof parsed.submissionId !== "string"
                || !parsed.submissionId.trim()
                || parsed.submissionId.length > 256
            ))) return null;
        return parsed;
    } catch {
        return null;
    }
}

export function buildLegacyStudentDraftRecoveryExport(
    storage: Pick<Storage, "getItem">,
    input: { legacySegmentedKey: string; examId: string },
): { status: "none" | "invalid" } | { status: "available"; fileName: string; json: string } {
    if (!input.legacySegmentedKey || !input.examId || input.examId.length > 256) return { status: "invalid" };
    try {
        const raw = storage.getItem(input.legacySegmentedKey);
        if (raw === null) return { status: "none" };
        const candidate = boundedLegacyDraft(raw);
        if (!candidate) return { status: "invalid" };
        const fields = [
            "answers", "subQuestionAnswers", "drawingsRef", "timeRemaining",
            "startedAt", "submissionId", "savedAt",
        ];
        const data = Object.fromEntries(fields
            .filter(key => candidate[key] !== undefined)
            .map(key => [key, candidate[key]]));
        const json = JSON.stringify({
            schemaVersion: 1,
            kind: "legacy_student_draft_recovery",
            examId: input.examId,
            ...data,
            ...(candidate.drawings !== undefined ? { inlineDrawingsRetainedInBrowser: true } : {}),
        }, null, 2);
        if (new TextEncoder().encode(json).byteLength > MAX_LEGACY_STUDENT_DRAFT_RECOVERY_BYTES) {
            return { status: "invalid" };
        }
        const safeExamId = input.examId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "exam";
        return { status: "available", fileName: `omr-draft-recovery-${safeExamId}.json`, json };
    } catch {
        return { status: "invalid" };
    }
}

export function isCurrentLegacyStudentDraftRecovery(
    binding: { ownerStudentId: string; sessionGeneration: string; sharedIdentityEpoch: string; examId: string },
    current: { studentId?: string } | null,
    currentGeneration: string,
    currentSharedIdentityEpoch: string,
    currentExamId: string,
): boolean {
    return !!binding.ownerStudentId
        && !!binding.sessionGeneration
        && !!binding.sharedIdentityEpoch
        && current?.studentId === binding.ownerStudentId
        && currentGeneration === binding.sessionGeneration
        && currentSharedIdentityEpoch === binding.sharedIdentityEpoch
        && !!binding.examId
        && currentExamId === binding.examId;
}

/**
 * The preceding segmented key has no immutable assignment origin. It is never
 * migrated or loaded; callers may offer the bounded manual recovery export.
 */
export function migrateLegacyStudentDraftStorage(
    storage: StudentDraftStorage,
    input: {
        canonicalKey: string;
        legacySegmentedKey: string;
    },
): { status: "none" | "canonical" | "recovery_required"; value?: string } {
    if (!input.canonicalKey || !input.legacySegmentedKey) return { status: "none" };
    try {
        const canonical = storage.getItem(input.canonicalKey);
        if (canonical !== null) return { status: "canonical", value: canonical };
        const legacy = storage.getItem(input.legacySegmentedKey);
        if (legacy === null) return { status: "none" };
        return { status: "recovery_required" };
    } catch {
        return { status: "recovery_required" };
    }
}

function latestMatchingAttempt(
    assignment: AssignmentLike,
    attempts: readonly StudentAttemptSummary[],
    status: StudentAttemptSummary["status"],
): StudentAttemptSummary | undefined {
    let latest: StudentAttemptSummary | undefined;
    for (const attempt of attempts) {
        if (attempt.status !== status || !attemptMatchesAssignmentScope(assignment, attempt)) continue;
        if (!latest) {
            latest = attempt;
            continue;
        }
        const candidateAt = Date.parse(status === "completed" ? attempt.finishedAt : attempt.startedAt);
        const latestAt = Date.parse(status === "completed" ? latest.finishedAt : latest.startedAt);
        const candidateOrder = Number.isFinite(candidateAt) ? candidateAt : Number.NEGATIVE_INFINITY;
        const latestOrder = Number.isFinite(latestAt) ? latestAt : Number.NEGATIVE_INFINITY;
        if (candidateOrder > latestOrder || (candidateOrder === latestOrder && attempt.id > latest.id)) latest = attempt;
    }
    return latest;
}

/** An assignment is complete only when its own exact scoped attempt is complete. */
export function findCompletedAttemptForAssignment(
    assignment: AssignmentLike,
    attempts: StudentAttemptSummary[],
): StudentAttemptSummary | undefined {
    return latestMatchingAttempt(assignment, attempts, "completed");
}

/** Restores progress only for the exact assignment that created the attempt. */
export function findInProgressAttemptForAssignment(
    assignment: AssignmentLike,
    attempts: StudentAttemptSummary[],
): StudentAttemptSummary | undefined {
    return latestMatchingAttempt(assignment, attempts, "in_progress");
}

export async function reloadLatestAssignmentAfterConflict(
    examId: string,
    load: (examId: string) => Promise<LoadTeacherIndividualAssignmentResult | { status: "local_only" }>,
): Promise<
    | { status: "loaded"; revision: number; mode: "base" | "retake"; targetStudentIds: string[] }
    | { status: "unavailable" }
> {
    const latest = await load(examId);
    if (latest.status !== "loaded") return { status: "unavailable" };
    return {
        status: "loaded",
        revision: latest.revision,
        mode: latest.mode,
        targetStudentIds: latest.targetStudentIds,
    };
}
