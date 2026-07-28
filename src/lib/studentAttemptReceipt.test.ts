import { afterEach, describe, expect, it, vi } from "vitest";
import { getAttemptQuestionResults } from "@/lib/premiumAnalytics";
import type { ServerGradedAttemptReceipt } from "@/lib/studentExamContract";
import type { Attempt, Exam } from "@/types/omr";
import {
    readLocalAttempts,
    replaceLocalAttemptWithCanonical,
} from "./omrPersistence";
import {
    localResultCacheFromServerReceipt,
    pendingSubmissionReceiptIds,
    persistSubmissionReceipt,
    queuePendingSubmissionReceipt,
    readReconciledSubmissionAttemptId,
    readSubmissionReceipt,
    retryPendingSubmissionReceipt,
    SUBMISSION_RECEIPT_ENTRY_PREFIX,
    SUBMISSION_RECEIPT_REQUEST_PREFIX,
    submissionReceiptLabel,
} from "./studentAttemptReceipt";

function createStorage(initial: Record<string, string> = {}): Storage {
    const data = new Map(Object.entries(initial));
    return {
        get length() { return data.size; },
        clear() { data.clear(); },
        getItem(key) { return data.get(key) ?? null; },
        key(index) { return [...data.keys()][index] ?? null; },
        removeItem(key) { data.delete(key); },
        setItem(key, value) { data.set(key, value); },
    } as Storage;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

const receipt: ServerGradedAttemptReceipt = {
    attemptId: "attempt-ticket-1",
    examId: "exam-1",
    score: 5,
    totalScore: 10,
    correctCount: 1,
    incorrectCount: 1,
    unansweredCount: 0,
    ungradedCount: 0,
    finishedAt: "2026-07-14T01:00:00.000Z",
    questionResults: [
        { questionId: 1, questionNumber: 1, selectedAnswer: 3, score: 5, earnedScore: 5, status: "correct" },
        { questionId: 2, questionNumber: 2, selectedAnswer: 2, score: 5, earnedScore: 0, status: "wrong" },
    ],
};

describe("student attempt receipt cache", () => {
    it("uses the exact authoritative persistence labels", () => {
        expect(submissionReceiptLabel({ status: "confirmed" })).toBe("서버 반영 완료");
        expect(submissionReceiptLabel({ status: "pending" })).toBe("서버 반영 대기 · 자동 재시도");
        expect(submissionReceiptLabel({ status: "local_only" })).toBe("이 기기에만 저장됨");
    });

    it("persists the authoritative status independently of navigation and reload", () => {
        const storage = createStorage();
        vi.stubGlobal("window", { localStorage: storage });

        persistSubmissionReceipt({
            attemptId: "attempt-local-1",
            status: "local_only",
            updatedAt: "2026-07-28T00:00:00.000Z",
        });

        expect(readSubmissionReceipt("attempt-local-1")).toEqual({
            attemptId: "attempt-local-1",
            status: "local_only",
            updatedAt: "2026-07-28T00:00:00.000Z",
        });
    });

    it("keeps a failed idempotent retry pending with honest feedback", async () => {
        const storage = createStorage();
        vi.stubGlobal("window", { localStorage: storage });
        queuePendingSubmissionReceipt({
            attemptId: "attempt-local-1",
            input: {
                examId: "exam-1",
                submissionId: "submission-1",
                answers: { 1: 2 },
                startedAt: "2026-07-28T00:00:00.000Z",
            },
        }, "2026-07-28T00:01:00.000Z");

        const result = await retryPendingSubmissionReceipt("attempt-local-1", {
            submitSignedSessionAttempt: async () => ({ status: "error" }),
        });

        expect(result).toEqual({
            status: "pending",
            error: "서버에 아직 반영하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해주세요.",
        });
        expect(readSubmissionReceipt("attempt-local-1")?.status).toBe("pending");
        expect(pendingSubmissionReceiptIds()).toEqual(["attempt-local-1"]);
    });

    it("keeps a retryable service outage pending", async () => {
        const storage = createStorage();
        vi.stubGlobal("window", { localStorage: storage });
        queuePendingSubmissionReceipt({
            attemptId: "attempt-service-outage",
            input: {
                examId: "exam-1",
                submissionId: "submission-service-outage",
                answers: {},
                startedAt: "2026-07-28T00:00:00.000Z",
            },
        });

        const result = await retryPendingSubmissionReceipt("attempt-service-outage", {
            submitSignedSessionAttempt: async () => ({ status: "service_unavailable" }),
        });

        expect(result.status).toBe("pending");
        expect(readSubmissionReceipt("attempt-service-outage")?.status).toBe("pending");
        expect(pendingSubmissionReceiptIds()).toEqual(["attempt-service-outage"]);
    });

    it("stores PIN-gated replay intent without ever persisting the raw PIN", () => {
        const storage = createStorage();
        vi.stubGlobal("window", { localStorage: storage });

        expect(queuePendingSubmissionReceipt({
            attemptId: "attempt-pin",
            input: {
                examId: "exam-1",
                submissionId: "submission-pin",
                answers: { 1: 2 },
                startedAt: "2026-07-28T00:00:00.000Z",
            },
            requiresPin: true,
        })).toBe(true);

        expect(readSubmissionReceipt("attempt-pin")).toMatchObject({
            status: "pending",
            requiresPin: true,
        });
        expect([...Array(storage.length)].map((_, index) => storage.getItem(storage.key(index)!) || "").join(""))
            .not.toContain("1234");
    });

    it.each([
        ["unauthenticated", "login_required"],
        ["login_required", "login_required"],
        ["ended", "exam_ended"],
        ["archived", "exam_archived"],
        ["group_denied", "access_denied"],
        ["denied", "access_denied"],
        ["not_found", "not_found"],
    ])("stops replay for permanent %s outcomes with a truthful local-only reason", async (status, reason) => {
        const storage = createStorage();
        vi.stubGlobal("window", { localStorage: storage });
        queuePendingSubmissionReceipt({
            attemptId: `attempt-${status}`,
            input: {
                examId: "exam-1",
                submissionId: `submission-${status}`,
                answers: {},
                startedAt: "2026-07-28T00:00:00.000Z",
            },
        });

        const result = await retryPendingSubmissionReceipt(`attempt-${status}`, {
            submitSignedSessionAttempt: async () => ({ status }),
        });

        expect(result.status).toBe("local_only");
        expect(readSubmissionReceipt(`attempt-${status}`)).toMatchObject({
            status: "local_only",
            reason,
            actionDetail: expect.any(String),
        });
        expect(pendingSubmissionReceiptIds()).not.toContain(`attempt-${status}`);
    });

    it("keeps PIN retries manual across reload, skips network without a PIN, and confirms with a supplied PIN", async () => {
        const storage = createStorage();
        vi.stubGlobal("window", { localStorage: storage });
        queuePendingSubmissionReceipt({
            attemptId: "attempt-pin",
            input: {
                examId: "exam-1",
                submissionId: "submission-pin",
                answers: { 1: 2 },
                startedAt: "2026-07-28T00:00:00.000Z",
            },
            requiresPin: true,
        });
        const submit = vi.fn(async (_input, pin?: string) => pin === "2468"
            ? {
                status: "ok",
                attempt: {
                    id: "attempt-server-pin",
                    examId: "exam-1",
                    examTitle: "시험",
                    studentName: "학생",
                    startedAt: "2026-07-28T00:00:00.000Z",
                    finishedAt: "2026-07-28T00:02:00.000Z",
                    score: 10,
                    totalScore: 10,
                    answers: { 1: 2 },
                    status: "completed" as const,
                },
            }
            : { status: "pin_required" });

        const missingPin = await retryPendingSubmissionReceipt("attempt-pin", {
            submitSignedSessionAttempt: submit,
        });
        expect(missingPin).toMatchObject({ status: "pending", requiresPin: true });
        expect(submit).not.toHaveBeenCalled();

        const wrongPin = await retryPendingSubmissionReceipt("attempt-pin", {
            submitSignedSessionAttempt: submit,
            pin: "1111",
        });
        expect(wrongPin).toMatchObject({ status: "pending", requiresPin: true });
        expect(readSubmissionReceipt("attempt-pin")).toMatchObject({ status: "pending", requiresPin: true });

        const confirmed = await retryPendingSubmissionReceipt("attempt-pin", {
            submitSignedSessionAttempt: submit,
            pin: "2468",
        });
        expect(confirmed.status).toBe("confirmed");
        expect(JSON.stringify([...Array(storage.length)].map((_, index) => storage.getItem(storage.key(index)!))))
            .not.toContain("2468");
    });

    it("isolates per-attempt envelopes, migrates v1, and quarantines only the corrupt entry", () => {
        const legacy = {
            receipts: {
                "attempt-one": {
                    attemptId: "attempt-one",
                    status: "pending",
                    updatedAt: "2026-07-28T00:00:00.000Z",
                },
                "attempt-two": {
                    attemptId: "attempt-two",
                    status: "confirmed",
                    updatedAt: "2026-07-28T00:01:00.000Z",
                },
            },
            requests: {
                "attempt-one": {
                    attemptId: "attempt-one",
                    input: {
                        examId: "exam-1",
                        submissionId: "submission-one",
                        answers: {},
                        startedAt: "2026-07-28T00:00:00.000Z",
                    },
                },
            },
            reconciliations: {},
        };
        const storage = createStorage({
            omr_student_submission_receipts_v1: JSON.stringify(legacy),
        });
        vi.stubGlobal("window", { localStorage: storage });

        expect(readSubmissionReceipt("attempt-one")?.status).toBe("pending");
        expect(readSubmissionReceipt("attempt-two")?.status).toBe("confirmed");
        expect(storage.getItem(`${SUBMISSION_RECEIPT_ENTRY_PREFIX}${encodeURIComponent("attempt-one")}`)).toBeTruthy();
        storage.setItem(`${SUBMISSION_RECEIPT_ENTRY_PREFIX}${encodeURIComponent("attempt-one")}`, "{bad");

        expect(readSubmissionReceipt("attempt-one")).toBeNull();
        expect(readSubmissionReceipt("attempt-two")?.status).toBe("confirmed");
        expect([...Array(storage.length)].map((_, index) => storage.key(index)))
            .toEqual(expect.arrayContaining([expect.stringContaining("quarantine")]));
    });

    it("keeps the v1 registry intact when migration is interrupted by quota and resumes later", () => {
        const legacy = JSON.stringify({
            receipts: {
                "attempt-one": {
                    attemptId: "attempt-one",
                    status: "pending",
                    updatedAt: "2026-07-28T00:00:00.000Z",
                },
            },
            requests: {
                "attempt-one": {
                    attemptId: "attempt-one",
                    input: {
                        examId: "exam-1",
                        submissionId: "submission-one",
                        answers: {},
                        startedAt: "2026-07-28T00:00:00.000Z",
                    },
                },
            },
        });
        const base = createStorage({ omr_student_submission_receipts_v1: legacy });
        let failMigration = true;
        const storage = {
            get length() { return base.length; },
            clear() { base.clear(); },
            getItem(key: string) { return base.getItem(key); },
            key(index: number) { return base.key(index); },
            removeItem(key: string) { base.removeItem(key); },
            setItem(key: string, value: string) {
                if (failMigration && key.startsWith(SUBMISSION_RECEIPT_REQUEST_PREFIX)) throw new Error("quota");
                base.setItem(key, value);
            },
        } as Storage;
        vi.stubGlobal("window", { localStorage: storage });

        readSubmissionReceipt("attempt-one");
        expect(storage.getItem("omr_student_submission_receipts_v1")).toBe(legacy);
        expect(storage.getItem("omr_student_submission_receipts_v2_migrated")).toBeNull();

        failMigration = false;
        expect(pendingSubmissionReceiptIds()).toEqual(["attempt-one"]);
        expect(storage.getItem("omr_student_submission_receipts_v1")).toBeNull();
    });

    it("keeps distinct pending submissions isolated and rejects a stale pending overwrite after confirmation", () => {
        const storage = createStorage();
        vi.stubGlobal("window", { localStorage: storage });
        const request = (id: string) => ({
            attemptId: id,
            input: {
                examId: "exam-1",
                submissionId: `submission-${id}`,
                answers: {},
                startedAt: "2026-07-28T00:00:00.000Z",
            },
        });

        expect(queuePendingSubmissionReceipt(request("attempt-one"))).toBe(true);
        expect(queuePendingSubmissionReceipt(request("attempt-two"))).toBe(true);
        expect(pendingSubmissionReceiptIds().sort()).toEqual(["attempt-one", "attempt-two"]);
        expect(storage.getItem(`${SUBMISSION_RECEIPT_REQUEST_PREFIX}${encodeURIComponent("attempt-one")}`)).toBeTruthy();
        expect(storage.getItem(`${SUBMISSION_RECEIPT_REQUEST_PREFIX}${encodeURIComponent("attempt-two")}`)).toBeTruthy();

        expect(persistSubmissionReceipt({
            attemptId: "attempt-one",
            status: "confirmed",
            updatedAt: "2026-07-28T00:02:00.000Z",
        })).toBe(true);
        expect(queuePendingSubmissionReceipt(request("attempt-one"))).toBe(false);
        expect(readSubmissionReceipt("attempt-one")?.status).toBe("confirmed");
        expect(pendingSubmissionReceiptIds()).toEqual(["attempt-two"]);
    });

    it("uses a same-attempt Web Lock when available", async () => {
        const storage = createStorage();
        const requestLock = vi.fn(async (
            _name: string,
            _options: object,
            operation: () => Promise<unknown>,
        ) => operation());
        vi.stubGlobal("window", { localStorage: storage });
        vi.stubGlobal("navigator", { locks: { request: requestLock } });
        queuePendingSubmissionReceipt({
            attemptId: "attempt-lock",
            input: {
                examId: "exam-1",
                submissionId: "submission-lock",
                answers: {},
                startedAt: "2026-07-28T00:00:00.000Z",
            },
        });

        await retryPendingSubmissionReceipt("attempt-lock", {
            submitSignedSessionAttempt: async () => ({ status: "error" }),
        });

        expect(requestLock).toHaveBeenCalledWith(
            "omr-submission:attempt-lock",
            { mode: "exclusive" },
            expect.any(Function),
        );
    });

    it("caps confirmed receipts without ever pruning pending requests", () => {
        const storage = createStorage();
        vi.stubGlobal("window", { localStorage: storage });
        queuePendingSubmissionReceipt({
            attemptId: "attempt-must-stay-pending",
            input: {
                examId: "exam-1",
                submissionId: "submission-must-stay-pending",
                answers: {},
                startedAt: "2026-07-28T00:00:00.000Z",
            },
        });
        for (let index = 0; index < 120; index += 1) {
            expect(persistSubmissionReceipt({
                attemptId: `attempt-confirmed-${index}`,
                status: "confirmed",
                updatedAt: new Date(index * 1_000).toISOString(),
            })).toBe(true);
        }

        const receiptKeys = [...Array(storage.length)]
            .map((_, index) => storage.key(index))
            .filter(key => key?.startsWith(SUBMISSION_RECEIPT_ENTRY_PREFIX));
        expect(receiptKeys).toHaveLength(101);
        expect(readSubmissionReceipt("attempt-must-stay-pending")?.status).toBe("pending");
        expect(pendingSubmissionReceiptIds()).toEqual(["attempt-must-stay-pending"]);
    });

    it("caps old-to-canonical aliases", async () => {
        const storage = createStorage();
        vi.stubGlobal("window", { localStorage: storage });
        for (let index = 0; index < 110; index += 1) {
            const oldId = `attempt-old-${index}`;
            queuePendingSubmissionReceipt({
                attemptId: oldId,
                input: {
                    examId: "exam-1",
                    submissionId: `submission-${index}`,
                    answers: {},
                    startedAt: "2026-07-28T00:00:00.000Z",
                },
            });
            await retryPendingSubmissionReceipt(oldId, {
                submitSignedSessionAttempt: async () => ({
                    status: "ok",
                    attempt: {
                        id: `attempt-canonical-${index}`,
                        examId: "exam-1",
                        examTitle: "시험",
                        studentName: "학생",
                        startedAt: "2026-07-28T00:00:00.000Z",
                        finishedAt: new Date(index * 1_000).toISOString(),
                        score: 10,
                        totalScore: 10,
                        answers: {},
                        status: "completed",
                    },
                }),
            });
        }

        const aliasKeys = [...Array(storage.length)]
            .map((_, index) => storage.key(index))
            .filter(key => key?.startsWith("omr_student_submission_alias_v2:"));
        expect(aliasKeys).toHaveLength(100);
    });

    it("confirms and cleans up only after the intended server request succeeds", async () => {
        const storage = createStorage();
        vi.stubGlobal("window", { localStorage: storage });
        queuePendingSubmissionReceipt({
            attemptId: "attempt-local-1",
            input: {
                examId: "exam-1",
                submissionId: "submission-1",
                answers: { 1: 2 },
                startedAt: "2026-07-28T00:00:00.000Z",
            },
        }, "2026-07-28T00:01:00.000Z");

        const authoritativeAttempt: Attempt = {
            id: "attempt-server-1",
            examId: "exam-1",
            examTitle: "시험",
            studentName: "학생",
            startedAt: "2026-07-28T00:00:00.000Z",
            finishedAt: "2026-07-28T00:02:00.000Z",
            score: 10,
            totalScore: 10,
            answers: { 1: 2 },
            status: "completed",
        };
        const result = await retryPendingSubmissionReceipt("attempt-local-1", {
            submitSignedSessionAttempt: async input => {
                expect(input.submissionId).toBe("submission-1");
                return { status: "ok", attempt: authoritativeAttempt };
            },
        });

        expect(result).toEqual({
            status: "confirmed",
            previousAttemptId: "attempt-local-1",
            attempt: authoritativeAttempt,
            receipt: expect.objectContaining({
                attemptId: "attempt-server-1",
                status: "confirmed",
            }),
        });
        expect(readSubmissionReceipt("attempt-local-1")).toBeNull();
        expect(readSubmissionReceipt("attempt-server-1")?.status).toBe("confirmed");
        expect(readReconciledSubmissionAttemptId("attempt-local-1")).toBe("attempt-server-1");
        expect(pendingSubmissionReceiptIds()).toEqual([]);
        expect(queuePendingSubmissionReceipt({
            attemptId: "attempt-local-1",
            input: {
                examId: "exam-1",
                submissionId: "stale-submission",
                answers: {},
                startedAt: "2026-07-28T00:00:00.000Z",
            },
        })).toBe(false);
    });

    it("keeps the replay request pending when durable confirmation storage fails", async () => {
        const localAttempt: Attempt = {
            id: "attempt-local-1",
            examId: "exam-1",
            examTitle: "시험",
            studentName: "학생",
            startedAt: "2026-07-28T00:00:00.000Z",
            finishedAt: "2026-07-28T00:01:00.000Z",
            score: 0,
            totalScore: 10,
            answers: { 1: 1 },
            status: "completed",
        };
        let failReceiptWrites = false;
        const base = createStorage();
        base.setItem("omr_attempts", JSON.stringify([localAttempt]));
        const storage = {
            get length() { return base.length; },
            clear() { base.clear(); },
            getItem(key: string) { return base.getItem(key); },
            key(index: number) { return base.key(index); },
            removeItem(key: string) { base.removeItem(key); },
            setItem(key: string, value: string) {
                if (failReceiptWrites && key.startsWith(SUBMISSION_RECEIPT_ENTRY_PREFIX)) {
                    throw new Error("quota");
                }
                base.setItem(key, value);
            },
        } as Storage;
        vi.stubGlobal("window", { localStorage: storage });
        vi.stubGlobal("localStorage", storage);
        queuePendingSubmissionReceipt({
            attemptId: "attempt-local-1",
            input: {
                examId: "exam-1",
                submissionId: "submission-1",
                answers: { 1: 2 },
                startedAt: "2026-07-28T00:00:00.000Z",
            },
        });
        failReceiptWrites = true;

        const result = await retryPendingSubmissionReceipt("attempt-local-1", {
            submitSignedSessionAttempt: async () => ({
                status: "ok",
                attempt: {
                    id: "attempt-server-1",
                    examId: "exam-1",
                    examTitle: "시험",
                    studentName: "학생",
                    startedAt: "2026-07-28T00:00:00.000Z",
                    finishedAt: "2026-07-28T00:02:00.000Z",
                    score: 10,
                    totalScore: 10,
                    answers: { 1: 2 },
                    status: "completed",
                },
            }),
            onAuthoritativeAttempt: replaceLocalAttemptWithCanonical,
        });

        expect(result).toEqual({
            status: "pending",
            error: "서버 응답은 받았지만 확인 상태를 저장하지 못했습니다. 자동 재시도를 유지합니다.",
        });
        expect(readSubmissionReceipt("attempt-local-1")?.status).toBe("pending");
        expect(readSubmissionReceipt("attempt-server-1")).toBeNull();
        expect(pendingSubmissionReceiptIds()).toEqual(["attempt-local-1"]);
        expect(readLocalAttempts()).toEqual([localAttempt]);
    });

    it("caches and announces canonical reconciliation after durable confirmation", async () => {
        const storage = createStorage();
        const dispatchedEvents: Event[] = [];
        const dispatchEvent = vi.fn((event: Event) => {
            dispatchedEvents.push(event);
            return true;
        });
        vi.stubGlobal("window", { localStorage: storage, dispatchEvent });
        queuePendingSubmissionReceipt({
            attemptId: "attempt-local-1",
            input: {
                examId: "exam-1",
                submissionId: "submission-1",
                answers: {},
                startedAt: "2026-07-28T00:00:00.000Z",
            },
        });
        const authoritativeAttempt: Attempt = {
            id: "attempt-server-1",
            examId: "exam-1",
            examTitle: "시험",
            studentName: "학생",
            startedAt: "2026-07-28T00:00:00.000Z",
            finishedAt: "2026-07-28T00:02:00.000Z",
            score: 10,
            totalScore: 10,
            answers: {},
            status: "completed",
        };
        const reconciledAttempt = {
            ...authoritativeAttempt,
            drawingStrokeCount: 4,
        };
        const rollback = vi.fn(() => true);
        const onAuthoritativeAttempt = vi.fn(() => ({
            committed: true,
            attempt: reconciledAttempt,
            rollback,
        }));

        await retryPendingSubmissionReceipt("attempt-local-1", {
            submitSignedSessionAttempt: async () => ({ status: "ok", attempt: authoritativeAttempt }),
            onAuthoritativeAttempt,
        });

        expect(onAuthoritativeAttempt).toHaveBeenCalledWith("attempt-local-1", authoritativeAttempt);
        expect(dispatchEvent).toHaveBeenCalledTimes(1);
        expect((dispatchedEvents[0] as CustomEvent).detail).toMatchObject({
            previousAttemptId: "attempt-local-1",
            attempt: reconciledAttempt,
            receipt: { attemptId: "attempt-server-1", status: "confirmed" },
        });
        expect(rollback).not.toHaveBeenCalled();
    });

    it("coalesces concurrent retry triggers for the same idempotent submission", async () => {
        const storage = createStorage();
        vi.stubGlobal("window", { localStorage: storage });
        queuePendingSubmissionReceipt({
            attemptId: "attempt-local-1",
            input: {
                examId: "exam-1",
                submissionId: "submission-1",
                answers: {},
                startedAt: "2026-07-28T00:00:00.000Z",
            },
        });
        let calls = 0;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const deps = {
            submitSignedSessionAttempt: async () => {
                calls += 1;
                await gate;
                return { status: "error" as const };
            },
        };

        const first = retryPendingSubmissionReceipt("attempt-local-1", deps);
        const second = retryPendingSubmissionReceipt("attempt-local-1", deps);
        release();
        await Promise.all([first, second]);

        expect(calls).toBe(1);
    });

    it("ignores a tampered retry request whose stored attempt id does not match its key", () => {
        const storage = createStorage({
            omr_student_submission_receipts_v1: JSON.stringify({
                receipts: {
                    "attempt-local-1": {
                        attemptId: "attempt-local-1",
                        status: "pending",
                        updatedAt: "2026-07-28T00:00:00.000Z",
                    },
                },
                requests: {
                    "attempt-local-1": {
                        attemptId: "another-attempt",
                        input: {
                            examId: "exam-1",
                            submissionId: "submission-1",
                            answers: {},
                            startedAt: "2026-07-28T00:00:00.000Z",
                        },
                    },
                },
            }),
        });
        vi.stubGlobal("window", { localStorage: storage });

        expect(pendingSubmissionReceiptIds()).toEqual([]);
    });

    it("caches only server-authoritative selections and grading without an answer key", () => {
        const cached = localResultCacheFromServerReceipt(receipt, {
            examTitle: "학생용 시험",
            studentName: "학생 1",
            studentId: "student-1",
            identityType: "registered",
        });
        expect(cached.answers).toEqual({ 1: 3, 2: 2 });
        expect(cached.questionResults.map(result => ({
            questionId: result.questionId,
            status: result.status,
            score: result.score,
            earnedScore: result.earnedScore,
        }))).toEqual([
            { questionId: 1, status: "correct", score: 5, earnedScore: 5 },
            { questionId: 2, status: "wrong", score: 5, earnedScore: 0 },
        ]);
        expect(JSON.stringify(cached)).not.toContain("correctAnswer");
    });

    it("keeps official statuses when review uses an answer-key-free student exam", () => {
        const safeExam: Exam = {
            id: "exam-1",
            title: "학생용 시험",
            createdAt: "2026-07-14T00:00:00.000Z",
            questions: [
                { id: 1, number: 1, choices: 5 },
                { id: 2, number: 2, choices: 4 },
            ],
        };
        const cached = localResultCacheFromServerReceipt(receipt, {
            examTitle: safeExam.title,
            studentName: "학생 1",
            studentId: "student-1",
            identityType: "registered",
        });
        const attempt: Attempt = {
            id: receipt.attemptId,
            examId: receipt.examId,
            examTitle: safeExam.title,
            studentName: "학생 1",
            studentId: "student-1",
            identityType: "registered",
            startedAt: "2026-07-14T00:00:00.000Z",
            finishedAt: receipt.finishedAt,
            score: receipt.score,
            totalScore: receipt.totalScore,
            answers: cached.answers,
            questionResults: cached.questionResults,
            status: "completed",
        };

        expect(getAttemptQuestionResults(safeExam, attempt).map(result => ({
            status: result.status,
            score: result.score,
            earnedScore: result.earnedScore,
            correctAnswer: result.correctAnswer,
        }))).toEqual([
            { status: "correct", score: 5, earnedScore: 5, correctAnswer: undefined },
            { status: "wrong", score: 5, earnedScore: 0, correctAnswer: undefined },
        ]);
    });
});
