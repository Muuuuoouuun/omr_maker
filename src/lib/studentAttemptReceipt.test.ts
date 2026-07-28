import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAttemptQuestionResults } from "@/lib/premiumAnalytics";
import type { ServerGradedAttemptReceipt } from "@/lib/studentExamContract";
import type { Attempt, Exam } from "@/types/omr";
import {
    readLocalAttempts,
    saveLocalAttempts,
} from "./omrPersistence";
import {
    localResultCacheFromServerReceipt,
    migrateLegacySubmissionReceipts,
    pendingSubmissionReceiptIds,
    persistSubmissionReceipt,
    queuePendingSubmissionReceipt,
    readReconciledSubmissionAttemptId,
    readSubmissionReceipt,
    retryPendingSubmissionReceipt,
    SUBMISSION_RECEIPT_ENTRY_PREFIX,
    SUBMISSION_RECEIPT_REQUEST_PREFIX,
    submissionReceiptLabel,
    submissionReceiptForAttempt,
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

beforeEach(() => {
    vi.stubGlobal("navigator", {
        locks: {
            request: async (
                _name: string,
                _options: object,
                operation: () => Promise<unknown> | unknown,
            ) => operation(),
        },
    });
});

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
    it("overlays late v1 data without mutating storage from synchronous read APIs", () => {
        const legacy = {
            receipts: {
                "attempt-late": {
                    attemptId: "attempt-late",
                    status: "pending",
                    updatedAt: "2026-07-28T00:00:00.000Z",
                },
            },
            requests: {
                "attempt-late": {
                    attemptId: "attempt-late",
                    input: {
                        examId: "exam-1",
                        submissionId: "submission-late",
                        answers: {},
                        startedAt: "2026-07-28T00:00:00.000Z",
                    },
                },
            },
            reconciliations: { "attempt-old": "attempt-late" },
        };
        const storage = createStorage({
            omr_student_submission_receipts_v2_migrated: "1",
            omr_student_submission_receipts_v1: JSON.stringify(legacy),
        });
        vi.stubGlobal("window", { localStorage: storage });
        const before = [...Array(storage.length)].map((_, index) => [
            storage.key(index),
            storage.getItem(storage.key(index) || ""),
        ]);

        expect(readSubmissionReceipt("attempt-late")?.status).toBe("pending");
        expect(pendingSubmissionReceiptIds()).toEqual(["attempt-late"]);
        expect(readReconciledSubmissionAttemptId("attempt-old")).toBe("attempt-late");
        expect([...Array(storage.length)].map((_, index) => [
            storage.key(index),
            storage.getItem(storage.key(index) || ""),
        ])).toEqual(before);
    });

    it("keeps current v2 envelopes authoritative during awaited late-v1 migration", async () => {
        const currentReceiptKey = `${SUBMISSION_RECEIPT_ENTRY_PREFIX}${encodeURIComponent("attempt-same")}`;
        const currentRequestKey = `${SUBMISSION_RECEIPT_REQUEST_PREFIX}${encodeURIComponent("attempt-same")}`;
        const aliasKey = `omr_student_submission_alias_v2:${encodeURIComponent("attempt-old")}`;
        const currentReceipt = JSON.stringify({
            version: 2,
            revision: 7,
            receipt: {
                attemptId: "attempt-same",
                status: "confirmed",
                updatedAt: "2026-07-28T03:00:00.000Z",
            },
        });
        const currentRequest = JSON.stringify({
            version: 2,
            revision: 4,
            request: {
                attemptId: "attempt-same",
                input: {
                    examId: "exam-current",
                    submissionId: "submission-current",
                    answers: {},
                    startedAt: "2026-07-28T03:00:00.000Z",
                },
            },
        });
        const currentAlias = JSON.stringify({
            version: 2,
            previousAttemptId: "attempt-old",
            canonicalAttemptId: "attempt-current",
            updatedAt: "2026-07-28T03:00:00.000Z",
        });
        const storage = createStorage({
            [currentReceiptKey]: currentReceipt,
            [currentRequestKey]: currentRequest,
            [aliasKey]: currentAlias,
            omr_student_submission_receipts_v1: JSON.stringify({
                receipts: {
                    "attempt-same": {
                        attemptId: "attempt-same",
                        status: "pending",
                        updatedAt: "2026-07-28T00:00:00.000Z",
                    },
                    "attempt-missing": {
                        attemptId: "attempt-missing",
                        status: "pending",
                        updatedAt: "2026-07-28T00:00:00.000Z",
                    },
                },
                requests: {
                    "attempt-same": {
                        attemptId: "attempt-same",
                        input: {
                            examId: "exam-legacy",
                            submissionId: "submission-legacy",
                            answers: {},
                            startedAt: "2026-07-28T00:00:00.000Z",
                        },
                    },
                },
                reconciliations: { "attempt-old": "attempt-legacy" },
            }),
        });
        vi.stubGlobal("window", { localStorage: storage });

        expect(await migrateLegacySubmissionReceipts()).toBe(true);
        expect(storage.getItem(currentReceiptKey)).toBe(currentReceipt);
        expect(storage.getItem(currentRequestKey)).toBeNull();
        expect(storage.getItem(aliasKey)).toBe(currentAlias);
        expect(readSubmissionReceipt("attempt-missing")?.status).toBe("pending");
        expect(readReconciledSubmissionAttemptId("attempt-old")).toBe("attempt-current");
    });

    it("rechecks a concurrent late-v1 write and never overwrites v2 injected during migration", async () => {
        const legacyKey = "omr_student_submission_receipts_v1";
        const currentId = "attempt-current-race";
        const currentKey = `${SUBMISSION_RECEIPT_ENTRY_PREFIX}${encodeURIComponent(currentId)}`;
        const currentEnvelope = JSON.stringify({
            version: 2,
            revision: 9,
            receipt: {
                attemptId: currentId,
                status: "confirmed",
                updatedAt: "2026-07-28T04:00:00.000Z",
            },
        });
        const firstLegacy = JSON.stringify({
            receipts: {
                [currentId]: {
                    attemptId: currentId,
                    status: "pending",
                    updatedAt: "2026-07-28T00:00:00.000Z",
                },
                "attempt-first-race": {
                    attemptId: "attempt-first-race",
                    status: "pending",
                    updatedAt: "2026-07-28T00:00:00.000Z",
                },
            },
        });
        const lateLegacy = JSON.stringify({
            receipts: {
                "attempt-late-race": {
                    attemptId: "attempt-late-race",
                    status: "pending",
                    updatedAt: "2026-07-28T05:00:00.000Z",
                },
            },
        });
        const base = createStorage({ [legacyKey]: firstLegacy });
        let legacyReads = 0;
        let injectedCurrent = false;
        const storage = {
            get length() { return base.length; },
            clear() { base.clear(); },
            getItem(key: string) {
                if (key === currentKey && !injectedCurrent) {
                    injectedCurrent = true;
                    base.setItem(currentKey, currentEnvelope);
                }
                if (key === legacyKey) {
                    legacyReads += 1;
                    if (legacyReads === 2) base.setItem(legacyKey, lateLegacy);
                }
                return base.getItem(key);
            },
            key(index: number) { return base.key(index); },
            removeItem(key: string) { base.removeItem(key); },
            setItem(key: string, value: string) { base.setItem(key, value); },
        } as Storage;
        vi.stubGlobal("window", { localStorage: storage });

        expect(await migrateLegacySubmissionReceipts()).toBe(false);
        expect(storage.getItem(currentKey)).toBe(currentEnvelope);
        expect(storage.getItem(legacyKey)).toBe(lateLegacy);
        expect(readSubmissionReceipt("attempt-first-race")?.status).toBe("pending");

        expect(await migrateLegacySubmissionReceipts()).toBe(true);
        expect(storage.getItem(currentKey)).toBe(currentEnvelope);
        expect(storage.getItem(legacyKey)).toBeNull();
        expect(readSubmissionReceipt("attempt-late-race")?.status).toBe("pending");
    });

    it("suppresses a late-v1 pending pair when a canonical v2 alias already supersedes it", async () => {
        const oldId = "attempt-old-superseded";
        const canonicalId = "attempt-canonical-superseded";
        const aliasStorageKey = `omr_student_submission_alias_v2:${encodeURIComponent(oldId)}`;
        const aliasEnvelope = JSON.stringify({
            version: 2,
            previousAttemptId: oldId,
            canonicalAttemptId: canonicalId,
            updatedAt: "2026-07-28T06:00:00.000Z",
        });
        const storage = createStorage({
            [aliasStorageKey]: aliasEnvelope,
            omr_student_submission_receipts_v1: JSON.stringify({
                receipts: {
                    [oldId]: {
                        attemptId: oldId,
                        status: "pending",
                        updatedAt: "2026-07-28T00:00:00.000Z",
                    },
                },
                requests: {
                    [oldId]: {
                        attemptId: oldId,
                        input: {
                            examId: "exam-1",
                            submissionId: "submission-superseded",
                            answers: {},
                            startedAt: "2026-07-28T00:00:00.000Z",
                        },
                    },
                },
            }),
        });
        vi.stubGlobal("window", { localStorage: storage });
        const submit = vi.fn(async () => ({ status: "error" }));

        expect(readSubmissionReceipt(oldId)).toBeNull();
        expect(pendingSubmissionReceiptIds()).not.toContain(oldId);
        expect(await migrateLegacySubmissionReceipts()).toBe(true);
        expect(storage.getItem(aliasStorageKey)).toBe(aliasEnvelope);
        expect(storage.getItem(`${SUBMISSION_RECEIPT_ENTRY_PREFIX}${encodeURIComponent(oldId)}`)).toBeNull();
        expect(storage.getItem(`${SUBMISSION_RECEIPT_REQUEST_PREFIX}${encodeURIComponent(oldId)}`)).toBeNull();
        expect(await retryPendingSubmissionReceipt(oldId, {
            submitSignedSessionAttempt: submit,
        })).toMatchObject({ status: "missing" });
        expect(submit).not.toHaveBeenCalled();
    });

    it.each(["confirmed", "local_only"] as const)(
        "removes an orphan request when a terminal v2 %s receipt supersedes late-v1 pending data",
        async terminalStatus => {
            const id = "attempt-terminal-superseded";
            const receiptStorageKey = `${SUBMISSION_RECEIPT_ENTRY_PREFIX}${encodeURIComponent(id)}`;
            const requestStorageKey = `${SUBMISSION_RECEIPT_REQUEST_PREFIX}${encodeURIComponent(id)}`;
            const terminalReceipt = JSON.stringify({
                version: 2,
                revision: 3,
                receipt: {
                    attemptId: id,
                    status: terminalStatus,
                    updatedAt: "2026-07-28T06:00:00.000Z",
                },
            });
            const orphanRequest = JSON.stringify({
                version: 2,
                revision: 2,
                request: {
                    attemptId: id,
                    input: {
                        examId: "exam-1",
                        submissionId: "submission-orphan-v2",
                        answers: {},
                        startedAt: "2026-07-28T00:00:00.000Z",
                    },
                },
            });
            const storage = createStorage({
                [receiptStorageKey]: terminalReceipt,
                [requestStorageKey]: orphanRequest,
                omr_student_submission_receipts_v1: JSON.stringify({
                    receipts: {
                        [id]: {
                            attemptId: id,
                            status: "pending",
                            updatedAt: "2026-07-28T00:00:00.000Z",
                        },
                    },
                    requests: {
                        [id]: {
                            attemptId: id,
                            input: {
                                examId: "exam-legacy",
                                submissionId: "submission-orphan-legacy",
                                answers: {},
                                startedAt: "2026-07-28T00:00:00.000Z",
                            },
                        },
                    },
                }),
            });
            vi.stubGlobal("window", { localStorage: storage });

            expect(readSubmissionReceipt(id)?.status).toBe(terminalStatus);
            expect(pendingSubmissionReceiptIds()).not.toContain(id);
            expect(storage.getItem(requestStorageKey)).toBe(orphanRequest);
            expect(await migrateLegacySubmissionReceipts()).toBe(true);
            expect(storage.getItem(receiptStorageKey)).toBe(terminalReceipt);
            expect(storage.getItem(requestStorageKey)).toBeNull();
            expect(storage.getItem("omr_student_submission_receipts_v1")).toBeNull();
        },
    );

    it("still overlays and migrates an ordinary legacy pending pair when v2 is missing", async () => {
        const id = "attempt-ordinary-legacy";
        const storage = createStorage({
            omr_student_submission_receipts_v1: JSON.stringify({
                receipts: {
                    [id]: {
                        attemptId: id,
                        status: "pending",
                        updatedAt: "2026-07-28T00:00:00.000Z",
                    },
                },
                requests: {
                    [id]: {
                        attemptId: id,
                        input: {
                            examId: "exam-1",
                            submissionId: "submission-ordinary",
                            answers: {},
                            startedAt: "2026-07-28T00:00:00.000Z",
                        },
                    },
                },
            }),
        });
        vi.stubGlobal("window", { localStorage: storage });

        expect(readSubmissionReceipt(id)?.status).toBe("pending");
        expect(pendingSubmissionReceiptIds()).toContain(id);
        expect(await migrateLegacySubmissionReceipts()).toBe(true);
        expect(storage.getItem(`${SUBMISSION_RECEIPT_ENTRY_PREFIX}${encodeURIComponent(id)}`)).toBeTruthy();
        expect(storage.getItem(`${SUBMISSION_RECEIPT_REQUEST_PREFIX}${encodeURIComponent(id)}`)).toBeTruthy();
    });

    it("uses the exact authoritative persistence labels", async () => {
        expect(submissionReceiptLabel({ status: "confirmed" })).toBe("서버 반영 완료");
        expect(submissionReceiptLabel({ status: "pending" })).toBe("서버 반영 대기 · 자동 재시도");
        expect(submissionReceiptLabel({
            status: "pending",
            retryMode: "manual",
            prerequisite: "pin",
        })).toBe("서버 반영 대기 · PIN 입력 필요");
        expect(submissionReceiptLabel({
            status: "pending",
            requiresPin: true,
        })).toBe("서버 반영 대기 · PIN 입력 필요");
        expect(submissionReceiptLabel({
            status: "pending",
            retryMode: "manual",
            prerequisite: "login",
        })).toBe("서버 반영 대기 · 로그인 필요");
        expect(submissionReceiptLabel({
            status: "pending",
            retryMode: "automatic",
            prerequisite: "exam_start",
        })).toBe("서버 반영 대기 · 시험 시작 전");
        expect(submissionReceiptLabel({ status: "local_only" })).toBe("이 기기에만 저장됨");
    });

    it("persists the authoritative status independently of navigation and reload", async () => {
        const storage = createStorage();
        vi.stubGlobal("window", { localStorage: storage });

        await persistSubmissionReceipt({
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

    it("preserves the not-started reason when a pending receipt is sanitized after reload", async () => {
        const storage = createStorage();
        vi.stubGlobal("window", { localStorage: storage });

        expect(await persistSubmissionReceipt({
            attemptId: "attempt-not-started-reload",
            status: "pending",
            updatedAt: "2026-07-28T00:00:00.000Z",
            reason: "not_started",
            retryMode: "automatic",
            prerequisite: "exam_start",
        })).toBe(true);

        expect(readSubmissionReceipt("attempt-not-started-reload")).toMatchObject({
            status: "pending",
            reason: "not_started",
            retryMode: "automatic",
            prerequisite: "exam_start",
        });
    });

    it("keeps a failed idempotent retry pending with honest feedback", async () => {
        const storage = createStorage();
        vi.stubGlobal("window", { localStorage: storage });
        await queuePendingSubmissionReceipt({
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
        await queuePendingSubmissionReceipt({
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

    it("stores PIN-gated replay intent without ever persisting the raw PIN", async () => {
        const storage = createStorage();
        vi.stubGlobal("window", { localStorage: storage });

        expect(await queuePendingSubmissionReceipt({
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
        ["ended", "exam_ended"],
        ["archived", "exam_archived"],
        ["group_denied", "access_denied"],
        ["denied", "access_denied"],
        ["not_found", "not_found"],
    ])("stops replay for permanent %s outcomes with a truthful local-only reason", async (status, reason) => {
        const storage = createStorage();
        vi.stubGlobal("window", { localStorage: storage });
        await queuePendingSubmissionReceipt({
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

    it.each(["unauthenticated", "login_required"])(
        "keeps recoverable %s pending until a new login session is observed, then succeeds",
        async status => {
            const storage = createStorage();
            const sessionStorage = createStorage(status === "unauthenticated"
                ? { omr_student_session_generation: "generation-before" }
                : {});
            vi.stubGlobal("window", { localStorage: storage, sessionStorage });
            vi.stubGlobal("sessionStorage", sessionStorage);
            await queuePendingSubmissionReceipt({
                attemptId: `attempt-${status}`,
                input: {
                    examId: "exam-1",
                    submissionId: `submission-${status}`,
                    answers: {},
                    startedAt: "2026-07-28T00:00:00.000Z",
                },
            });

            const blocked = await retryPendingSubmissionReceipt(`attempt-${status}`, {
                submitSignedSessionAttempt: async () => ({ status }),
            });

            expect(blocked.status).toBe("pending");
            expect(readSubmissionReceipt(`attempt-${status}`)).toMatchObject({
                status: "pending",
                retryMode: "manual",
                prerequisite: "login",
                actionDetail: expect.stringContaining("로그인"),
            });
            expect(pendingSubmissionReceiptIds()).toContain(`attempt-${status}`);
            expect(pendingSubmissionReceiptIds({ automaticOnly: true })).not.toContain(`attempt-${status}`);

            sessionStorage.removeItem("omr_student_session_generation");
            expect(pendingSubmissionReceiptIds({ automaticOnly: true })).not.toContain(`attempt-${status}`);
            sessionStorage.setItem("omr_student_session_generation", "generation-after");
            expect(pendingSubmissionReceiptIds({ automaticOnly: true })).toContain(`attempt-${status}`);
            const confirmed = await retryPendingSubmissionReceipt(`attempt-${status}`, {
                submitSignedSessionAttempt: async () => ({
                    status: "ok",
                    attempt: {
                        id: `attempt-server-${status}`,
                        examId: "exam-1",
                        examTitle: "시험",
                        studentName: "학생",
                        startedAt: "2026-07-28T00:00:00.000Z",
                        finishedAt: "2026-07-28T00:02:00.000Z",
                        score: 10,
                        totalScore: 10,
                        answers: {},
                        status: "completed",
                    },
                }),
            });
            expect(confirmed.status).toBe("confirmed");
        },
    );

    it("keeps not_started pending and automatically succeeds on a later retry", async () => {
        const storage = createStorage();
        vi.stubGlobal("window", { localStorage: storage });
        await queuePendingSubmissionReceipt({
            attemptId: "attempt-not-started",
            input: {
                examId: "exam-1",
                submissionId: "submission-not-started",
                answers: {},
                startedAt: "2026-07-28T00:00:00.000Z",
            },
        });
        let calls = 0;
        const submit = async () => {
            calls += 1;
            return calls === 1
                ? { status: "not_started" }
                : {
                    status: "ok",
                    attempt: {
                        id: "attempt-server-not-started",
                        examId: "exam-1",
                        examTitle: "시험",
                        studentName: "학생",
                        startedAt: "2026-07-28T00:00:00.000Z",
                        finishedAt: "2026-07-28T00:02:00.000Z",
                        score: 10,
                        totalScore: 10,
                        answers: {},
                        status: "completed" as const,
                    },
                };
        };

        expect((await retryPendingSubmissionReceipt("attempt-not-started", {
            submitSignedSessionAttempt: submit,
        })).status).toBe("pending");
        expect(readSubmissionReceipt("attempt-not-started")).toMatchObject({
            status: "pending",
            retryMode: "automatic",
            prerequisite: "exam_start",
            actionDetail: "온라인 전환 또는 화면 복귀 시 다시 시도합니다.",
        });
        expect(pendingSubmissionReceiptIds({ automaticOnly: true })).toContain("attempt-not-started");
        expect((await retryPendingSubmissionReceipt("attempt-not-started", {
            submitSignedSessionAttempt: submit,
        })).status).toBe("confirmed");
    });

    it("keeps PIN retries manual across reload, skips network without a PIN, and confirms with a supplied PIN", async () => {
        const storage = createStorage();
        vi.stubGlobal("window", { localStorage: storage });
        await queuePendingSubmissionReceipt({
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

    it("keeps a PIN prerequisite after a transient throw and succeeds on the next manual PIN retry", async () => {
        const storage = createStorage();
        vi.stubGlobal("window", { localStorage: storage });
        await queuePendingSubmissionReceipt({
            attemptId: "attempt-pin-transient",
            input: {
                examId: "exam-1",
                submissionId: "submission-pin-transient",
                answers: { 1: 2 },
                startedAt: "2026-07-28T00:00:00.000Z",
            },
            requiresPin: true,
        });
        let calls = 0;
        const submit = async () => {
            calls += 1;
            if (calls === 1) throw new Error("temporary network failure");
            return {
                status: "ok",
                attempt: {
                    id: "attempt-server-pin-transient",
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
            };
        };

        expect((await retryPendingSubmissionReceipt("attempt-pin-transient", {
            submitSignedSessionAttempt: submit,
            pin: "1111",
        })).status).toBe("pending");
        expect(readSubmissionReceipt("attempt-pin-transient")).toMatchObject({
            status: "pending",
            requiresPin: true,
            retryMode: "manual",
            prerequisite: "pin",
        });
        expect(pendingSubmissionReceiptIds()).toContain("attempt-pin-transient");
        expect(pendingSubmissionReceiptIds({ automaticOnly: true })).not.toContain("attempt-pin-transient");

        expect((await retryPendingSubmissionReceipt("attempt-pin-transient", {
            submitSignedSessionAttempt: submit,
            pin: "2468",
        })).status).toBe("confirmed");
    });

    it("isolates per-attempt envelopes, migrates v1, and quarantines only the corrupt entry", async () => {
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
        expect(await migrateLegacySubmissionReceipts()).toBe(true);
        expect(storage.getItem(`${SUBMISSION_RECEIPT_ENTRY_PREFIX}${encodeURIComponent("attempt-one")}`)).toBeTruthy();
        storage.setItem(`${SUBMISSION_RECEIPT_ENTRY_PREFIX}${encodeURIComponent("attempt-one")}`, "{bad");

        expect(readSubmissionReceipt("attempt-one")).toBeNull();
        expect(readSubmissionReceipt("attempt-two")?.status).toBe("confirmed");
        expect([...Array(storage.length)].map((_, index) => storage.key(index)))
            .not.toEqual(expect.arrayContaining([expect.stringContaining("quarantine")]));
        expect(await migrateLegacySubmissionReceipts()).toBe(true);
        expect(storage.getItem(`${SUBMISSION_RECEIPT_REQUEST_PREFIX}${encodeURIComponent("attempt-one")}`)).toBeNull();
        expect([...Array(storage.length)].map((_, index) => storage.key(index)))
            .toEqual(expect.arrayContaining([expect.stringContaining("quarantine")]));
    });

    it("quarantines malformed legacy data without retaining its raw PIN anywhere", async () => {
        const raw = '{"requests":{"attempt-one":{"pin":"TOP-SECRET-2468"';
        const storage = createStorage({
            omr_student_submission_receipts_v1: raw,
        });
        vi.stubGlobal("window", { localStorage: storage });

        expect(readSubmissionReceipt("attempt-one")).toBeNull();
        expect(storage.getItem("omr_student_submission_receipts_v1")).toBe(raw);
        expect(await migrateLegacySubmissionReceipts()).toBe(true);
        const allValues = [...Array(storage.length)]
            .map((_, index) => storage.getItem(storage.key(index) || "") || "")
            .join("");
        expect(allValues).not.toContain("TOP-SECRET-2468");
        expect(allValues).not.toContain(raw);
        expect(allValues).toContain("byteLength");
    });

    it("does not copy a sensitive corrupt source key into quarantine metadata", async () => {
        const sensitiveAttemptId = "TOP-SECRET-KEY-2468";
        const sensitiveKey = `${SUBMISSION_RECEIPT_ENTRY_PREFIX}${encodeURIComponent(sensitiveAttemptId)}`;
        const storage = createStorage({ [sensitiveKey]: "{bad" });
        vi.stubGlobal("window", { localStorage: storage });

        expect(readSubmissionReceipt(sensitiveAttemptId)).toBeNull();
        expect(storage.getItem(sensitiveKey)).toBe("{bad");
        expect(await migrateLegacySubmissionReceipts()).toBe(true);
        const quarantined = [...Array(storage.length)]
            .flatMap((_, index) => {
                const key = storage.key(index) || "";
                return [key, storage.getItem(key) || ""];
            })
            .join("");
        expect(quarantined).not.toContain(sensitiveAttemptId);
        expect(quarantined).toContain('"sourceKind":"receipt"');
    });

    it("keeps the v1 registry intact when migration is interrupted by quota and resumes later", async () => {
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

        expect(await migrateLegacySubmissionReceipts()).toBe(false);
        expect(storage.getItem("omr_student_submission_receipts_v1")).toBe(legacy);
        expect(storage.getItem("omr_student_submission_receipts_v2_migrated")).toBeNull();

        failMigration = false;
        expect(await migrateLegacySubmissionReceipts()).toBe(true);
        expect(pendingSubmissionReceiptIds()).toEqual(["attempt-one"]);
        expect(storage.getItem("omr_student_submission_receipts_v1")).toBeNull();
    });

    it("migrates a late v1 write even when the v2 marker already exists", async () => {
        const storage = createStorage({
            omr_student_submission_receipts_v2_migrated: "1",
            omr_student_submission_receipts_v1: JSON.stringify({
                receipts: {
                    "attempt-late-v1": {
                        attemptId: "attempt-late-v1",
                        status: "pending",
                        updatedAt: "2026-07-28T00:00:00.000Z",
                    },
                },
                requests: {
                    "attempt-late-v1": {
                        attemptId: "attempt-late-v1",
                        input: {
                            examId: "exam-1",
                            submissionId: "submission-late-v1",
                            answers: {},
                            startedAt: "2026-07-28T00:00:00.000Z",
                        },
                    },
                },
            }),
        });
        vi.stubGlobal("window", { localStorage: storage });

        expect(pendingSubmissionReceiptIds()).toEqual(["attempt-late-v1"]);
        expect(await migrateLegacySubmissionReceipts()).toBe(true);
        expect(storage.getItem("omr_student_submission_receipts_v1")).toBeNull();
    });

    it("bounds migrated confirmed receipts that predate local provenance", async () => {
        const receipts = Object.fromEntries(
            [...Array(120)].map((_, index) => [
                `attempt-legacy-confirmed-${index}`,
                {
                    attemptId: `attempt-legacy-confirmed-${index}`,
                    status: "confirmed",
                    updatedAt: new Date(index * 1_000).toISOString(),
                },
            ]),
        );
        const storage = createStorage({
            omr_student_submission_receipts_v1: JSON.stringify({ receipts }),
        });
        vi.stubGlobal("window", { localStorage: storage });

        expect(await migrateLegacySubmissionReceipts()).toBe(true);
        expect(readSubmissionReceipt("attempt-legacy-confirmed-119")?.status).toBe("confirmed");
        expect(readSubmissionReceipt("attempt-legacy-confirmed-0")).toBeNull();
        const receiptKeys = [...Array(storage.length)]
            .map((_, index) => storage.key(index))
            .filter(key => key?.startsWith(SUBMISSION_RECEIPT_ENTRY_PREFIX));
        expect(receiptKeys).toHaveLength(100);
    });

    it("keeps distinct pending submissions isolated and rejects a stale pending overwrite after confirmation", async () => {
        const storage = createStorage();
        vi.stubGlobal("window", { localStorage: storage });
        expect(await saveLocalAttempts([{
            id: "attempt-one",
            examId: "exam-1",
            examTitle: "시험",
            studentName: "학생",
            startedAt: "2026-07-28T00:00:00.000Z",
            finishedAt: "2026-07-28T00:01:00.000Z",
            score: 10,
            totalScore: 10,
            answers: {},
            status: "completed",
        }])).toBe(true);
        const request = (id: string) => ({
            attemptId: id,
            input: {
                examId: "exam-1",
                submissionId: `submission-${id}`,
                answers: {},
                startedAt: "2026-07-28T00:00:00.000Z",
            },
        });

        expect(await queuePendingSubmissionReceipt(request("attempt-one"))).toBe(true);
        expect(await queuePendingSubmissionReceipt(request("attempt-two"))).toBe(true);
        expect(pendingSubmissionReceiptIds().sort()).toEqual(["attempt-one", "attempt-two"]);
        expect(storage.getItem(`${SUBMISSION_RECEIPT_REQUEST_PREFIX}${encodeURIComponent("attempt-one")}`)).toBeTruthy();
        expect(storage.getItem(`${SUBMISSION_RECEIPT_REQUEST_PREFIX}${encodeURIComponent("attempt-two")}`)).toBeTruthy();

        expect(await persistSubmissionReceipt({
            attemptId: "attempt-one",
            status: "confirmed",
            updatedAt: "2026-07-28T00:02:00.000Z",
        })).toBe(true);
        expect(await queuePendingSubmissionReceipt(request("attempt-one"))).toBe(false);
        expect(readSubmissionReceipt("attempt-one")?.status).toBe("confirmed");
        expect(pendingSubmissionReceiptIds()).toEqual(["attempt-two"]);
    });

    it("serializes a confirmed write ahead of an already queued stale pending write", async () => {
        const storage = createStorage();
        vi.stubGlobal("window", { localStorage: storage });
        const pendingRequest = {
            attemptId: "attempt-interleaved",
            input: {
                examId: "exam-1",
                submissionId: "submission-interleaved",
                answers: {},
                startedAt: "2026-07-28T00:00:00.000Z",
            },
        };
        expect(await saveLocalAttempts([{
            id: "attempt-interleaved",
            examId: "exam-1",
            examTitle: "시험",
            studentName: "학생",
            startedAt: "2026-07-28T00:00:00.000Z",
            finishedAt: "2026-07-28T00:01:00.000Z",
            score: 10,
            totalScore: 10,
            answers: {},
            status: "completed",
        }])).toBe(true);
        expect(await queuePendingSubmissionReceipt(pendingRequest)).toBe(true);

        const tails = new Map<string, Promise<void>>();
        let releaseConfirmedReceipt!: () => void;
        const confirmedReceiptGate = new Promise<void>(resolve => {
            releaseConfirmedReceipt = resolve;
        });
        let confirmedReceiptReached!: () => void;
        const confirmedReceiptStarted = new Promise<void>(resolve => {
            confirmedReceiptReached = resolve;
        });
        let pauseFirstReceiptWrite = true;
        const requestLock = vi.fn(async (
            name: string,
            _options: object,
            operation: () => Promise<unknown> | unknown,
        ) => {
            const previous = tails.get(name) || Promise.resolve();
            let releaseCurrent!: () => void;
            const current = new Promise<void>(resolve => {
                releaseCurrent = resolve;
            });
            tails.set(name, previous.then(() => current));
            await previous;
            try {
                if (name === "omr-storage:submission-receipts" && pauseFirstReceiptWrite) {
                    pauseFirstReceiptWrite = false;
                    confirmedReceiptReached();
                    await confirmedReceiptGate;
                }
                return await operation();
            } finally {
                releaseCurrent();
            }
        });
        vi.stubGlobal("navigator", { locks: { request: requestLock } });

        const confirmedWrite = persistSubmissionReceipt({
            attemptId: "attempt-interleaved",
            status: "confirmed",
            updatedAt: "2026-07-28T00:02:00.000Z",
        });
        await confirmedReceiptStarted;
        const stalePendingWrite = queuePendingSubmissionReceipt(pendingRequest);
        releaseConfirmedReceipt();

        await expect(confirmedWrite).resolves.toBe(true);
        await expect(stalePendingWrite).resolves.toBe(false);
        expect(readSubmissionReceipt("attempt-interleaved")?.status).toBe("confirmed");
        expect(storage.getItem(
            `${SUBMISSION_RECEIPT_REQUEST_PREFIX}${encodeURIComponent("attempt-interleaved")}`,
        )).toBeNull();
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
        await queuePendingSubmissionReceipt({
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
            "omr-storage:submission:attempt-lock",
            { mode: "exclusive" },
            expect.any(Function),
        );
    });

    it("caps confirmed receipts without ever pruning pending requests", async () => {
        const storage = createStorage();
        vi.stubGlobal("window", { localStorage: storage });
        vi.stubGlobal("localStorage", storage);
        await queuePendingSubmissionReceipt({
            attemptId: "attempt-must-stay-pending",
            input: {
                examId: "exam-1",
                submissionId: "submission-must-stay-pending",
                answers: {},
                startedAt: "2026-07-28T00:00:00.000Z",
            },
        });
        const attempts: Attempt[] = [...Array(120)].map((_, index) => ({
            id: `attempt-confirmed-${index}`,
            examId: "exam-1",
            examTitle: "시험",
            studentName: "학생",
            startedAt: "2026-07-28T00:00:00.000Z",
            finishedAt: new Date(index * 1_000).toISOString(),
            score: 10,
            totalScore: 10,
            answers: {},
            status: "completed",
        }));
        expect(await saveLocalAttempts(attempts)).toBe(true);
        for (let index = 0; index < 120; index += 1) {
            expect(await persistSubmissionReceipt({
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
        expect(readSubmissionReceipt("attempt-confirmed-0")).toBeNull();
        const oldest = readLocalAttempts().find(attempt => attempt.id === "attempt-confirmed-0")!;
        const serverRefresh = { ...oldest };
        delete serverRefresh.localSubmissionProvenance;
        expect(await saveLocalAttempts([{ ...serverRefresh, score: 9 }])).toBe(true);
        const refreshed = readLocalAttempts().find(attempt => attempt.id === "attempt-confirmed-0")!;
        expect(refreshed.localSubmissionProvenance).toMatchObject({ source: "server" });
        expect(submissionReceiptForAttempt(refreshed, null, "local")).toMatchObject({
            status: "confirmed",
            attemptId: "attempt-confirmed-0",
        });
    });

    it("rejects new confirmed receipts when local provenance cannot be attached", async () => {
        const storage = createStorage();
        vi.stubGlobal("window", { localStorage: storage });

        for (let index = 0; index < 101; index += 1) {
            expect(await persistSubmissionReceipt({
                attemptId: `attempt-without-cache-${index}`,
                status: "confirmed",
                updatedAt: new Date(index * 1_000).toISOString(),
            })).toBe(false);
        }

        expect(readSubmissionReceipt("attempt-without-cache-0")).toBeNull();
        const receiptKeys = [...Array(storage.length)]
            .map((_, index) => storage.key(index))
            .filter(key => key?.startsWith(SUBMISSION_RECEIPT_ENTRY_PREFIX));
        expect(receiptKeys).toHaveLength(0);
    });

    it("caps old-to-canonical aliases", async () => {
        const storage = createStorage();
        vi.stubGlobal("window", { localStorage: storage });
        for (let index = 0; index < 110; index += 1) {
            const oldId = `attempt-old-${index}`;
            await queuePendingSubmissionReceipt({
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
        await queuePendingSubmissionReceipt({
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
            attempt: expect.objectContaining({
                ...authoritativeAttempt,
                localSubmissionProvenance: expect.objectContaining({ source: "server" }),
            }),
            receipt: expect.objectContaining({
                attemptId: "attempt-server-1",
                status: "confirmed",
            }),
        });
        expect(readSubmissionReceipt("attempt-local-1")).toBeNull();
        expect(readSubmissionReceipt("attempt-server-1")?.status).toBe("confirmed");
        expect(readReconciledSubmissionAttemptId("attempt-local-1")).toBe("attempt-server-1");
        expect(pendingSubmissionReceiptIds()).toEqual([]);
        expect(await queuePendingSubmissionReceipt({
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
        await queuePendingSubmissionReceipt({
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

    it("rolls back before releasing the attempt lock so a later canonical writer and artifacts survive", async () => {
        const lockTails = new Map<string, Promise<unknown>>();
        vi.stubGlobal("navigator", {
            locks: {
                request: (
                    name: string,
                    _options: object,
                    operation: () => Promise<unknown> | unknown,
                ) => {
                    const previous = lockTails.get(name) || Promise.resolve();
                    const current = previous.then(operation, operation);
                    lockTails.set(name, current.catch(() => undefined));
                    return current;
                },
            },
        });
        const localAttempt: Attempt = {
            id: "attempt-local-race",
            examId: "exam-1",
            examTitle: "시험",
            studentName: "학생",
            startedAt: "2026-07-28T00:00:00.000Z",
            finishedAt: "2026-07-28T00:01:00.000Z",
            score: 5,
            totalScore: 10,
            answers: { 1: 2 },
            status: "completed",
        };
        const authoritativeAttempt: Attempt = {
            ...localAttempt,
            id: "attempt-server-race",
            score: 10,
        };
        const laterCanonicalAttempt: Attempt = {
            ...authoritativeAttempt,
            score: 9,
            drawingStrokeCount: 77,
            studentQuestions: [{
                questionId: 1,
                questionNumber: 1,
                body: "later tab artifact",
                createdAt: "2026-07-28T00:03:00.000Z",
                status: "queued",
            }],
        };
        const base = createStorage({ omr_attempts: JSON.stringify([localAttempt]) });
        let failConfirmedReceipt = false;
        let concurrentWrite: Promise<boolean> | undefined;
        const storage = {
            get length() { return base.length; },
            clear() { base.clear(); },
            getItem(key: string) { return base.getItem(key); },
            key(index: number) { return base.key(index); },
            removeItem(key: string) { base.removeItem(key); },
            setItem(key: string, value: string) {
                if (
                    failConfirmedReceipt
                    && key === `${SUBMISSION_RECEIPT_ENTRY_PREFIX}${encodeURIComponent(authoritativeAttempt.id)}`
                ) {
                    failConfirmedReceipt = false;
                    concurrentWrite = saveLocalAttempts([laterCanonicalAttempt]);
                    throw new Error("quota");
                }
                base.setItem(key, value);
            },
        } as Storage;
        vi.stubGlobal("window", { localStorage: storage });
        vi.stubGlobal("localStorage", storage);
        expect(await queuePendingSubmissionReceipt({
            attemptId: localAttempt.id,
            input: {
                examId: "exam-1",
                submissionId: "submission-race",
                answers: { 1: 2 },
                startedAt: localAttempt.startedAt,
            },
        })).toBe(true);
        failConfirmedReceipt = true;

        expect(await retryPendingSubmissionReceipt(localAttempt.id, {
            submitSignedSessionAttempt: async () => ({
                status: "ok",
                attempt: authoritativeAttempt,
            }),
        })).toEqual({
            status: "pending",
            error: "서버 응답은 받았지만 확인 상태를 저장하지 못했습니다. 자동 재시도를 유지합니다.",
        });
        expect(await concurrentWrite).toBe(true);
        expect(readLocalAttempts()).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: localAttempt.id }),
            expect.objectContaining({
                id: authoritativeAttempt.id,
                score: 9,
                drawingStrokeCount: 77,
                studentQuestions: [expect.objectContaining({ body: "later tab artifact" })],
            }),
        ]));
        expect(readSubmissionReceipt(localAttempt.id)?.status).toBe("pending");
        expect(readSubmissionReceipt(authoritativeAttempt.id)).toBeNull();
    });

    it("caches and announces canonical reconciliation after durable confirmation", async () => {
        const storage = createStorage({
            omr_attempts: JSON.stringify([{
                id: "attempt-local-1",
                examId: "exam-1",
                examTitle: "시험",
                studentName: "학생",
                startedAt: "2026-07-28T00:00:00.000Z",
                finishedAt: "2026-07-28T00:01:00.000Z",
                score: 0,
                totalScore: 10,
                answers: {},
                status: "completed",
                drawingStrokeCount: 4,
            }]),
        });
        const dispatchedEvents: Event[] = [];
        const dispatchEvent = vi.fn((event: Event) => {
            dispatchedEvents.push(event);
            return true;
        });
        vi.stubGlobal("window", { localStorage: storage, dispatchEvent });
        await queuePendingSubmissionReceipt({
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
        await retryPendingSubmissionReceipt("attempt-local-1", {
            submitSignedSessionAttempt: async () => ({ status: "ok", attempt: authoritativeAttempt }),
        });

        expect(dispatchEvent).toHaveBeenCalledTimes(1);
        expect((dispatchedEvents[0] as CustomEvent).detail).toMatchObject({
            previousAttemptId: "attempt-local-1",
            attempt: {
                id: authoritativeAttempt.id,
                drawingStrokeCount: 4,
            },
            receipt: { attemptId: "attempt-server-1", status: "confirmed" },
        });
    });

    it("coalesces concurrent retry triggers for the same idempotent submission", async () => {
        const storage = createStorage();
        vi.stubGlobal("window", { localStorage: storage });
        await queuePendingSubmissionReceipt({
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

    it("ignores a tampered retry request whose stored attempt id does not match its key", async () => {
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

    it("caches only server-authoritative selections and grading without an answer key", async () => {
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

    it("keeps official statuses when review uses an answer-key-free student exam", async () => {
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
