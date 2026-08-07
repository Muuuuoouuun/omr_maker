import { describe, expect, it } from "vitest";
import {
    mergeCanonicalTeacherNotifications,
    normalizeTeacherNotificationSummary,
    notificationsFromTeacherSummary,
    resolveTeacherNotificationRefresh,
} from "./teacherNotificationSummary";

const RECENT_V1 = "11111111111111111111111111111111";
const RECENT_V2 = "22222222222222222222222222222222";
const QUEUED_V1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const QUEUED_V2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SCOPE_KEY = "scope_abcdefghijklmnopqrstuvwxyz0123456789";

describe("teacher notification summary", () => {
    it("accepts Supabase bigint strings without accepting malformed or unsafe counts", () => {
        expect(normalizeTeacherNotificationSummary({
            recent_completed_attempt_count: "3",
            queued_student_question_count: 2,
            recent_event_version: RECENT_V1,
            queued_event_version: QUEUED_V1,
        })).toEqual({
            recentCompletedAttemptCount: 3,
            queuedStudentQuestionCount: 2,
            recentEventVersion: RECENT_V1,
            queuedEventVersion: QUEUED_V1,
        });
        expect(normalizeTeacherNotificationSummary({
            recent_completed_attempt_count: "-1",
            queued_student_question_count: 2,
            recent_event_version: RECENT_V1,
            queued_event_version: QUEUED_V1,
        })).toBeNull();
        expect(normalizeTeacherNotificationSummary({
            recent_completed_attempt_count: "9007199254740992",
            queued_student_question_count: 2,
            recent_event_version: RECENT_V1,
            queued_event_version: QUEUED_V1,
        })).toBeNull();
        expect(normalizeTeacherNotificationSummary([{ recent_completed_attempt_count: "1" }])).toBeNull();
    });

    it("fails closed on missing, malformed, or unbounded event versions", () => {
        for (const recent_event_version of [undefined, "2026-99-99", "A".repeat(32), "a".repeat(4096)]) {
            expect(normalizeTeacherNotificationSummary({
                recent_completed_attempt_count: 1,
                queued_student_question_count: 0,
                recent_event_version,
                queued_event_version: "none",
            })).toBeNull();
        }
        expect(normalizeTeacherNotificationSummary({
            recent_completed_attempt_count: 0,
            queued_student_question_count: 1,
            recent_event_version: "none",
            queued_event_version: "not-a-version",
        })).toBeNull();
    });

    it("creates bounded notifications with deterministic content-scoped ids", () => {
        expect(notificationsFromTeacherSummary({
            recentCompletedAttemptCount: 4,
            queuedStudentQuestionCount: 2,
            recentEventVersion: RECENT_V1,
            queuedEventVersion: QUEUED_V1,
        })).toEqual([
            expect.objectContaining({
                id: `auto-recent-exams:4:${RECENT_V1}`,
                source: "recent-exams",
                message: "최근 24시간 내 4개 시험 제출 완료",
            }),
            expect.objectContaining({
                id: `auto-student-questions:2:${QUEUED_V1}`,
                source: "student-questions",
                message: "2건의 학생 질문이 답변을 기다립니다",
            }),
        ]);
        expect(notificationsFromTeacherSummary({
            recentCompletedAttemptCount: 0,
            queuedStudentQuestionCount: 0,
            recentEventVersion: "none",
            queuedEventVersion: "none",
        })).toEqual([]);
    });

    it("gives count-preserving replacement events different stable ids", () => {
        const first = notificationsFromTeacherSummary({
            recentCompletedAttemptCount: 1,
            queuedStudentQuestionCount: 1,
            recentEventVersion: RECENT_V1,
            queuedEventVersion: QUEUED_V1,
        });
        const replacement = notificationsFromTeacherSummary({
            recentCompletedAttemptCount: 1,
            queuedStudentQuestionCount: 1,
            recentEventVersion: RECENT_V2,
            queuedEventVersion: QUEUED_V2,
        });
        expect(first.map(item => item.id)).not.toEqual(replacement.map(item => item.id));
    });

    it("replaces only canonical server sources and retains local-only categories", () => {
        const local = [
            { id: "auto-invites:1", source: "invites" as const, title: "초대" },
            { id: "auto-recent-exams:99", source: "recent-exams" as const, title: "낡은 제출" },
            { id: "auto-kakao:1", source: "kakao-candidates" as const, title: "발송 후보" },
            { id: "auto-student-questions:99", source: "student-questions" as const, title: "낡은 질문" },
        ];
        const canonical = notificationsFromTeacherSummary({
            recentCompletedAttemptCount: 2,
            queuedStudentQuestionCount: 1,
            recentEventVersion: RECENT_V1,
            queuedEventVersion: QUEUED_V1,
        });

        expect(mergeCanonicalTeacherNotifications(local, canonical).map(item => item.id)).toEqual([
            "auto-invites:1",
            "auto-kakao:1",
            `auto-recent-exams:2:${RECENT_V1}`,
            `auto-student-questions:1:${QUEUED_V1}`,
        ]);
    });

    it("uses account-scoped server state as canonical and never reads browser state after canonical load", () => {
        let persistedReads = 0;
        let dismissalReads = 0;
        let localFallbackReads = 0;
        const canonicalId = `auto-recent-exams:1:${RECENT_V1}`;
        const resolved = resolveTeacherNotificationRefresh({
            status: "loaded",
            summary: {
                recentCompletedAttemptCount: 1,
                queuedStudentQuestionCount: 0,
                recentEventVersion: RECENT_V1,
                queuedEventVersion: "none",
                scopeKey: SCOPE_KEY,
                notificationStates: [{ notificationId: canonicalId, read: true, dismissed: false }],
            },
        }, {
            readPersisted() {
                persistedReads += 1;
                return [
                    { id: canonicalId, source: "recent-exams", unread: false },
                    { id: "manual-scoped", unread: true },
                ];
            },
            readDismissed(key) {
                dismissalReads += 1;
                expect(key).toContain(SCOPE_KEY);
                return [];
            },
            computeLocalFallback() {
                localFallbackReads += 1;
                return [{ id: "private-other-account", unread: true }];
            },
        });

        expect(persistedReads).toBe(0);
        expect(dismissalReads).toBe(0);
        expect(localFallbackReads).toBe(0);
        expect(resolved.shouldPersist).toBe(false);
        expect(resolved.notifications).toEqual([
            expect.objectContaining({ id: canonicalId, unread: false }),
        ]);
    });

    it("filters server-dismissed ids while a replacement id remains visible and unread", () => {
        const oldId = `auto-recent-exams:1:${RECENT_V1}`;
        const replacementId = `auto-recent-exams:1:${RECENT_V2}`;
        const dismissed = resolveTeacherNotificationRefresh({
            status: "loaded",
            summary: {
                recentCompletedAttemptCount: 1,
                queuedStudentQuestionCount: 0,
                recentEventVersion: RECENT_V1,
                queuedEventVersion: "none",
                scopeKey: SCOPE_KEY,
                notificationStates: [{ notificationId: oldId, read: true, dismissed: true }],
            },
        }, {
            readPersisted() { return []; },
            readDismissed() { return []; },
            computeLocalFallback() { return []; },
        });
        expect(dismissed.notifications).toEqual([]);

        const replacement = resolveTeacherNotificationRefresh({
            status: "loaded",
            summary: {
                recentCompletedAttemptCount: 1,
                queuedStudentQuestionCount: 0,
                recentEventVersion: RECENT_V2,
                queuedEventVersion: "none",
                scopeKey: SCOPE_KEY,
                notificationStates: [],
            },
        }, {
            readPersisted() { return []; },
            readDismissed() { return []; },
            computeLocalFallback() { return []; },
        });
        expect(replacement.notifications).toEqual([
            expect.objectContaining({ id: replacementId, unread: true }),
        ]);
    });

    it("shows no persisted account data on production failure or unauthorized access", () => {
        for (const status of ["service_unavailable", "unauthorized"] as const) {
            let reads = 0;
            const resolved = resolveTeacherNotificationRefresh({ status }, {
                readPersisted() { reads += 1; return [{ id: "private-old-account", unread: true }]; },
                readDismissed() { reads += 1; return []; },
                computeLocalFallback() { reads += 1; return [{ id: "private-local", unread: true }]; },
            });
            expect(reads).toBe(0);
            expect(resolved.namespace).toBeNull();
            expect(resolved.shouldPersist).toBe(false);
            expect(JSON.stringify(resolved.notifications)).not.toContain("private");
            if (status === "service_unavailable") {
                expect(resolved.notifications).toEqual([expect.objectContaining({ source: "sync-status" })]);
            } else {
                expect(resolved.notifications).toEqual([]);
            }
        }
    });

    it("uses the legacy local snapshot only for explicit development local-only mode", () => {
        let localFallbackReads = 0;
        const resolved = resolveTeacherNotificationRefresh({ status: "local_only" }, {
            readPersisted() { return []; },
            readDismissed() { return []; },
            computeLocalFallback() {
                localFallbackReads += 1;
                return [{ id: "dev-local", source: "invites", unread: true }];
            },
        });
        expect(localFallbackReads).toBe(1);
        expect(resolved.namespace).not.toBeNull();
        expect(resolved.notifications).toEqual([{ id: "dev-local", source: "invites", unread: true }]);
        expect(resolved.shouldPersist).toBe(true);
    });
});
