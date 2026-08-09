import {
    CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS,
    normalizeCanonicalSurfaceCacheText,
    readCanonicalSurfaceCache,
    writeCanonicalSurfaceCache,
    type CanonicalDashboardCacheData,
    type CanonicalDashboardAttemptSummary,
    type CanonicalDashboardExamSummary,
    type CanonicalSurfaceCacheIdentity,
    type CanonicalSurfaceCacheStorage,
} from "@/lib/canonicalSurfaceCache";
import type { Attempt, Exam } from "@/types/omr";

export interface TeacherSessionIdentity {
    organizationId: string;
    accountId: string;
    sessionGeneration: number;
}

export interface TeacherLoadIdentity extends TeacherSessionIdentity {
    requestGeneration: number;
}

export type TeacherDashboardLiveLoadState =
    | "loading"
    | "loaded_empty"
    | "loaded_data"
    | "degraded_with_cache"
    | "error_without_cache";

export interface TeacherDashboardLiveOperationState {
    loadState: TeacherDashboardLiveLoadState;
    identity: TeacherLoadIdentity | null;
}

export interface TeacherDashboardRepairOperationState {
    capabilityEpoch: number;
    nextToken: number;
    activeToken: number | null;
}

export interface TeacherDashboardRepairOperation {
    capabilityEpoch: number;
    token: number;
}

export interface TeacherDashboardRemoteCollection {
    remoteLoaded?: boolean;
    remoteSynced?: boolean;
    remotePartial?: boolean;
    remoteError?: string;
    meta?: { organizationId?: string };
}

export interface TeacherDashboardReadyDetailSeed<T> {
    generation: number;
    items: readonly T[];
    loadStatus: "ready";
    sampleStatus: "ready";
}

export interface TeacherDashboardDetailReset {
    generation: number;
    items: null;
    loadStatus: "idle";
    sampleStatus: "ready";
}

export interface TeacherDashboardDegradedExam extends CanonicalDashboardExamSummary {
    readonly kind: "degraded_exam_summary";
}

export interface TeacherDashboardDegradedAttempt extends CanonicalDashboardAttemptSummary {
    readonly kind: "degraded_attempt_summary";
}

export interface TeacherDashboardDegradedData {
    readonly kind: "teacher_dashboard_degraded";
    readonly staleAt: string;
    readonly exams: readonly TeacherDashboardDegradedExam[];
    readonly attempts: readonly TeacherDashboardDegradedAttempt[];
}

function cacheIdentity(identity: TeacherSessionIdentity): CanonicalSurfaceCacheIdentity {
    return {
        surface: "teacher_dashboard",
        organizationId: identity.organizationId,
        accountId: identity.accountId,
        sessionGeneration: identity.sessionGeneration,
    };
}

function stableAttemptStudentId(attempt: Attempt): string | null {
    for (const candidate of [attempt.studentProfileId, attempt.studentId, attempt.guestId]) {
        if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
    return null;
}

export function toTeacherDashboardCacheProjection(
    exams: readonly Exam[],
    attempts: readonly Attempt[],
): CanonicalDashboardCacheData {
    const attemptCounts = new Map<string, number>();
    for (const attempt of attempts) {
        attemptCounts.set(attempt.examId, (attemptCounts.get(attempt.examId) || 0) + 1);
    }
    return {
        exams: exams.map(exam => ({
            id: exam.id,
            title: normalizeCanonicalSurfaceCacheText(
                exam.title,
                CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.title,
            ).value,
            status: exam.archived ? "archived" : "active",
            createdAt: exam.createdAt,
            updatedAt: exam.updatedAt || exam.createdAt,
            questionCount: exam.questions.length,
            attemptCount: attemptCounts.get(exam.id) || 0,
        })),
        attempts: attempts.map(attempt => ({
            id: attempt.id,
            examId: attempt.examId,
            studentId: stableAttemptStudentId(attempt),
            studentName: normalizeCanonicalSurfaceCacheText(
                attempt.studentName,
                CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.name,
            ).value,
            status: attempt.status,
            score: attempt.score,
            totalScore: attempt.totalScore,
            startedAt: attempt.startedAt,
            finishedAt: attempt.finishedAt,
            isRetake: !!attempt.retake,
        })),
    };
}

export function cacheFreshTeacherDashboardOptional(
    storage: CanonicalSurfaceCacheStorage,
    identity: TeacherSessionIdentity,
    staleAt: string,
    exams: readonly Exam[],
    attempts: readonly Attempt[],
    now = new Date(),
): boolean {
    try {
        const projection = toTeacherDashboardCacheProjection(exams, attempts);
        return writeCanonicalSurfaceCache(
            storage,
            cacheIdentity(identity),
            staleAt,
            projection,
            now,
        ).status === "written";
    } catch {
        return false;
    }
}

export function materializeTeacherDashboardDegradedCache(
    data: CanonicalDashboardCacheData,
    staleAt: string,
): TeacherDashboardDegradedData {
    const exams = Object.freeze(data.exams.map(exam => Object.freeze({
        kind: "degraded_exam_summary" as const,
        ...exam,
    })));
    const attempts = Object.freeze(data.attempts.map(attempt => Object.freeze({
        kind: "degraded_attempt_summary" as const,
        ...attempt,
    })));
    return Object.freeze({
        kind: "teacher_dashboard_degraded" as const,
        staleAt,
        exams,
        attempts,
    });
}

export function readTeacherDashboardDegradedCache(
    storage: CanonicalSurfaceCacheStorage,
    identity: TeacherSessionIdentity,
    now = new Date(),
): TeacherDashboardDegradedData | null {
    const result = readCanonicalSurfaceCache<CanonicalDashboardCacheData>(
        storage,
        cacheIdentity(identity),
        now,
    );
    return result.status === "hit"
        ? materializeTeacherDashboardDegradedCache(result.envelope.data, result.envelope.staleAt)
        : null;
}

export function sameTeacherLoadIdentity(left: TeacherLoadIdentity, right: TeacherLoadIdentity): boolean {
    return sameTeacherSessionIdentity(left, right)
        && left.requestGeneration === right.requestGeneration;
}

export function sameTeacherSessionIdentity(
    left: TeacherSessionIdentity,
    right: TeacherSessionIdentity,
): boolean {
    return left.organizationId === right.organizationId
        && left.accountId === right.accountId
        && left.sessionGeneration === right.sessionGeneration;
}

export function canContinueTeacherDashboardRepair(
    captured: TeacherSessionIdentity,
    live: TeacherDashboardLiveOperationState,
): boolean {
    return live.loadState === "loaded_data"
        && !!live.identity
        && sameTeacherSessionIdentity(captured, live.identity);
}

export function canReleaseTeacherDashboardRepair(
    captured: TeacherSessionIdentity,
    live: TeacherDashboardLiveOperationState,
): boolean {
    return !!live.identity
        && sameTeacherSessionIdentity(captured, live.identity);
}

export function beginTeacherDashboardRepairOperation(
    state: TeacherDashboardRepairOperationState,
): { state: TeacherDashboardRepairOperationState; operation: TeacherDashboardRepairOperation } {
    const token = state.nextToken + 1;
    return {
        state: { ...state, nextToken: token, activeToken: token },
        operation: { capabilityEpoch: state.capabilityEpoch, token },
    };
}

export function invalidateTeacherDashboardRepairCapability(
    state: TeacherDashboardRepairOperationState,
): TeacherDashboardRepairOperationState {
    return { ...state, capabilityEpoch: state.capabilityEpoch + 1 };
}

export function canContinueTeacherDashboardRepairOperation(
    operation: TeacherDashboardRepairOperation,
    state: TeacherDashboardRepairOperationState,
): boolean {
    return state.activeToken === operation.token
        && state.capabilityEpoch === operation.capabilityEpoch;
}

export function canReleaseTeacherDashboardRepairOperation(
    operation: TeacherDashboardRepairOperation,
    state: TeacherDashboardRepairOperationState,
): boolean {
    return state.activeToken === operation.token;
}

export function canContinueTeacherDashboardDetail(
    captured: TeacherLoadIdentity,
    live: TeacherDashboardLiveOperationState,
): boolean {
    return live.loadState === "loaded_data"
        && !!live.identity
        && sameTeacherLoadIdentity(captured, live.identity);
}

export function isTeacherDashboardRemoteCollectionReady(
    result: TeacherDashboardRemoteCollection,
    organizationId: string,
): boolean {
    return result.remoteLoaded === true
        && result.remoteSynced === true
        && result.remotePartial !== true
        && !result.remoteError
        && result.meta?.organizationId === organizationId;
}

export function buildTeacherDashboardReadyDetailSeed<T>(
    captured: TeacherLoadIdentity,
    current: TeacherLoadIdentity,
    currentGeneration: number,
    result: TeacherDashboardRemoteCollection & { items: readonly T[] },
): TeacherDashboardReadyDetailSeed<T> | null {
    if (!sameTeacherLoadIdentity(captured, current)
        || !Number.isSafeInteger(currentGeneration)
        || currentGeneration < 0
        || !isTeacherDashboardRemoteCollectionReady(result, captured.organizationId)) return null;
    return {
        generation: currentGeneration + 1,
        items: result.items,
        loadStatus: "ready",
        sampleStatus: "ready",
    };
}

export function buildTeacherDashboardDetailReset(
    currentGeneration: number,
): TeacherDashboardDetailReset | null {
    if (!Number.isSafeInteger(currentGeneration) || currentGeneration < 0) return null;
    return {
        generation: currentGeneration + 1,
        items: null,
        loadStatus: "idle",
        sampleStatus: "ready",
    };
}

export function resolveTeacherDashboardSessionChange(
    currentIsMockup: boolean,
    next: { isMockup: boolean; hasCanonicalIdentity: boolean },
): "mode_changed" | "reload" | "unavailable" {
    if (!next.isMockup && !next.hasCanonicalIdentity) return "unavailable";
    if (currentIsMockup !== next.isMockup) return "mode_changed";
    return "reload";
}

export function publishTeacherDashboardCompletionIfCurrent(
    captured: TeacherLoadIdentity,
    current: TeacherLoadIdentity,
    effects: { publishState(): void; persistCache(): void },
): boolean {
    if (!sameTeacherLoadIdentity(captured, current)) return false;
    effects.publishState();
    effects.persistCache();
    return true;
}
