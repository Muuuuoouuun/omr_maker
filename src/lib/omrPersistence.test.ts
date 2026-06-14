import { afterEach, describe, expect, it, vi } from "vitest";
import type { Attempt, Exam } from "@/types/omr";
import {
    attemptFromSupabaseRow,
    attemptToSupabaseRow,
    deleteExam,
    examFromSupabaseRow,
    examToSupabaseRow,
    getSupabaseConfigFromEnv,
    sortByNewestActivity,
} from "./omrPersistence";

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

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("Supabase persistence mapping", () => {
    const exam: Exam = {
        id: "exam-1",
        title: "Final OMR",
        createdAt: "2026-06-13T10:00:00.000Z",
        updatedAt: "2026-06-14T10:00:00.000Z",
        archived: false,
        durationMin: 45,
        questions: [{ id: 1, number: 1, answer: 3, choices: 5 }],
    };

    const attempt: Attempt = {
        id: "attempt-1",
        examId: "exam-1",
        examTitle: "Final OMR",
        studentName: "Kim",
        studentId: "class-a::Kim",
        groupId: "class-a",
        groupName: "Class A",
        identityType: "temporary",
        startedAt: "2026-06-14T09:00:00.000Z",
        finishedAt: "2026-06-14T09:30:00.000Z",
        score: 95,
        totalScore: 100,
        answers: { 1: 3 },
        status: "completed",
    };

    it("stores exams as indexed rows with the full exam payload", () => {
        const row = examToSupabaseRow(exam);

        expect(row).toMatchObject({
            id: "exam-1",
            title: "Final OMR",
            created_at: "2026-06-13T10:00:00.000Z",
            updated_at: "2026-06-14T10:00:00.000Z",
            archived: false,
        });
        expect(row.payload).toEqual(exam);
        expect(examFromSupabaseRow(row)).toEqual(exam);
    });

    it("stores attempts as indexed rows with the full attempt payload", () => {
        const row = attemptToSupabaseRow(attempt);

        expect(row).toMatchObject({
            id: "attempt-1",
            exam_id: "exam-1",
            student_name: "Kim",
            student_id: "class-a::Kim",
            group_id: "class-a",
            group_name: "Class A",
            finished_at: "2026-06-14T09:30:00.000Z",
        });
        expect(row.payload).toEqual(attempt);
        expect(attemptFromSupabaseRow(row)).toEqual(attempt);
    });

    it("sorts the newest changed items first", () => {
        const older = { ...exam, id: "old", updatedAt: "2026-06-10T00:00:00.000Z" };
        const newer = { ...exam, id: "new", updatedAt: "2026-06-12T00:00:00.000Z" };
        const createdOnly = { ...exam, id: "created-only", updatedAt: undefined, createdAt: "2026-06-11T00:00:00.000Z" };

        expect(sortByNewestActivity([older, newer, createdOnly]).map(item => item.id)).toEqual([
            "new",
            "created-only",
            "old",
        ]);
    });
});

describe("Supabase config", () => {
    it("returns null until both browser-safe env vars are present", () => {
        expect(getSupabaseConfigFromEnv({})).toBeNull();
        expect(getSupabaseConfigFromEnv({
            NEXT_PUBLIC_SUPABASE_URL: "https://wqhiajvisirxdjivhmlt.supabase.co",
        })).toBeNull();
    });

    it("accepts publishable keys and trims accidental whitespace", () => {
        expect(getSupabaseConfigFromEnv({
            NEXT_PUBLIC_SUPABASE_URL: " https://wqhiajvisirxdjivhmlt.supabase.co ",
            NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: " sb_publishable_abc ",
        })).toEqual({
            url: "https://wqhiajvisirxdjivhmlt.supabase.co",
            publishableKey: "sb_publishable_abc",
        });
    });
});

describe("Exam deletion", () => {
    it("removes the local exam and its attempts when remote sync is not configured", async () => {
        const exam: Exam = {
            id: "exam-1",
            title: "Delete me",
            createdAt: "2026-06-13T10:00:00.000Z",
            questions: [],
        };
        const attempt: Attempt = {
            id: "attempt-1",
            examId: "exam-1",
            examTitle: "Delete me",
            studentName: "Kim",
            startedAt: "2026-06-14T09:00:00.000Z",
            finishedAt: "2026-06-14T09:30:00.000Z",
            score: 10,
            totalScore: 10,
            answers: {},
            status: "completed",
        };
        const otherAttempt: Attempt = {
            ...attempt,
            id: "attempt-2",
            examId: "exam-2",
            examTitle: "Keep me",
        };
        const storage = createStorage({
            "omr_exam_exam-1": JSON.stringify(exam),
            "omr_attempts": JSON.stringify([attempt, otherAttempt]),
        });

        vi.stubGlobal("window", { localStorage: storage });
        vi.stubGlobal("localStorage", storage);

        const result = await deleteExam("exam-1");

        expect(result).toEqual({ localSaved: true, remoteSaved: false });
        expect(storage.getItem("omr_exam_exam-1")).toBeNull();
        expect(JSON.parse(storage.getItem("omr_attempts") || "[]")).toEqual([otherAttempt]);
    });
});
