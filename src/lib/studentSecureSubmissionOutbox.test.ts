import { describe, expect, it, vi } from "vitest";
import type { ServerGradedAttemptReceipt } from "./studentExamContract";
import {
    MAX_SECURE_SUBMISSION_OUTBOX_BYTES,
    MAX_SECURE_SUBMISSION_RECORD_BYTES,
    SECURE_SUBMISSION_OUTBOX_LIMIT,
    SECURE_SUBMISSION_TTL_MS,
    createMemorySecureSubmissionStore,
    acknowledgeSecureSubmissionRecoveryNotice,
    maintainSecureSubmissionOutbox,
    queueSecureSubmission,
    readSecureSubmission,
    readSecureSubmissionRecoveryNotices,
    replaySecureSubmissionsForOwner,
    type SecureSubmissionOutboxLock,
    type SecureSubmissionSnapshot,
} from "./studentSecureSubmissionOutbox";

const NOW = Date.parse("2026-08-07T12:00:00.000Z");
const OWNER_A = "a".repeat(64);
const OWNER_B = "b".repeat(64);

function snapshot(overrides: Partial<SecureSubmissionSnapshot> = {}): SecureSubmissionSnapshot {
    return {
        sessionId: "session-1",
        examId: "exam-1",
        expectedRevision: 3,
        expectedLeaseEpoch: 2,
        leaseToken: "lease-secret",
        answers: { 1: 2 },
        subQuestionAnswers: {},
        progressPayload: { currentQuestionId: 1 },
        autoSubmitted: false,
        tabFociLostCount: 0,
        questionTimings: [],
        focusLossEvents: [],
        finishedAt: "2026-08-07T12:00:00.000Z",
        ...overrides,
    };
}

function legacySnapshot(value: SecureSubmissionSnapshot): Omit<
    SecureSubmissionSnapshot,
    "examId" | "assignmentId" | "assignmentRevision"
> {
    const copy = { ...value } as Partial<SecureSubmissionSnapshot>;
    delete copy.examId;
    delete copy.assignmentId;
    delete copy.assignmentRevision;
    return copy as Omit<SecureSubmissionSnapshot, "examId" | "assignmentId" | "assignmentRevision">;
}

function legacyRecord(record: NonNullable<Awaited<ReturnType<typeof readSecureSubmission>>>) {
    const legacy = legacySnapshot(record.snapshot);
    return {
        ...record,
        schemaVersion: 1 as const,
        byteLength: new TextEncoder().encode(JSON.stringify(legacy)).byteLength,
        snapshot: legacy,
    };
}

const receipt: ServerGradedAttemptReceipt = {
    attemptId: "attempt-1",
    examId: "exam-1",
    score: 1,
    totalScore: 1,
    correctCount: 1,
    incorrectCount: 0,
    unansweredCount: 0,
    ungradedCount: 0,
    finishedAt: "2026-08-07T12:00:00.000Z",
    questionResults: [],
};

describe("secure submission outbox", () => {
    it("rejects an assignment id without its exact generation", async () => {
        const store = createMemorySecureSubmissionStore();
        await expect(queueSecureSubmission(OWNER_A, snapshot({
            assignmentId: "assignment-reused",
            assignmentRevision: undefined,
        }), { store, now: NOW })).resolves.toEqual({ status: "invalid" });
        expect(await store.list()).toEqual([]);
    });

    it("keeps an immutable first snapshot for the session id", async () => {
        const store = createMemorySecureSubmissionStore();
        await expect(queueSecureSubmission(OWNER_A, snapshot(), { store, now: NOW }))
            .resolves.toMatchObject({ status: "queued" });
        await expect(queueSecureSubmission(OWNER_A, snapshot({ answers: { 1: 5 } }), { store, now: NOW + 1 }))
            .resolves.toEqual({ status: "conflict" });

        expect((await readSecureSubmission("session-1", { store }))?.snapshot.answers).toEqual({ 1: 2 });
        const persisted = JSON.stringify(await store.list());
        expect(persisted).not.toContain("attemptTicket");
        expect(persisted).not.toContain("studentName");
        expect(persisted).not.toContain("pdfData");
        expect(persisted).not.toContain("drawings");
    });

    it("rejects oversize, count, and total capacity without evicting live records", async () => {
        const store = createMemorySecureSubmissionStore();
        const oversized = snapshot({
            subQuestionAnswers: { 1: { essay: { schemaVersion: 1, body: "x".repeat(MAX_SECURE_SUBMISSION_RECORD_BYTES), reviewStatus: "needs_review" } } },
        });
        await expect(queueSecureSubmission(OWNER_A, oversized, { store, now: NOW }))
            .resolves.toEqual({ status: "record_too_large" });

        for (let index = 0; index < SECURE_SUBMISSION_OUTBOX_LIMIT; index += 1) {
            await expect(queueSecureSubmission(OWNER_A, snapshot({ sessionId: `session-${index}` }), { store, now: NOW }))
                .resolves.toMatchObject({ status: "queued" });
        }
        await expect(queueSecureSubmission(OWNER_A, snapshot({ sessionId: "session-overflow" }), { store, now: NOW }))
            .resolves.toEqual({ status: "capacity_exceeded" });
        expect((await store.list()).length).toBe(SECURE_SUBMISSION_OUTBOX_LIMIT);

        const totalStore = createMemorySecureSubmissionStore();
        const body = "x".repeat(Math.floor(MAX_SECURE_SUBMISSION_OUTBOX_BYTES / 5));
        for (let index = 0; index < 4; index += 1) {
            await queueSecureSubmission(OWNER_A, snapshot({
                sessionId: `large-${index}`,
                subQuestionAnswers: { 1: { essay: { schemaVersion: 1, body, reviewStatus: "needs_review" } } },
            }), { store: totalStore, now: NOW });
        }
        await expect(queueSecureSubmission(OWNER_A, snapshot({
            sessionId: "large-final",
            subQuestionAnswers: { 1: { essay: { schemaVersion: 1, body, reviewStatus: "needs_review" } } },
        }), { store: totalStore, now: NOW })).resolves.toEqual({ status: "capacity_exceeded" });
    });

    it("reports expired cleanup and never sends expired payloads", async () => {
        const store = createMemorySecureSubmissionStore();
        await queueSecureSubmission(OWNER_A, snapshot(), { store, now: NOW });
        const submit = vi.fn();

        await expect(maintainSecureSubmissionOutbox({ store, now: NOW + SECURE_SUBMISSION_TTL_MS + 1 }))
            .resolves.toEqual({ expiredCount: 1, invalidCount: 0 });
        const notices = await readSecureSubmissionRecoveryNotices({ store });
        expect(notices).toEqual([expect.objectContaining({ kind: "expired", sessionId: "session-1" })]);
        expect(JSON.stringify(notices)).not.toContain("lease-secret");
        expect(JSON.stringify(notices)).not.toContain('"answers"');
        await acknowledgeSecureSubmissionRecoveryNotice(notices[0].id, { store });
        expect(await readSecureSubmissionRecoveryNotices({ store })).toEqual([]);
        await expect(replaySecureSubmissionsForOwner(OWNER_A, { checkpoint: vi.fn(), submit }, {
            store,
            now: NOW + SECURE_SUBMISSION_TTL_MS + 1,
        })).resolves.toMatchObject({ status: "empty" });
        expect(submit).not.toHaveBeenCalled();
    });

    it("writes a non-sensitive notice before removing a malformed record", async () => {
        const store = createMemorySecureSubmissionStore();
        await store.put({ id: "session-corrupt", snapshot: { leaseToken: "must-not-leak" } } as never);

        await expect(maintainSecureSubmissionOutbox({ store, now: NOW }))
            .resolves.toEqual({ expiredCount: 0, invalidCount: 1 });
        const notices = await readSecureSubmissionRecoveryNotices({ store });
        expect(notices).toEqual([expect.objectContaining({ kind: "invalid", sessionId: "session-corrupt" })]);
        expect(JSON.stringify(notices)).not.toContain("must-not-leak");
        expect(await store.list()).toEqual([]);
    });

    it("bounds recovery notices while recording a new expiry before deleting its payload", async () => {
        const store = createMemorySecureSubmissionStore();
        for (let index = 0; index < 20; index += 1) {
            await store.putNotice({
                id: `notice-${index}`,
                kind: "invalid",
                sessionId: `old-${index}`,
                createdAt: new Date(NOW + index).toISOString(),
            });
        }
        await queueSecureSubmission(OWNER_A, snapshot(), { store, now: NOW });

        await maintainSecureSubmissionOutbox({ store, now: NOW + SECURE_SUBMISSION_TTL_MS + 1 });

        const notices = await readSecureSubmissionRecoveryNotices({ store });
        expect(notices).toHaveLength(20);
        expect(notices.some(notice => notice.kind === "expired" && notice.sessionId === "session-1")).toBe(true);
        expect(notices.some(notice => notice.id === "notice-0")).toBe(false);
        expect(await store.list()).toEqual([]);
    });

    it("replays only the active owner and clears on the canonical submitted receipt", async () => {
        const store = createMemorySecureSubmissionStore();
        await queueSecureSubmission(OWNER_A, snapshot({
            assignmentId: "assignment-reused",
            assignmentRevision: 8,
        }), { store, now: NOW });
        const checkpoint = vi.fn(async () => ({
            status: "active" as const,
            session: { revision: 4, leaseEpoch: 2 },
        }));
        const submit = vi.fn(async () => ({ status: "submitted" as const, receipt }));

        await expect(replaySecureSubmissionsForOwner(OWNER_B, { checkpoint, submit }, { store, now: NOW }))
            .resolves.toEqual({ status: "empty", submitted: [] });
        await expect(replaySecureSubmissionsForOwner(OWNER_A, { checkpoint, submit }, { store, now: NOW }))
            .resolves.toEqual({ status: "submitted", submitted: [receipt] });
        expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({
            examId: "exam-1",
            assignmentId: "assignment-reused",
            assignmentRevision: 8,
            expectedRevision: 3,
            leaseToken: "lease-secret",
            finalCheckpoint: true,
        }));
        expect(submit).toHaveBeenCalledWith(expect.objectContaining({
            examId: "exam-1",
            assignmentId: "assignment-reused",
            assignmentRevision: 8,
            expectedRevision: 4,
            leaseToken: "lease-secret",
        }));
        expect(await store.list()).toEqual([]);
    });

    it("recovers an exact-owner legacy public/group row and replays it without deleting offline answers", async () => {
        const store = createMemorySecureSubmissionStore();
        await queueSecureSubmission(OWNER_A, snapshot(), { store, now: NOW });
        const record = await readSecureSubmission("session-1", { store });
        await store.put(legacyRecord(record!) as never);
        const resolveLegacyScope = vi.fn(async () => ({ status: "resolved" as const, examId: "exam-1" }));
        const checkpoint = vi.fn(async () => ({
            status: "active" as const,
            session: { revision: 4, leaseEpoch: 2 },
        }));
        const submit = vi.fn(async () => ({ status: "submitted" as const, receipt }));

        await expect(maintainSecureSubmissionOutbox({ store, now: NOW }))
            .resolves.toEqual({ expiredCount: 0, invalidCount: 0 });
        expect(await store.list()).toHaveLength(1);
        await expect(replaySecureSubmissionsForOwner(OWNER_A, { resolveLegacyScope, checkpoint, submit }, { store, now: NOW }))
            .resolves.toEqual({ status: "submitted", submitted: [receipt] });
        expect(resolveLegacyScope).toHaveBeenCalledWith({ sessionId: "session-1" });
        expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: "session-1",
            examId: "exam-1",
            assignmentId: undefined,
            assignmentRevision: undefined,
        }));
        expect(await store.list()).toEqual([]);
    });

    it("re-reads a legacy row under the cross-document lock before replacing it", async () => {
        const store = createMemorySecureSubmissionStore();
        await queueSecureSubmission(OWNER_A, snapshot(), { store, now: NOW });
        const current = await readSecureSubmission("session-1", { store });
        expect(current).not.toBeNull();
        await store.put(legacyRecord(current!) as never);
        const concurrentlyClaimed = {
            ...current!,
            state: "blocked" as const,
            blockReason: "revision_conflict" as const,
            replayClaim: { id: "other-document", expiresAt: new Date(NOW + 30_000).toISOString() },
        };
        let lockCalls = 0;
        const lock: SecureSubmissionOutboxLock = async operation => {
            lockCalls += 1;
            return operation();
        };
        const replaceLegacy = vi.spyOn(store, "replaceLegacy");
        const checkpoint = vi.fn();

        await expect(replaySecureSubmissionsForOwner(OWNER_A, {
            resolveLegacyScope: vi.fn(async () => {
                await store.put(concurrentlyClaimed);
                return { status: "resolved" as const, examId: "exam-1" };
            }),
            checkpoint,
            submit: vi.fn(),
        }, { store, lock, now: NOW })).resolves.toMatchObject({ status: "blocked" });

        expect(lockCalls).toBeGreaterThan(0);
        expect(replaceLegacy).toHaveBeenCalledTimes(1);
        expect(checkpoint).not.toHaveBeenCalled();
        expect(await store.list()).toEqual([concurrentlyClaimed]);
    });

    it("retains a legacy snapshot at the exact 512 KiB snapshot bound despite bounded envelope overhead", async () => {
        const store = createMemorySecureSubmissionStore();
        const bounded = legacySnapshot(snapshot());
        bounded.progressPayload = { body: "" };
        const encoder = new TextEncoder();
        const baseBytes = encoder.encode(JSON.stringify(bounded)).byteLength;
        bounded.progressPayload = { body: "x".repeat(MAX_SECURE_SUBMISSION_RECORD_BYTES - baseBytes) };
        expect(encoder.encode(JSON.stringify(bounded)).byteLength).toBe(MAX_SECURE_SUBMISSION_RECORD_BYTES);
        const legacy = {
            schemaVersion: 1,
            id: "session-1",
            ownerFingerprint: OWNER_A,
            createdAt: new Date(NOW).toISOString(),
            expiresAt: new Date(NOW + SECURE_SUBMISSION_TTL_MS).toISOString(),
            byteLength: MAX_SECURE_SUBMISSION_RECORD_BYTES,
            state: "queued",
            retryCount: 0,
            nextAttemptAt: new Date(NOW).toISOString(),
            snapshot: bounded,
        };
        expect(encoder.encode(JSON.stringify(legacy)).byteLength).toBeGreaterThan(MAX_SECURE_SUBMISSION_RECORD_BYTES);
        await store.put(legacy as never);

        await expect(maintainSecureSubmissionOutbox({ store, now: NOW }))
            .resolves.toEqual({ expiredCount: 0, invalidCount: 0 });
        expect(await store.list()).toEqual([legacy]);

        await expect(replaySecureSubmissionsForOwner(OWNER_A, {
            resolveLegacyScope: vi.fn(async () => ({ status: "resolved" as const, examId: "exam-1" })),
            checkpoint: vi.fn(async () => ({ status: "revision_conflict" as const })),
            submit: vi.fn(),
        }, { store, now: NOW })).resolves.toMatchObject({ status: "blocked", blockedCount: 1 });
        expect(await store.list()).toEqual([
            expect.objectContaining({
                schemaVersion: 2,
                recoveredFromSchemaVersion: 1,
                byteLength: expect.any(Number),
                state: "blocked",
                snapshot: expect.objectContaining({ examId: "exam-1" }),
            }),
        ]);
        expect(((await store.list())[0] as { byteLength: number }).byteLength)
            .toBeGreaterThan(MAX_SECURE_SUBMISSION_RECORD_BYTES);
    });

    it("quarantines and never replays a legacy targeted row without exact generation", async () => {
        const store = createMemorySecureSubmissionStore();
        const queued = await queueSecureSubmission(OWNER_A, snapshot({
            assignmentId: "assignment-reused",
            assignmentRevision: 8,
        }), { store, now: NOW });
        expect(queued.status).toBe("queued");
        const record = await readSecureSubmission("session-1", { store });
        expect(record).not.toBeNull();
        await store.put({ ...record!, schemaVersion: 1 } as never);

        await expect(maintainSecureSubmissionOutbox({ store, now: NOW }))
            .resolves.toEqual({ expiredCount: 0, invalidCount: 0 });
        expect(await store.list()).toHaveLength(1);
        const checkpoint = vi.fn();
        const submit = vi.fn();
        const resolveLegacyScope = vi.fn(async () => ({ status: "targeted" as const }));
        await expect(replaySecureSubmissionsForOwner(OWNER_A, { resolveLegacyScope, checkpoint, submit }, { store, now: NOW }))
            .resolves.toEqual({ status: "empty", submitted: [] });
        expect(checkpoint).not.toHaveBeenCalled();
        expect(submit).not.toHaveBeenCalled();
        expect(await store.list()).toHaveLength(1);
        expect(await readSecureSubmissionRecoveryNotices({ store })).toEqual([
            expect.objectContaining({ kind: "legacy_recovery_required", sessionId: "session-1" }),
        ]);
    });

    it("does not let quarantined legacy rows consume active v2 queue capacity", async () => {
        const store = createMemorySecureSubmissionStore();
        for (let index = 0; index < SECURE_SUBMISSION_OUTBOX_LIMIT; index += 1) {
            await queueSecureSubmission(OWNER_A, snapshot({ sessionId: `legacy-${index}` }), { store, now: NOW });
            const record = await readSecureSubmission(`legacy-${index}`, { store });
            await store.put(legacyRecord(record!) as never);
        }
        await expect(queueSecureSubmission(OWNER_A, snapshot({ sessionId: "current-v2" }), { store, now: NOW }))
            .resolves.toMatchObject({ status: "queued" });
        expect(await store.list()).toHaveLength(SECURE_SUBMISSION_OUTBOX_LIMIT + 1);
    });

    it.each(["revision_conflict", "lease_conflict", "expired", "unauthenticated", "invalid"])(
        "blocks %s without automatic takeover",
        async status => {
            const store = createMemorySecureSubmissionStore();
            await queueSecureSubmission(OWNER_A, snapshot(), { store, now: NOW });
            const submit = vi.fn();
            const takeover = vi.fn();

            await expect(replaySecureSubmissionsForOwner(OWNER_A, {
                checkpoint: vi.fn(async () => ({ status })),
                submit,
                ...({ takeover } as object),
            }, { store, now: NOW })).resolves.toMatchObject({ status: "blocked", blockedCount: 1 });
            expect(submit).not.toHaveBeenCalled();
            expect(takeover).not.toHaveBeenCalled();
            expect((await readSecureSubmission("session-1", { store }))?.state).toBe("blocked");
        },
    );

    it("coalesces concurrent replay to one checkpoint and one shared result", async () => {
        const store = createMemorySecureSubmissionStore();
        await queueSecureSubmission(OWNER_A, snapshot(), { store, now: NOW });
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const checkpoint = vi.fn(async () => {
            await gate;
            return { status: "service_unavailable" as const };
        });
        const actions = { checkpoint, submit: vi.fn() };

        const first = replaySecureSubmissionsForOwner(OWNER_A, actions, { store, now: NOW });
        const second = replaySecureSubmissionsForOwner(OWNER_A, actions, { store, now: NOW });
        await vi.waitFor(() => expect(checkpoint).toHaveBeenCalledOnce());
        release();
        await expect(Promise.all([first, second])).resolves.toEqual([
            { status: "retryable_error", submitted: [], blockedCount: 0 },
            { status: "retryable_error", submitted: [], blockedCount: 0 },
        ]);
        expect(checkpoint).toHaveBeenCalledOnce();
        expect((await readSecureSubmission("session-1", { store }))?.state).toBe("queued");
    });

    it("atomically claims a replay across tabs and applies bounded backoff", async () => {
        const store = createMemorySecureSubmissionStore();
        await queueSecureSubmission(OWNER_A, snapshot(), { store, now: NOW });
        const [firstClaim, secondClaim] = await Promise.all([
            store.claim("session-1", OWNER_A, "claim-a", NOW, NOW + 30_000),
            store.claim("session-1", OWNER_A, "claim-b", NOW, NOW + 30_000),
        ]);
        expect([firstClaim, secondClaim].filter(Boolean)).toHaveLength(1);
        const winner = firstClaim ? "claim-a" : "claim-b";
        await store.commit("session-1", winner, { kind: "retryable", now: NOW, random: 0 });

        const checkpoint = vi.fn(async () => ({ status: "service_unavailable" as const }));
        await expect(replaySecureSubmissionsForOwner(OWNER_A, { checkpoint, submit: vi.fn() }, {
            store,
            now: NOW + 999,
            sessionId: "session-1",
        })).resolves.toEqual({ status: "deferred", submitted: [] });
        expect(checkpoint).not.toHaveBeenCalled();

        await replaySecureSubmissionsForOwner(OWNER_A, { checkpoint, submit: vi.fn() }, {
            store,
            now: NOW + 1_000,
            sessionId: "session-1",
            random: () => 0,
        });
        expect(checkpoint).toHaveBeenCalledOnce();
    });
});
