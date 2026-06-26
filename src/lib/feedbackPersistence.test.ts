import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Attempt } from "@/types/omr";
import {
    DEFAULT_FEEDBACK_DOWNLOAD_POLICY,
    canDownloadReturnedFeedback,
    createAttemptFeedbackDraft,
    feedbackFromSupabaseRow,
    feedbackToSupabaseRow,
    loadLocalReturnedAttemptFeedback,
    markFeedbackOpened,
    mergePdfDrawings,
    readLocalAttemptFeedback,
    returnAttemptFeedback,
    saveLocalAttemptFeedback,
    sanitizeAttemptFeedbackPayload,
} from "./feedbackPersistence";

function createStorage(initial: Record<string, string> = {}): Storage {
    const data = new Map(Object.entries(initial));

    return {
        get length() {
            return data.size;
        },
        clear() {
            data.clear();
        },
        getItem(key: string) {
            return data.get(key) ?? null;
        },
        key(index: number) {
            return [...data.keys()][index] ?? null;
        },
        removeItem(key: string) {
            data.delete(key);
        },
        setItem(key: string, value: string) {
            data.set(key, value);
        },
    } as Storage;
}

const attempt: Attempt = {
    id: "attempt-1",
    examId: "exam-1",
    examTitle: "Final OMR",
    organizationId: "org-1",
    studentProfileId: "student-1",
    studentName: "Kim",
    startedAt: "2026-06-26T09:00:00.000Z",
    finishedAt: "2026-06-26T09:30:00.000Z",
    score: 80,
    totalScore: 100,
    answers: { 1: 2 },
    status: "completed",
};

beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe("feedback persistence", () => {
    it("creates a stable draft for an attempt", () => {
        const draft = createAttemptFeedbackDraft(attempt, "2026-06-26T10:00:00.000Z");

        expect(draft).toMatchObject({
            id: "feedback:attempt-1",
            attemptId: "attempt-1",
            examId: "exam-1",
            organizationId: "org-1",
            studentProfileId: "student-1",
            status: "draft",
            downloadPolicy: DEFAULT_FEEDBACK_DOWNLOAD_POLICY,
            delivery: {
                notificationStatus: "not_queued",
                notificationChannel: "in_app",
                openCount: 0,
            },
        });
    });

    it("saves, returns, and marks feedback as opened", async () => {
        const localStorage = createStorage();
        vi.stubGlobal("window", { localStorage });
        vi.stubGlobal("localStorage", localStorage);
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-06-26T10:00:00.000Z"));

        const draft = {
            ...createAttemptFeedbackDraft(attempt, "2026-06-26T10:00:00.000Z"),
            summary: "Good correction notes",
            downloadPolicy: {
                ...DEFAULT_FEEDBACK_DOWNLOAD_POLICY,
                allowStudentDownload: true,
            },
        };
        expect(saveLocalAttemptFeedback(draft)).toBe(true);
        expect(readLocalAttemptFeedback()).toHaveLength(1);

        await expect(returnAttemptFeedback(draft.id)).resolves.toMatchObject({ localSaved: true });
        const returned = loadLocalReturnedAttemptFeedback(attempt.id);
        expect(returned).toMatchObject({
            status: "returned",
            returnedAt: "2026-06-26T10:00:00.000Z",
            delivery: expect.objectContaining({
                notificationStatus: "queued",
                notifiedAt: "2026-06-26T10:00:00.000Z",
            }),
        });

        vi.setSystemTime(new Date("2026-06-26T10:05:00.000Z"));
        await expect(markFeedbackOpened(draft.id)).resolves.toMatchObject({ localSaved: true });

        const opened = loadLocalReturnedAttemptFeedback(attempt.id);
        expect(opened?.delivery).toMatchObject({
            notificationStatus: "sent",
            firstOpenedAt: "2026-06-26T10:05:00.000Z",
            lastOpenedAt: "2026-06-26T10:05:00.000Z",
            openCount: 1,
        });
    });

    it("enforces local download policy and expiry", () => {
        const returned = {
            ...createAttemptFeedbackDraft(attempt, "2026-06-26T10:00:00.000Z"),
            status: "returned" as const,
            returnedAt: "2026-06-26T10:00:00.000Z",
        };

        expect(canDownloadReturnedFeedback(returned, new Date("2026-06-26T10:10:00.000Z"))).toBe(false);
        expect(canDownloadReturnedFeedback({
            ...returned,
            downloadPolicy: {
                allowStudentDownload: true,
                allowAnnotatedPdfDownload: false,
                expiresAt: "2026-06-26T10:20:00.000Z",
            },
        }, new Date("2026-06-26T10:10:00.000Z"))).toBe(true);
        expect(canDownloadReturnedFeedback({
            ...returned,
            downloadPolicy: {
                allowStudentDownload: true,
                allowAnnotatedPdfDownload: false,
                expiresAt: "2026-06-26T10:20:00.000Z",
            },
        }, new Date("2026-06-26T10:21:00.000Z"))).toBe(false);
    });

    it("sanitizes comments and merges drawing layers without mutating sources", () => {
        const sanitized = sanitizeAttemptFeedbackPayload({
            ...createAttemptFeedbackDraft(attempt, "2026-06-26T10:00:00.000Z"),
            questionComments: [
                { id: "c1", questionId: 1, questionNumber: 1, body: "Check units", visibility: "student_visible" },
                { id: "bad", questionId: "x", questionNumber: 2, body: "" },
            ],
        });

        expect(sanitized?.questionComments).toEqual([
            { id: "c1", questionId: 1, questionNumber: 1, body: "Check units", visibility: "student_visible" },
        ]);

        const student = { 1: ["s1"], 2: ["s2"] };
        const teacher = { 1: ["t1"] };
        expect(mergePdfDrawings(student, teacher)).toEqual({ 1: ["s1", "t1"], 2: ["s2"] });
        expect(student).toEqual({ 1: ["s1"], 2: ["s2"] });
    });

    it("maps feedback to and from Supabase rows with receipt and markup drawings", () => {
        const feedback = {
            ...createAttemptFeedbackDraft(attempt, "2026-06-26T10:00:00.000Z"),
            teacherUserId: "teacher-1",
            status: "returned" as const,
            summary: "Review the unit conversion.",
            questionComments: [
                { id: "c1", questionId: 1, questionNumber: 1, body: "Check units", visibility: "student_visible" as const },
            ],
            delivery: {
                notificationStatus: "queued" as const,
                notificationChannel: "in_app" as const,
                notifiedAt: "2026-06-26T10:05:00.000Z",
                openCount: 0,
            },
            returnedAt: "2026-06-26T10:05:00.000Z",
            updatedAt: "2026-06-26T10:05:00.000Z",
        };

        const row = feedbackToSupabaseRow(feedback, {
            organizationId: "org-1",
            organizationName: "Class",
            actorUserId: "teacher-1",
        }, { 1: ["M 0 0 L 1 1"] });

        expect(row).toMatchObject({
            id: "feedback:attempt-1",
            organization_id: "org-1",
            attempt_id: "attempt-1",
            student_profile_id: "student-1",
            teacher_user_id: "teacher-1",
            status: "returned",
            notification_status: "queued",
            open_count: 0,
            markup_drawings: { 1: ["M 0 0 L 1 1"] },
        });

        expect(feedbackFromSupabaseRow(row)).toMatchObject({
            id: "feedback:attempt-1",
            attemptId: "attempt-1",
            status: "returned",
            summary: "Review the unit conversion.",
            delivery: expect.objectContaining({ notificationStatus: "queued" }),
        });
    });
});
