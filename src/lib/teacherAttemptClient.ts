import {
    answerTeacherCanonicalAttemptQuestion,
    forceFinishTeacherCanonicalAttemptSessions,
    forceFinishTeacherCanonicalAttempts,
    listTeacherCanonicalActiveAttemptSessions,
    listTeacherCanonicalAttemptSummaries,
    listTeacherCanonicalAttempts,
    loadTeacherCanonicalAttempt,
    setTeacherCanonicalSubquestionReview,
} from "@/app/actions/teacherAttempts";
import {
    loadAttempt,
    loadAttempts,
    readLocalAttempts,
    saveLocalAttempt,
} from "@/lib/omrPersistence";
import { answerStudentQuestion } from "@/lib/studentQuestions";
import { withBrowserStorageLock } from "@/lib/browserStorageLock";
import type { Attempt } from "@/types/omr";
import type { TeacherActiveAttemptSession } from "@/lib/teacherAttemptGateway";

export type TeacherAttemptDetailLoadResult =
    | { status: "loaded"; attempt: Attempt; source: "server" | "local" }
    | { status: "not_found" }
    | { status: "unauthorized"; error: string }
    | { status: "service_unavailable"; error: string };

export interface TeacherAttemptCollectionLoadResult {
    items: Attempt[];
    remoteLoaded: boolean;
    remoteSynced?: boolean;
    pendingSyncCount?: number;
    remoteError?: string;
    remotePartial?: boolean;
    remoteHasMore?: boolean;
    remoteItemCount?: number;
    remoteNextCursor?: {
        finishedAt: string;
        id: string;
    };
}

export type TeacherAttemptCollectionCompleteness = "ready" | "partial" | "stale" | "error";

export interface TeacherCollectionCompletenessInput {
    items: readonly unknown[];
    remoteLoaded: boolean;
    remoteSynced?: boolean;
    remotePartial?: boolean;
    remoteError?: string;
}

export function resolveTeacherAttemptCollectionCompleteness(
    input: TeacherCollectionCompletenessInput,
): TeacherAttemptCollectionCompleteness {
    const hasUsableItems = input.items.length > 0;
    // A source error means the available rows are cached evidence, even when the
    // remote response also carries pagination metadata.
    if (input.remoteError) return hasUsableItems ? "stale" : "error";
    if (input.remotePartial) return hasUsableItems ? "partial" : "error";
    if (!input.remoteLoaded || input.remoteSynced === false) {
        return hasUsableItems ? "stale" : "error";
    }
    return "ready";
}

export function resolveTeacherCollectionGroupCompleteness(
    inputs: readonly TeacherCollectionCompletenessInput[],
): TeacherAttemptCollectionCompleteness {
    if (inputs.length === 0) return "error";
    const priorities: Record<TeacherAttemptCollectionCompleteness, number> = {
        ready: 0,
        partial: 1,
        stale: 2,
        error: 3,
    };
    return inputs.reduce<TeacherAttemptCollectionCompleteness>((combined, input) => {
        const current = resolveTeacherAttemptCollectionCompleteness(input);
        return priorities[current] > priorities[combined] ? current : combined;
    }, "ready");
}

export async function loadTeacherActiveAttemptSessions(examId: string): Promise<{
    items: TeacherActiveAttemptSession[];
    remoteLoaded: boolean;
    remoteError?: string;
}> {
    const result = await listTeacherCanonicalActiveAttemptSessions(examId);
    if (result.status === "loaded") {
        return { items: result.sessions, remoteLoaded: true };
    }
    if (result.status === "local_only") return { items: [], remoteLoaded: false };
    return {
        items: [],
        remoteLoaded: false,
        remoteError: result.status === "unauthorized"
            ? "Teacher server session is missing"
            : result.error || "Canonical active attempt session gateway unavailable",
    };
}

export async function loadTeacherAttemptDetail(attemptId: string): Promise<TeacherAttemptDetailLoadResult> {
    const result = await loadTeacherCanonicalAttempt(attemptId);
    if (result.status === "loaded") {
        await saveLocalAttempt(result.attempt);
        return { status: "loaded", attempt: result.attempt, source: "server" };
    }
    if (result.status === "local_only") {
        const attempt = await loadAttempt(attemptId);
        return attempt
            ? { status: "loaded", attempt, source: "local" }
            : { status: "not_found" };
    }
    if (result.status === "not_found") return { status: "not_found" };
    if (result.status === "unauthorized" || result.status === "forbidden") {
        return {
            status: "unauthorized",
            error: result.status === "unauthorized"
                ? "Teacher server session is missing"
                : "Teacher role cannot read attempts",
        };
    }
    return {
        status: "service_unavailable",
        error: result.error || "Canonical attempt gateway unavailable",
    };
}

export async function loadTeacherAttempt(attemptId: string): Promise<Attempt | null> {
    const result = await loadTeacherAttemptDetail(attemptId);
    return result.status === "loaded" ? result.attempt : null;
}

export async function loadTeacherAttempts(examId?: string): Promise<TeacherAttemptCollectionLoadResult> {
    const result = await listTeacherCanonicalAttempts(examId);
    if (result.status === "loaded") {
        return {
            items: result.attempts,
            remoteLoaded: true,
            remoteSynced: result.page?.partial !== true,
            pendingSyncCount: 0,
            remotePartial: result.page?.partial === true,
            remoteHasMore: result.page?.hasMore === true,
            remoteItemCount: result.page?.itemCount ?? result.attempts.length,
            remoteNextCursor: result.page?.nextCursor,
        };
    }
    if (result.status === "local_only") {
        const local = await loadAttempts();
        if (!examId?.trim()) return local;
        return { ...local, items: local.items.filter(attempt => attempt.examId === examId.trim()) };
    }
    return {
        items: [],
        remoteLoaded: false,
        remoteSynced: false,
        remoteError: result.status === "unauthorized"
            ? "Teacher server session is missing"
            : result.error || "Canonical attempt gateway unavailable",
    };
}

export async function loadTeacherAttemptSummaries(examId?: string): Promise<TeacherAttemptCollectionLoadResult> {
    const result = await listTeacherCanonicalAttemptSummaries(examId);
    if (result.status === "loaded") {
        return {
            items: result.attempts,
            remoteLoaded: true,
            remoteSynced: result.page?.partial !== true,
            pendingSyncCount: 0,
            remotePartial: result.page?.partial === true,
            remoteHasMore: result.page?.hasMore === true,
            remoteItemCount: result.page?.itemCount ?? result.attempts.length,
            remoteNextCursor: result.page?.nextCursor,
        };
    }
    if (result.status === "local_only") {
        const local = await loadAttempts();
        if (!examId?.trim()) return local;
        return { ...local, items: local.items.filter(attempt => attempt.examId === examId.trim()) };
    }
    return {
        items: [],
        remoteLoaded: false,
        remoteSynced: false,
        remoteError: result.status === "unauthorized"
            ? "Teacher server session is missing"
            : result.error || "Canonical attempt summary gateway unavailable",
    };
}

function remoteMutationError(result: { status: string; error?: string }): string {
    if (result.status === "unauthorized") return "Teacher server session is missing";
    if (result.status === "forbidden") return "Teacher role cannot change attempts";
    if (result.status === "not_found") return "Canonical attempt was not found";
    if (result.status === "invalid_request") return "Attempt mutation was invalid";
    return result.error || "Canonical attempt gateway unavailable";
}

function mutationLockError(error: unknown): string {
    return error instanceof Error ? error.message : "Attempt mutation lock failed";
}

async function withTeacherAttemptMutationLocks<T>(
    attemptIds: string[],
    operation: () => Promise<T>,
): Promise<T> {
    const ids = [...new Set(attemptIds.map(id => id.trim()).filter(Boolean))].sort();
    const acquire = (index: number): Promise<T> => {
        if (index >= ids.length) return operation();
        return withBrowserStorageLock(
            `teacher-attempt-mutation:${ids[index]}`,
            () => acquire(index + 1),
        );
    };
    return acquire(0);
}

interface LocalCacheWriteResult {
    localCacheSaved: boolean;
    cacheWarning?: string;
}

async function cacheCanonicalAttempt(attempt: Attempt): Promise<LocalCacheWriteResult> {
    try {
        const saved = await saveLocalAttempt(attempt);
        return saved
            ? { localCacheSaved: true }
            : { localCacheSaved: false, cacheWarning: "Canonical response could not be cached" };
    } catch (error) {
        return { localCacheSaved: false, cacheWarning: mutationLockError(error) };
    }
}

async function cacheCanonicalAttempts(attempts: Attempt[]): Promise<LocalCacheWriteResult> {
    const writes = await Promise.allSettled(attempts.map(saveLocalAttempt));
    const failure = writes.find(result => result.status === "rejected")
        || writes.find(result => result.status === "fulfilled" && !result.value);
    if (!failure) return { localCacheSaved: true };
    return {
        localCacheSaved: false,
        cacheWarning: failure.status === "rejected"
            ? mutationLockError(failure.reason)
            : "Canonical response could not be cached",
    };
}

export async function answerTeacherAttemptQuestion(
    attempt: Attempt,
    questionId: number,
    answer: string,
) {
    try {
        return await withTeacherAttemptMutationLocks([attempt.id], async () => {
            const result = await answerTeacherCanonicalAttemptQuestion(attempt.id, questionId, answer);
            if (result.status === "saved") {
                const cache = await cacheCanonicalAttempt(result.attempt);
                return {
                    localSaved: cache.localCacheSaved,
                    ...cache,
                    remoteSaved: true,
                    attempt: result.attempt,
                };
            }
            if (result.status === "local_only") {
                const latest = readLocalAttempts().find(item => item.id === attempt.id) || attempt;
                const updated = answerStudentQuestion(latest, questionId, answer, new Date().toISOString());
                if (!updated) {
                    return { localSaved: false, remoteSaved: false, remoteError: "Student question was not found" };
                }
                return {
                    localSaved: await saveLocalAttempt(updated),
                    remoteSaved: false,
                    attempt: updated,
                };
            }
            return {
                localSaved: false,
                remoteSaved: false,
                remoteError: remoteMutationError(result),
            };
        });
    } catch (error) {
        return {
            localSaved: false,
            remoteSaved: false,
            remoteError: mutationLockError(error),
        };
    }
}

export async function setTeacherAttemptSubquestionReview(
    attempt: Attempt,
    questionId: number,
    subquestionId: string,
    status: "needs_review" | "reviewed",
) {
    try {
        return await withTeacherAttemptMutationLocks([attempt.id], async () => {
            const result = await setTeacherCanonicalSubquestionReview(
                attempt.id,
                questionId,
                subquestionId,
                status,
            );
            if (result.status === "saved") {
                const cache = await cacheCanonicalAttempt(result.attempt);
                return {
                    localSaved: cache.localCacheSaved,
                    ...cache,
                    remoteSaved: true,
                    attempt: result.attempt,
                };
            }
            if (result.status === "local_only") {
                const latest = readLocalAttempts().find(item => item.id === attempt.id) || attempt;
                const current = latest.subQuestionAnswers?.[questionId]?.[subquestionId];
                if (!current) {
                    return { localSaved: false, remoteSaved: false, remoteError: "Subquestion answer was not found" };
                }
                const updated: Attempt = {
                    ...latest,
                    subQuestionAnswers: {
                        ...(latest.subQuestionAnswers || {}),
                        [questionId]: {
                            ...(latest.subQuestionAnswers?.[questionId] || {}),
                            [subquestionId]: {
                                ...current,
                                reviewStatus: status,
                                reviewedAt: status === "reviewed" ? new Date().toISOString() : undefined,
                                reviewedBy: undefined,
                            },
                        },
                    },
                };
                return {
                    localSaved: await saveLocalAttempt(updated),
                    remoteSaved: false,
                    attempt: updated,
                };
            }
            return {
                localSaved: false,
                remoteSaved: false,
                remoteError: remoteMutationError(result),
            };
        });
    } catch (error) {
        return {
            localSaved: false,
            remoteSaved: false,
            remoteError: mutationLockError(error),
        };
    }
}

export async function forceFinishTeacherAttempts(
    attempts: Attempt[],
    finishedAt: string,
) {
    try {
        return await withTeacherAttemptMutationLocks(attempts.map(attempt => attempt.id), async () => {
            const result = await forceFinishTeacherCanonicalAttempts(
                attempts.map(attempt => attempt.id),
                finishedAt,
            );
            if (result.status === "saved") {
                const cache = await cacheCanonicalAttempts(result.attempts);
                return {
                    localSaved: cache.localCacheSaved,
                    ...cache,
                    remoteSaved: true,
                    attempts: result.attempts,
                };
            }
            if (result.status === "local_only") {
                const latestById = new Map(readLocalAttempts().map(item => [item.id, item]));
                const completed = attempts.map(attempt => ({
                    ...(latestById.get(attempt.id) || attempt),
                    status: "completed" as const,
                    finishedAt,
                    autoSubmitted: true,
                }));
                const localResults = await Promise.all(completed.map(saveLocalAttempt));
                return {
                    localSaved: localResults.every(Boolean),
                    remoteSaved: false,
                    attempts: completed,
                };
            }
            return {
                localSaved: false,
                remoteSaved: false,
                attempts,
                remoteError: remoteMutationError(result),
            };
        });
    } catch (error) {
        return {
            localSaved: false,
            remoteSaved: false,
            attempts,
            remoteError: mutationLockError(error),
        };
    }
}

export async function forceFinishTeacherAttemptSessions(
    sessions: TeacherActiveAttemptSession[],
    finishedAt: string,
) {
    const result = await forceFinishTeacherCanonicalAttemptSessions(
        sessions.map(session => session.sessionId),
        finishedAt,
    );
    if (result.status === "saved") {
        const cache = await cacheCanonicalAttempts(result.attempts);
        return {
            localSaved: cache.localCacheSaved,
            ...cache,
            remoteSaved: true,
            attempts: result.attempts,
        };
    }
    return {
        localSaved: false,
        remoteSaved: false,
        attempts: [] as Attempt[],
        remoteError: remoteMutationError(result),
    };
}
