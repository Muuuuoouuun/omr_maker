import { describe, expect, it } from "vitest";
import {
    applyTeacherNotificationStates,
    normalizeTeacherNotificationStateRows,
    validateTeacherNotificationIds,
} from "./teacherNotificationState";

const RECENT_ID = "auto-recent-exams:3:11111111111111111111111111111111";
const QUESTION_ID = "auto-student-questions:2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("teacher notification canonical state", () => {
    it("accepts only a bounded unique list of deterministic canonical ids", () => {
        expect(validateTeacherNotificationIds([RECENT_ID, QUESTION_ID])).toEqual([RECENT_ID, QUESTION_ID]);
        expect(validateTeacherNotificationIds([RECENT_ID, RECENT_ID])).toBeNull();
        expect(validateTeacherNotificationIds(["auto-recent-exams:3:not-a-hash"])).toBeNull();
        expect(validateTeacherNotificationIds(["manual-client-controlled"])).toBeNull();
        expect(validateTeacherNotificationIds(Array.from({ length: 17 }, (_, index) =>
            `auto-recent-exams:${index + 1}:${String(index).padStart(32, "0")}`,
        ))).toBeNull();
    });

    it("normalizes only unique requested rows with valid bounded timestamps", () => {
        expect(normalizeTeacherNotificationStateRows([
            { notification_id: RECENT_ID, read_at: "2026-08-07T01:02:03.000Z", dismissed_at: null },
            { notification_id: QUESTION_ID, read_at: "2026-08-07T01:03:00.000Z", dismissed_at: "2026-08-07T01:04:00.000Z" },
        ], [RECENT_ID, QUESTION_ID])).toEqual([
            { notificationId: RECENT_ID, read: true, dismissed: false },
            { notificationId: QUESTION_ID, read: true, dismissed: true },
        ]);

        expect(normalizeTeacherNotificationStateRows([
            { notification_id: "auto-recent-exams:1:22222222222222222222222222222222", read_at: "2026-08-07T01:02:03.000Z", dismissed_at: null },
        ], [RECENT_ID])).toBeNull();
        expect(normalizeTeacherNotificationStateRows([
            { notification_id: RECENT_ID, read_at: null, dismissed_at: "2026-08-07T01:04:00.000Z" },
        ], [RECENT_ID])).toBeNull();
        expect(normalizeTeacherNotificationStateRows([
            { notification_id: RECENT_ID, read_at: "x".repeat(128), dismissed_at: null },
        ], [RECENT_ID])).toBeNull();
    });

    it("applies server state without allowing a read mutation to resurrect a dismissed item", () => {
        const notifications = [
            { id: RECENT_ID, unread: true, title: "최근 시험" },
            { id: QUESTION_ID, unread: true, title: "학생 질문" },
        ];
        expect(applyTeacherNotificationStates(notifications, [
            { notificationId: RECENT_ID, read: true, dismissed: false },
            { notificationId: QUESTION_ID, read: true, dismissed: true },
        ])).toEqual([
            { id: RECENT_ID, unread: false, title: "최근 시험" },
        ]);
    });
});
