import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Attempt, Exam } from "@/types/omr";
import {
    cacheFreshTeacherDashboardOptional,
    buildTeacherDashboardDetailReset,
    buildTeacherDashboardReadyDetailSeed,
    isTeacherDashboardRemoteCollectionReady,
    materializeTeacherDashboardDegradedCache,
    publishTeacherDashboardCompletionIfCurrent,
    readTeacherDashboardDegradedCache,
    resolveTeacherDashboardSessionChange,
    sameTeacherLoadIdentity,
    sameTeacherSessionIdentity,
    toTeacherDashboardCacheProjection,
    type TeacherDashboardDegradedData,
    type TeacherLoadIdentity,
} from "./teacherDashboardCanonicalCache";
import { buildCanonicalSurfaceCacheKey, type CanonicalSurfaceCacheIdentity } from "./canonicalSurfaceCache";
import * as teacherDashboardCanonicalCache from "./teacherDashboardCanonicalCache";

function memoryStorage(initial: Record<string, string> = {}) {
    const data = { ...initial };
    return {
        getItem: (key: string) => data[key] ?? null,
        setItem: (key: string, value: string) => { data[key] = value; },
        removeItem: (key: string) => { delete data[key]; },
        data,
    };
}

const now = new Date("2026-08-09T12:00:00.000Z");
const staleAt = "2026-08-09T11:59:00.000Z";
const identity: TeacherLoadIdentity = {
    organizationId: "pilot_org_0123456789abcdef01234567",
    accountId: "teacher_0123456789abcdef",
    sessionGeneration: 4,
    requestGeneration: 9,
};

function exam(overrides: Partial<Exam> = {}): Exam {
    return {
        id: "exam-1",
        title: "가".repeat(1_000),
        questions: [{
            id: 1,
            number: 1,
            explanation: "private question body",
            choices: 4,
            answer: 1,
        }],
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z",
        archived: false,
        ...overrides,
    };
}

function attempt(overrides: Partial<Attempt> = {}): Attempt {
    return {
        id: "attempt-1",
        examId: "exam-1",
        examTitle: "must not repeat in attempt cache",
        studentProfileId: "profile-1",
        studentName: "🧑🏽‍🎓".repeat(1_000),
        startedAt: "2026-08-03T00:00:00.000Z",
        finishedAt: "2026-08-03T01:00:00.000Z",
        score: 80,
        totalScore: 100,
        answers: { 1: 1 },
        drawings: { 1: ["private handwriting payload"] },
        studentQuestions: [{
            questionId: 1,
            questionNumber: 1,
            body: "private feedback body",
            createdAt: "2026-08-03T01:00:00.000Z",
            status: "queued",
        }],
        status: "completed",
        ...overrides,
    };
}

describe("teacher dashboard canonical cache", () => {
    const dashboardPageSource = readFileSync(
        new URL("../app/teacher/dashboard/page.tsx", import.meta.url),
        "utf8",
    );

    it("invalidates live repair and detail continuations synchronously when capability changes", () => {
        const runtime = teacherDashboardCanonicalCache as typeof teacherDashboardCanonicalCache & {
            canContinueTeacherDashboardRepair?: (
                captured: TeacherLoadIdentity,
                live: { loadState: string; identity: TeacherLoadIdentity | null },
            ) => boolean;
            canContinueTeacherDashboardDetail?: (
                captured: TeacherLoadIdentity,
                live: { loadState: string; identity: TeacherLoadIdentity | null },
            ) => boolean;
        };
        expect(runtime.canContinueTeacherDashboardRepair).toBeTypeOf("function");
        expect(runtime.canContinueTeacherDashboardDetail).toBeTypeOf("function");
        if (!runtime.canContinueTeacherDashboardRepair || !runtime.canContinueTeacherDashboardDetail) return;

        const live = { loadState: "loaded_data", identity: { ...identity } };
        expect(runtime.canContinueTeacherDashboardRepair(identity, live)).toBe(true);
        expect(runtime.canContinueTeacherDashboardDetail(identity, live)).toBe(true);
        live.loadState = "degraded_with_cache";
        expect(runtime.canContinueTeacherDashboardRepair(identity, live)).toBe(false);
        expect(runtime.canContinueTeacherDashboardDetail(identity, live)).toBe(false);
        live.loadState = "loaded_data";
        live.identity = { ...identity, requestGeneration: identity.requestGeneration + 1 };
        expect(runtime.canContinueTeacherDashboardRepair(identity, live)).toBe(true);
        expect(runtime.canContinueTeacherDashboardDetail(identity, live)).toBe(false);
    });

    it("releases a same-session repair spinner across unavailable and fresh recovery states", () => {
        const runtime = teacherDashboardCanonicalCache as typeof teacherDashboardCanonicalCache & {
            canReleaseTeacherDashboardRepair?: (
                captured: TeacherLoadIdentity,
                live: { loadState: string; identity: TeacherLoadIdentity | null },
            ) => boolean;
        };
        expect(runtime.canReleaseTeacherDashboardRepair).toBeTypeOf("function");
        if (!runtime.canReleaseTeacherDashboardRepair) return;

        let isRepairing = true;
        const live = {
            loadState: "error_without_cache",
            identity: { ...identity, requestGeneration: identity.requestGeneration + 1 },
        };
        if (runtime.canReleaseTeacherDashboardRepair(identity, live)) isRepairing = false;
        live.loadState = "loaded_data";
        live.identity = { ...identity, requestGeneration: identity.requestGeneration + 2 };
        expect(isRepairing).toBe(false);
        expect(runtime.canReleaseTeacherDashboardRepair(identity, live)).toBe(true);
        expect(runtime.canReleaseTeacherDashboardRepair(identity, {
            ...live,
            identity: { ...live.identity, sessionGeneration: identity.sessionGeneration + 1 },
        })).toBe(false);
    });

    it("prevents an invalidated repair A from resuming or releasing repair B after loaded-state recovery", () => {
        type FenceState = { capabilityEpoch: number; nextToken: number; activeToken: number | null };
        type Operation = { capabilityEpoch: number; token: number };
        const runtime = teacherDashboardCanonicalCache as typeof teacherDashboardCanonicalCache & {
            beginTeacherDashboardRepairOperation?: (state: FenceState) => { state: FenceState; operation: Operation };
            invalidateTeacherDashboardRepairCapability?: (state: FenceState) => FenceState;
            canContinueTeacherDashboardRepairOperation?: (operation: Operation, state: FenceState) => boolean;
            canReleaseTeacherDashboardRepairOperation?: (operation: Operation, state: FenceState) => boolean;
        };
        expect(runtime.beginTeacherDashboardRepairOperation).toBeTypeOf("function");
        expect(runtime.invalidateTeacherDashboardRepairCapability).toBeTypeOf("function");
        expect(runtime.canContinueTeacherDashboardRepairOperation).toBeTypeOf("function");
        expect(runtime.canReleaseTeacherDashboardRepairOperation).toBeTypeOf("function");
        if (!runtime.beginTeacherDashboardRepairOperation
            || !runtime.invalidateTeacherDashboardRepairCapability
            || !runtime.canContinueTeacherDashboardRepairOperation
            || !runtime.canReleaseTeacherDashboardRepairOperation) return;

        let fence: FenceState = { capabilityEpoch: 0, nextToken: 0, activeToken: null };
        const repairA = runtime.beginTeacherDashboardRepairOperation(fence);
        fence = repairA.state;
        expect(runtime.canContinueTeacherDashboardRepairOperation(repairA.operation, fence)).toBe(true);

        fence = runtime.invalidateTeacherDashboardRepairCapability(fence);
        expect(runtime.canContinueTeacherDashboardRepairOperation(repairA.operation, fence)).toBe(false);
        const repairB = runtime.beginTeacherDashboardRepairOperation(fence);
        fence = repairB.state;
        expect(repairB.operation.token).toBeGreaterThan(repairA.operation.token);
        expect(repairB.operation.capabilityEpoch).toBeGreaterThan(repairA.operation.capabilityEpoch);
        expect(runtime.canContinueTeacherDashboardRepairOperation(repairB.operation, fence)).toBe(true);

        let staleWrites = 0;
        let staleStatePublications = 0;
        let staleToasts = 0;
        let isRepairing = true;
        if (runtime.canContinueTeacherDashboardRepairOperation(repairA.operation, fence)) {
            staleWrites += 1;
            staleStatePublications += 1;
            staleToasts += 1;
        }
        if (runtime.canReleaseTeacherDashboardRepairOperation(repairA.operation, fence)) {
            staleStatePublications += 1;
            isRepairing = false;
        }
        expect({ staleWrites, staleStatePublications, staleToasts, isRepairing }).toEqual({
            staleWrites: 0,
            staleStatePublications: 0,
            staleToasts: 0,
            isRepairing: true,
        });
        expect(runtime.canReleaseTeacherDashboardRepairOperation(repairB.operation, fence)).toBe(true);
    });

    it("projects redacted summaries without mutating rich fresh records", () => {
        const richExam = exam();
        const richAttempt = attempt();

        const projection = toTeacherDashboardCacheProjection([richExam], [richAttempt]);

        expect(richExam.questions[0].explanation).toBe("private question body");
        expect(richAttempt.answers).toEqual({ 1: 1 });
        expect(projection).toMatchObject({
            exams: [{ id: "exam-1", status: "active", questionCount: 1, attemptCount: 1 }],
            attempts: [{ id: "attempt-1", examId: "exam-1", studentId: "profile-1", status: "completed" }],
        });
        const serialized = JSON.stringify(projection);
        for (const secret of ["questions", "answers", "question body", "answer", "drawings", "handwriting", "feedback body", "examTitle"]) {
            expect(serialized.toLowerCase()).not.toContain(secret.toLowerCase());
        }
        expect(projection.exams[0].title.endsWith("…")).toBe(true);
        expect(projection.attempts[0].studentName.endsWith("…")).toBe(true);
    });

    it("uses only stable source identity and preserves a missing student id as null", () => {
        expect(toTeacherDashboardCacheProjection([exam()], [attempt({
            studentProfileId: undefined,
            studentId: undefined,
            guestId: undefined,
        })]).attempts[0].studentId).toBeNull();
        expect(toTeacherDashboardCacheProjection([exam()], [attempt({
            studentProfileId: undefined,
            studentId: undefined,
            guestId: "guest-1",
        })]).attempts[0].studentId).toBe("guest-1");
    });

    it("does not let projection or storage failure alter fresh rich data", () => {
        const richExams = [exam()];
        const richAttempts = [attempt()];
        const throwingStorage = {
            getItem: () => null,
            setItem: () => { throw new Error("quota provider detail"); },
            removeItem: () => undefined,
        };

        expect(cacheFreshTeacherDashboardOptional(
            throwingStorage,
            identity,
            staleAt,
            richExams,
            richAttempts,
            now,
        )).toBe(false);
        expect(richExams[0].questions).toHaveLength(1);
        expect(richAttempts[0].answers).toEqual({ 1: 1 });

        const accessorExam = Object.defineProperty(exam(), "title", { enumerable: true, get() { throw new Error("mutation"); } });
        expect(cacheFreshTeacherDashboardOptional(
            memoryStorage(), identity, staleAt, [accessorExam], richAttempts, now,
        )).toBe(false);
        expect(richAttempts[0].answers).toEqual({ 1: 1 });
    });

    it("round trips only an exact scoped cache into a distinct degraded view", () => {
        const storage = memoryStorage();
        expect(cacheFreshTeacherDashboardOptional(storage, identity, staleAt, [exam()], [attempt()], now)).toBe(true);

        const degraded = readTeacherDashboardDegradedCache(storage, identity, now);

        expect(degraded).toMatchObject({
            kind: "teacher_dashboard_degraded",
            staleAt,
            exams: [{ kind: "degraded_exam_summary", id: "exam-1" }],
            attempts: [{ kind: "degraded_attempt_summary", id: "attempt-1" }],
        });
        expectTypeOf(degraded).toEqualTypeOf<TeacherDashboardDegradedData | null>();
        expectTypeOf(degraded?.exams).not.toMatchTypeOf<Exam[]>();
        expectTypeOf(degraded?.attempts).not.toMatchTypeOf<Attempt[]>();
        expect(degraded?.exams[0]).not.toHaveProperty("questions");
        expect(degraded?.attempts[0]).not.toHaveProperty("answers");

        for (const mismatch of [
            { organizationId: "pilot_org_fedcba9876543210fedcba98" },
            { accountId: "teacher_fedcba9876543210" },
            { sessionGeneration: 5 },
        ]) {
            expect(readTeacherDashboardDegradedCache(storage, { ...identity, ...mismatch }, now)).toBeNull();
        }
    });

    it("materializes cache data without making it rich or mutable", () => {
        const projection = toTeacherDashboardCacheProjection([exam()], [attempt()]);
        const degraded = materializeTeacherDashboardDegradedCache(projection, staleAt);
        expect(Object.isFrozen(degraded)).toBe(true);
        expect(Object.isFrozen(degraded.exams[0])).toBe(true);
        expect(Object.isFrozen(degraded.attempts[0])).toBe(true);
    });

    it("requires the complete org/account/session/request identity for summary publication", () => {
        for (const mismatch of [
            { organizationId: "pilot_org_fedcba9876543210fedcba98" },
            { accountId: "teacher_fedcba9876543210" },
            { sessionGeneration: 5 },
            { requestGeneration: 10 },
        ]) {
            const publishState = vi.fn();
            const persistCache = vi.fn();
            const current = { ...identity, ...mismatch };
            expect(sameTeacherLoadIdentity(identity, current)).toBe(false);
            expect(publishTeacherDashboardCompletionIfCurrent(identity, current, { publishState, persistCache })).toBe(false);
            expect(publishState).not.toHaveBeenCalled();
            expect(persistCache).not.toHaveBeenCalled();
        }
    });

    it("fences detailed-attempt completion with the same complete identity", () => {
        const publishState = vi.fn();
        const persistCache = vi.fn();
        expect(publishTeacherDashboardCompletionIfCurrent(identity, { ...identity, requestGeneration: 10 }, {
            publishState,
            persistCache,
        })).toBe(false);
        expect(publishState).not.toHaveBeenCalled();
        expect(persistCache).not.toHaveBeenCalled();
    });

    it("keeps repair tenant ownership but rejects a prior detail request after a dashboard refresh", () => {
        const refreshed = { ...identity, requestGeneration: identity.requestGeneration + 1 };
        expect(sameTeacherLoadIdentity(identity, refreshed)).toBe(false);
        expect(sameTeacherSessionIdentity(identity, refreshed)).toBe(true);
        expect(sameTeacherSessionIdentity(identity, {
            ...refreshed,
            sessionGeneration: identity.sessionGeneration + 1,
        })).toBe(false);
    });

    it("resets stale detail loading at N+1 and then seeds a terminal ready full snapshot", () => {
        const refreshed = { ...identity, requestGeneration: identity.requestGeneration + 1 };
        const reset = buildTeacherDashboardDetailReset(7);
        expect(reset).toEqual({
            generation: 8,
            items: null,
            loadStatus: "idle",
            sampleStatus: "ready",
        });
        if (!reset) throw new Error("expected a valid detail reset");
        expect(sameTeacherLoadIdentity(identity, refreshed)).toBe(false);

        const seed = buildTeacherDashboardReadyDetailSeed(refreshed, refreshed, reset.generation, {
            items: [attempt()],
            remoteLoaded: true,
            remoteSynced: true,
            meta: { organizationId: identity.organizationId },
        });
        expect(seed).toMatchObject({ generation: 9, loadStatus: "ready", sampleStatus: "ready" });
        expect(seed?.items[0].answers).toEqual({ 1: 1 });
    });

    it("builds a terminal ready detail seed only from the current exact complete fresh collection", () => {
        const richAttempt = attempt();
        const readyResult = {
            items: [richAttempt],
            remoteLoaded: true,
            remoteSynced: true,
            meta: { organizationId: identity.organizationId },
        };

        const seed = buildTeacherDashboardReadyDetailSeed(identity, identity, 7, readyResult);
        expect(seed).toEqual({
            generation: 8,
            items: [richAttempt],
            loadStatus: "ready",
            sampleStatus: "ready",
        });
        expect(seed?.items[0].answers).toEqual({ 1: 1 });

        for (const rejected of [
            { ...readyResult, remotePartial: true },
            { ...readyResult, remoteSynced: false },
            { ...readyResult, remoteSynced: undefined },
            { ...readyResult, remoteLoaded: false },
            { ...readyResult, remoteError: "stale" },
        ]) {
            expect(buildTeacherDashboardReadyDetailSeed(identity, identity, 7, rejected)).toBeNull();
        }
        expect(buildTeacherDashboardReadyDetailSeed(
            identity,
            { ...identity, requestGeneration: identity.requestGeneration + 1 },
            7,
            readyResult,
        )).toBeNull();
    });

    it("fails closed for partial, unsynced, unloaded, errored, or wrong-tenant remote collections", () => {
        const ready = {
            remoteLoaded: true,
            remoteSynced: true,
            meta: { organizationId: identity.organizationId },
        };
        expect(isTeacherDashboardRemoteCollectionReady(ready, identity.organizationId)).toBe(true);
        for (const rejected of [
            { ...ready, remotePartial: true },
            { ...ready, remoteSynced: false },
            { ...ready, remoteSynced: undefined },
            { ...ready, remoteLoaded: false },
            { ...ready, remoteError: "incomplete" },
            { ...ready, meta: { organizationId: "pilot_org_fedcba9876543210fedcba98" } },
        ]) {
            expect(isTeacherDashboardRemoteCollectionReady(rejected, identity.organizationId)).toBe(false);
        }
    });

    it("routes account, mockup, and logout session changes without using a stale render mode", () => {
        expect(resolveTeacherDashboardSessionChange(false, { isMockup: true, hasCanonicalIdentity: false }))
            .toBe("mode_changed");
        expect(resolveTeacherDashboardSessionChange(true, { isMockup: false, hasCanonicalIdentity: true }))
            .toBe("mode_changed");
        expect(resolveTeacherDashboardSessionChange(false, { isMockup: false, hasCanonicalIdentity: true }))
            .toBe("reload");
        expect(resolveTeacherDashboardSessionChange(true, { isMockup: true, hasCanonicalIdentity: false }))
            .toBe("reload");
        expect(resolveTeacherDashboardSessionChange(false, { isMockup: false, hasCanonicalIdentity: false }))
            .toBe("unavailable");
        expect(resolveTeacherDashboardSessionChange(true, { isMockup: false, hasCanonicalIdentity: false }))
            .toBe("unavailable");
    });

    it("publishes and persists exactly once when the complete identity is current", () => {
        const publishState = vi.fn();
        const persistCache = vi.fn();
        expect(publishTeacherDashboardCompletionIfCurrent(identity, { ...identity }, { publishState, persistCache })).toBe(true);
        expect(publishState).toHaveBeenCalledTimes(1);
        expect(persistCache).toHaveBeenCalledTimes(1);
    });

    it("uses the exact dashboard cache key owned by Task 2", () => {
        const storage = memoryStorage();
        expect(cacheFreshTeacherDashboardOptional(storage, identity, staleAt, [exam()], [attempt()], now)).toBe(true);
        const cacheIdentity: CanonicalSurfaceCacheIdentity = {
            surface: "teacher_dashboard",
            organizationId: identity.organizationId,
            accountId: identity.accountId,
            sessionGeneration: identity.sessionGeneration,
        };
        expect(storage.data[buildCanonicalSurfaceCacheKey(cacheIdentity)]).toBeDefined();
    });

    it("feeds summary-only fresh attempts into dashboard state and keeps rich rows detail-on-demand", () => {
        const loadStart = dashboardPageSource.indexOf("const loadDashboardData = useCallback");
        const loadEnd = dashboardPageSource.indexOf("// Initial dashboard load", loadStart);
        const loadSource = dashboardPageSource.slice(loadStart, loadEnd);

        expect(loadSource).toContain("loadTeacherAttemptSummaries(),");
        expect(loadSource).not.toContain("loadTeacherAttempts(),");
        expect(loadSource).toContain("applyDashboardSnapshot(nextState.data)");
        expect(loadSource).toContain("successfulSnapshot.attempts");
        expect(loadSource).toContain("cacheFreshTeacherDashboardOptional(");
        expect(loadSource).not.toContain("seedDetailedAttemptsFromFresh(detailSeed)");

        const projection = JSON.stringify(toTeacherDashboardCacheProjection([exam()], [attempt()]));
        expect(projection).not.toContain("private question body");
        expect(projection).not.toContain("private handwriting payload");
        expect(projection).not.toContain("private feedback body");
    });

    it("uses a lock-aware identity predicate for every analytics repair write", () => {
        const repairStart = dashboardPageSource.indexOf("const handleRepairAnalyticsData");
        const repairEnd = dashboardPageSource.indexOf("const syncTone", repairStart);
        const repairSource = dashboardPageSource.slice(repairStart, repairEnd);

        expect(repairSource).toContain("const repairIdentity = teacherLoadIdentityRef.current");
        expect(repairSource).toContain("const repairOwnerIsCurrent = () => canReleaseTeacherDashboardRepair(");
        expect(repairSource).toContain("const repairIsCurrent = () => canContinueTeacherDashboardRepair(");
        expect(repairSource).toContain("saveLocalAttemptIfCurrent(");
        expect(repairSource).toContain("() => repairIsCurrent()");
        expect(repairSource).toMatch(/await saveLocalAttemptIfCurrent[\s\S]*if \(!repairIsCurrent\(\)\) return;/);
        expect(repairSource).toMatch(/finally \{[\s\S]*if \(canReleaseTeacherDashboardRepairOperation\([\s\S]*repairOperation[\s\S]*teacherDashboardRepairOperationRef\.current[\s\S]*&& repairOwnerIsCurrent\(\)\)[\s\S]*setIsRepairingAnalyticsData\(false\)/);
    });

    it("does not seed rich detail from summaries and still fences explicit detail-on-demand", () => {
        const loadStart = dashboardPageSource.indexOf("const loadDashboardData = useCallback");
        const loadEnd = dashboardPageSource.indexOf("// Initial dashboard load", loadStart);
        const loadSource = dashboardPageSource.slice(loadStart, loadEnd);

        expect(loadSource).toContain("isTeacherDashboardRemoteCollectionReady(examResult");
        expect(loadSource).toContain("isTeacherDashboardRemoteCollectionReady(attemptResult");
        expect(loadSource).toContain("isTeacherDashboardRemoteCollectionReady(rosterResult");
        expect(loadSource).not.toContain("buildTeacherDashboardReadyDetailSeed(");
        expect(loadSource).not.toContain("seedDetailedAttemptsFromFresh(detailSeed)");
        expect(dashboardPageSource).toContain("resetDetailedAttemptsForDashboardRequest(");
        const detailStart = dashboardPageSource.indexOf("const loadDetailedAttempts = useCallback");
        const detailEnd = dashboardPageSource.indexOf("useEffect(() =>", detailStart);
        const detailSource = dashboardPageSource.slice(detailStart, detailEnd);
        expect(detailSource).toContain("const requestedLoadIdentity = teacherLoadIdentityRef.current");
        expect(detailSource).toContain("isCurrentTeacherLoadIdentity(requestedLoadIdentity)");
        expect(detailSource).toContain("sameTeacherLoadIdentity(activeLoad.identity, requestedLoadIdentity)");
    });

    it("subscribes to the synchronous same-document session identity seam", () => {
        expect(dashboardPageSource).toContain("TEACHER_SESSION_IDENTITY_CHANGED_EVENT");
        expect(dashboardPageSource).toContain('window.addEventListener(TEACHER_SESSION_IDENTITY_CHANGED_EVENT');
        expect(dashboardPageSource).toMatch(/TEACHER_SESSION_IDENTITY_CHANGED_EVENT[\s\S]*clearDashboardVisibleState\(\)[\s\S]*invalidateDetailedAttempts\(\)/);
    });

    it("bypasses the revalidation throttle for cross-document session changes and recomputes account mode", () => {
        expect(dashboardPageSource).toContain("const handleTeacherSessionIdentityChanged = useCallback");
        expect(dashboardPageSource).toContain("setIsMockupAccount(nextIsMockupAccount)");
        expect(dashboardPageSource).toContain("resolveTeacherDashboardSessionChange(");
        expect(dashboardPageSource).toMatch(/if \(sessionIdentityChanged\) \{\s*handleTeacherSessionIdentityChanged\(\);\s*return;\s*\}/);
        expect(dashboardPageSource).toContain(
            "window.addEventListener(TEACHER_SESSION_IDENTITY_CHANGED_EVENT, handleTeacherSessionIdentityChanged)",
        );
    });
});
