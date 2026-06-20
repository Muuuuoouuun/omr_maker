import { afterEach, describe, expect, it, vi } from "vitest";
import type { Attempt } from "@/types/omr";
import {
    attemptBelongsToSession,
    attemptMatchesStudentProfile,
    clearSession,
    consumePendingGuestMerge,
    getSession,
    mergeGuestAttempts,
    previewGuestMerge,
    queueGuestMerge,
    readPendingGuestMerge,
    readStoredGuestId,
    saveSession,
    STORAGE_KEYS,
    type StudentSession,
} from "./storage";

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

function stubBrowserStorage(localStorage: Storage, sessionStorage: Storage = localStorage) {
    vi.stubGlobal("window", { localStorage, sessionStorage });
    vi.stubGlobal("localStorage", localStorage);
    vi.stubGlobal("sessionStorage", sessionStorage);
}

function attempt(overrides: Partial<Attempt>): Attempt {
    return {
        id: "attempt-1",
        examId: "exam-1",
        examTitle: "중간고사",
        studentName: "Guest Student",
        startedAt: "2026-06-15T09:00:00.000Z",
        finishedAt: "2026-06-15T09:30:00.000Z",
        score: 80,
        totalScore: 100,
        answers: { 1: 2 },
        status: "completed",
        ...overrides,
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("student storage helpers", () => {
    it("preserves normalized region snapshots in student sessions", () => {
        const localStorage = createStorage();
        const sessionStorage = createStorage();
        stubBrowserStorage(localStorage, sessionStorage);

        saveSession({
            studentId: "class-a::김학생",
            loginId: "class-a::김학생",
            name: "김학생",
            groupId: "class-a",
            groupName: "A반",
            regionId: " 서울 ",
            regionName: " 서울 ",
            isGuest: false,
            identityType: "temporary",
        });

        expect(getSession()).toMatchObject({
            studentId: "class-a::김학생",
            regionId: "서울",
            regionName: "서울",
        });
        expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.STUDENT_SESSION_BACKUP) || "{}")).toMatchObject({
            studentId: "class-a::김학생",
            name: "김학생",
        });
    });

    it("restores a same-device student session backup after tab session storage is gone", () => {
        const localStorage = createStorage();
        const sessionStorage = createStorage();
        stubBrowserStorage(localStorage, sessionStorage);
        const session: StudentSession = {
            studentId: "class-a::김학생",
            loginId: "class-a::김학생",
            name: "김학생",
            groupId: "class-a",
            groupName: "A반",
            regionId: "서울",
            regionName: "서울",
            isGuest: false,
            identityType: "temporary",
        };
        saveSession(session);
        sessionStorage.removeItem(STORAGE_KEYS.STUDENT_SESSION);

        expect(getSession()).toMatchObject({
            studentId: "class-a::김학생",
            name: "김학생",
            regionName: "서울",
        });
        expect(JSON.parse(sessionStorage.getItem(STORAGE_KEYS.STUDENT_SESSION) || "{}")).toMatchObject({
            studentId: "class-a::김학생",
        });
    });

    it("clears both active and persistent student sessions on logout", () => {
        const localStorage = createStorage();
        const sessionStorage = createStorage();
        stubBrowserStorage(localStorage, sessionStorage);

        saveSession({
            studentId: "class-a::김학생",
            name: "김학생",
            groupId: "class-a",
            groupName: "A반",
            isGuest: false,
            identityType: "temporary",
        });
        clearSession();

        expect(sessionStorage.getItem(STORAGE_KEYS.STUDENT_SESSION)).toBeNull();
        expect(localStorage.getItem(STORAGE_KEYS.STUDENT_SESSION_BACKUP)).toBeNull();
    });

    it("queues and consumes a pending guest merge once", () => {
        const localStorage = createStorage();
        stubBrowserStorage(localStorage);

        expect(queueGuestMerge("guest-1")).toBe(true);
        expect(readPendingGuestMerge()).toMatchObject({ guestId: "guest-1" });
        expect(consumePendingGuestMerge()).toMatchObject({ guestId: "guest-1" });
        expect(consumePendingGuestMerge()).toBeNull();
    });

    it("previews mergeable guest attempts without counting already linked records", () => {
        const attempts = [
            attempt({ id: "guest-new", guestId: "guest-1", identityType: "guest", examTitle: "중간고사", finishedAt: "2026-06-15T09:30:00.000Z" }),
            attempt({ id: "guest-newer", guestId: "guest-1", identityType: "guest", examTitle: "기말고사", finishedAt: "2026-06-16T09:30:00.000Z" }),
            attempt({ id: "already-linked", guestId: "guest-1", studentId: "class-a::김학생", identityType: "temporary", mergedFromGuestId: "guest-1" }),
            attempt({ id: "other-guest", guestId: "guest-2", identityType: "guest" }),
        ];
        const localStorage = createStorage({
            [STORAGE_KEYS.GUEST_ID]: "guest-1",
            [STORAGE_KEYS.ATTEMPTS]: JSON.stringify(attempts),
        });
        stubBrowserStorage(localStorage);

        expect(readStoredGuestId()).toBe("guest-1");
        expect(previewGuestMerge("guest-1")).toEqual({
            guestId: "guest-1",
            mergeableCount: 2,
            alreadyLinkedCount: 1,
            latestFinishedAt: "2026-06-16T09:30:00.000Z",
            examTitles: ["기말고사", "중간고사"],
            attemptIds: ["guest-newer", "guest-new"],
        });
    });

    it("merges only matching guest attempts into the selected student profile", () => {
        const attempts = [
            attempt({ id: "guest-match", guestId: "guest-1", identityType: "guest" }),
            attempt({ id: "other-guest", guestId: "guest-2", identityType: "guest" }),
        ];
        const localStorage = createStorage({
            [STORAGE_KEYS.ATTEMPTS]: JSON.stringify(attempts),
        });
        stubBrowserStorage(localStorage);

        const mergedCount = mergeGuestAttempts("guest-1", {
            studentId: "class-a::김학생",
            name: "김학생",
            groupId: "class-a",
            groupName: "A반",
            regionId: "서울",
            regionName: "서울",
            identityType: "temporary",
        });

        const updated = JSON.parse(localStorage.getItem(STORAGE_KEYS.ATTEMPTS) || "[]") as Attempt[];
        expect(mergedCount).toBe(1);
        expect(updated.find(a => a.id === "guest-match")).toMatchObject({
            studentId: "class-a::김학생",
            studentName: "김학생",
            groupId: "class-a",
            groupName: "A반",
            regionId: "서울",
            regionName: "서울",
            identityType: "temporary",
            mergedFromGuestId: "guest-1",
        });
        expect(updated.find(a => a.id === "other-guest")).toMatchObject({
            guestId: "guest-2",
            identityType: "guest",
        });

        expect(mergeGuestAttempts("guest-1", {
            studentId: "class-a::김학생",
            name: "김학생",
            groupId: "class-a",
            groupName: "A반",
            regionId: "서울",
            regionName: "서울",
            identityType: "temporary",
        })).toBe(0);
    });

    it("does not expose ambiguous legacy name-only attempts across classes", () => {
        const session: StudentSession = {
            studentId: "class-b::김학생",
            loginId: "class-b::김학생",
            name: "김학생",
            groupId: "class-b",
            groupName: "B반",
            isGuest: false,
            identityType: "temporary",
        };

        expect(attemptBelongsToSession(attempt({
            id: "ambiguous",
            studentName: "김학생",
        }), session)).toBe(false);

        expect(attemptBelongsToSession(attempt({
            id: "wrong-class",
            studentName: "김학생",
            groupId: "class-a",
            groupName: "A반",
        }), session)).toBe(false);

        expect(attemptBelongsToSession(attempt({
            id: "right-class",
            studentName: "김학생",
            groupId: "class-b",
            groupName: "B반",
        }), session)).toBe(true);
    });

    it("keeps roster matching from using name-only attempts for grouped students", () => {
        const student = { id: "student-1", name: "김학생", group: "B반" };

        expect(attemptMatchesStudentProfile(attempt({
            id: "ambiguous",
            studentName: "김학생",
        }), student)).toBe(false);

        expect(attemptMatchesStudentProfile(attempt({
            id: "group-match",
            studentName: "김학생",
            groupName: "B반",
        }), student)).toBe(true);
    });

    it("matches roster profiles across scoped legacy student ids without leaking other classes", () => {
        const student = { id: "class-a::김학생", name: "김학생", group: "A반" };

        expect(attemptMatchesStudentProfile(attempt({
            id: "legacy-name-group",
            studentId: "A반::김학생",
            studentName: "김학생",
        }), student)).toBe(true);

        expect(attemptMatchesStudentProfile(attempt({
            id: "canonical-group",
            studentId: "class-a::김학생",
            studentName: "김학생",
        }), student)).toBe(true);

        expect(attemptMatchesStudentProfile(attempt({
            id: "other-class",
            studentId: "class-b::김학생",
            studentName: "김학생",
        }), student)).toBe(false);
    });

    it("does not match same-name same-class roster students across different regions", () => {
        const student = { id: "서울/A반::김학생", name: "김학생", group: "A반", region: "서울" };

        expect(attemptMatchesStudentProfile(attempt({
            id: "seoul",
            studentId: undefined,
            studentName: "김학생",
            groupName: "A반",
            regionName: "서울",
        }), student)).toBe(true);

        expect(attemptMatchesStudentProfile(attempt({
            id: "busan",
            studentId: undefined,
            studentName: "김학생",
            groupName: "A반",
            regionName: "부산",
        }), student)).toBe(false);
    });

    it("updates question result rows when merging guest attempts into a student profile", () => {
        const attempts = [
            attempt({
                id: "guest-match",
                guestId: "guest-1",
                identityType: "guest",
                studentId: "guest:guest-1",
                questionResults: [
                    {
                        schemaVersion: 1,
                        attemptId: "guest-match",
                        examId: "exam-1",
                        examTitle: "중간고사",
                        studentName: "Guest Student",
                        studentId: "guest:guest-1",
                        identityType: "guest",
                        questionId: 1,
                        questionNumber: 1,
                        score: 5,
                        earnedScore: 0,
                        status: "wrong",
                        isCorrect: false,
                        isWrong: true,
                        isUnanswered: false,
                        finishedAt: "2026-06-15T09:30:00.000Z",
                    },
                ],
            }),
        ];
        const localStorage = createStorage({
            [STORAGE_KEYS.ATTEMPTS]: JSON.stringify(attempts),
        });
        stubBrowserStorage(localStorage);

        mergeGuestAttempts("guest-1", {
            studentId: "class-a::김학생",
            name: "김학생",
            groupId: "class-a",
            groupName: "A반",
            regionId: "서울",
            regionName: "서울",
            identityType: "temporary",
        });

        const updated = JSON.parse(localStorage.getItem(STORAGE_KEYS.ATTEMPTS) || "[]") as Attempt[];
        expect(updated[0].questionResults?.[0]).toMatchObject({
            studentName: "김학생",
            studentId: "class-a::김학생",
            groupId: "class-a",
            groupName: "A반",
            regionId: "서울",
            regionName: "서울",
            identityType: "temporary",
        });
    });
});
