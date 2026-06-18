import { describe, expect, it } from "vitest";
import {
    buildTeacherSessionDisplay,
    clearTeacherSession,
    createTeacherSession,
    hasTeacherSession,
    formatTeacherSessionRemaining,
    LEGACY_TEACHER_TOKEN_KEY,
    normalizeTeacherRedirectPath,
    parseTeacherSession,
    readTeacherSession,
    saveTeacherSession,
    saveTeacherSessionSnapshot,
    saveTeacherSessionWithIdentity,
    TEACHER_SESSION_KEY,
    teacherSessionRemainingMs,
} from "./teacherSession";

function memoryStorage(initial: Record<string, string> = {}) {
    const data = { ...initial };
    return {
        getItem: (key: string) => data[key] ?? null,
        setItem: (key: string, value: string) => { data[key] = value; },
        removeItem: (key: string) => { delete data[key]; },
        data,
    };
}

const VALID_TOKEN = "tkn_abc123_0123456789abcdef0123456789abcdef";

describe("teacher session", () => {
    it("stores and reads an active teacher session", () => {
        const storage = memoryStorage();
        expect(saveTeacherSession(VALID_TOKEN, storage, 1000)).toBe(true);
        expect(readTeacherSession(storage, 1000)).toMatchObject({
            role: "teacher",
            token: VALID_TOKEN,
        });
        expect(hasTeacherSession(storage, 1000)).toBe(true);
    });

    it("stores and displays teacher identity when provided", () => {
        const storage = memoryStorage();
        expect(saveTeacherSessionWithIdentity(VALID_TOKEN, {
            teacherId: "teacher-a",
            email: "a@example.com",
            displayName: "A Teacher",
        }, storage, 1000)).toBe(true);

        const session = readTeacherSession(storage, 1000);
        expect(session).toMatchObject({
            role: "teacher",
            token: VALID_TOKEN,
            teacherId: "teacher-a",
            email: "a@example.com",
            displayName: "A Teacher",
        });
        expect(buildTeacherSessionDisplay(session, 1000)).toMatchObject({
            actorLabel: "A Teacher",
            detail: expect.stringContaining("A Teacher"),
        });
    });

    it("stores a server-provided session snapshot without extending its expiry", () => {
        const storage = memoryStorage();
        const session = createTeacherSession(VALID_TOKEN, 1000, {
            teacherId: "teacher-a",
            displayName: "A Teacher",
        });

        expect(saveTeacherSessionSnapshot(session, storage, 2000)).toBe(true);
        expect(JSON.parse(storage.data[TEACHER_SESSION_KEY])).toMatchObject({
            token: VALID_TOKEN,
            teacherId: "teacher-a",
            displayName: "A Teacher",
            issuedAt: 1000,
            expiresAt: session.expiresAt,
        });
    });

    it("rejects malformed and expired sessions", () => {
        expect(parseTeacherSession(JSON.stringify(createTeacherSession("bad-token", 1000)), 1000)).toBeNull();
        expect(saveTeacherSession("tkn_abc123_deadbeef", memoryStorage(), 1000)).toBe(false);

        const expired = createTeacherSession(VALID_TOKEN, 1000);
        expect(parseTeacherSession(JSON.stringify(expired), expired.expiresAt + 1)).toBeNull();
    });

    it("reads legacy teacher tokens for backwards compatibility", () => {
        const storage = memoryStorage({ omr_teacher_token: VALID_TOKEN });
        expect(readTeacherSession(storage, 5000)).toMatchObject({
            token: VALID_TOKEN,
            role: "teacher",
        });
        expect(JSON.parse(storage.data[TEACHER_SESSION_KEY])).toMatchObject({
            token: VALID_TOKEN,
            role: "teacher",
        });
    });

    it("does not resurrect an expired current session from the legacy token", () => {
        const expired = createTeacherSession(VALID_TOKEN, 1000);
        const storage = memoryStorage({
            [TEACHER_SESSION_KEY]: JSON.stringify(expired),
            [LEGACY_TEACHER_TOKEN_KEY]: VALID_TOKEN,
        });

        expect(readTeacherSession(storage, expired.expiresAt + 1)).toBeNull();
        expect(storage.data).toEqual({});
    });

    it("clears malformed current sessions instead of falling back to stale legacy tokens", () => {
        const storage = memoryStorage({
            [TEACHER_SESSION_KEY]: "{broken",
            [LEGACY_TEACHER_TOKEN_KEY]: VALID_TOKEN,
        });

        expect(readTeacherSession(storage, 1000)).toBeNull();
        expect(storage.data).toEqual({});
    });

    it("clears both current and legacy keys", () => {
        const storage = memoryStorage({
            [TEACHER_SESSION_KEY]: JSON.stringify(createTeacherSession(VALID_TOKEN, 1000)),
            omr_teacher_token: VALID_TOKEN,
        });

        clearTeacherSession(storage);
        expect(storage.data).toEqual({});
    });

    it("reports remaining session time for settings surfaces", () => {
        const session = createTeacherSession(VALID_TOKEN, 1000);

        expect(teacherSessionRemainingMs(session, 1000)).toBe(12 * 60 * 60 * 1000);
        expect(formatTeacherSessionRemaining(12 * 60 * 60 * 1000)).toBe("12시간 남음");
        expect(formatTeacherSessionRemaining(61 * 60 * 1000)).toBe("1시간 1분 남음");
        expect(formatTeacherSessionRemaining(30 * 1000)).toBe("1분 남음");
        expect(teacherSessionRemainingMs(session, session.expiresAt + 1)).toBe(0);
        expect(formatTeacherSessionRemaining(0)).toBe("만료됨");
    });

    it("summarizes active, expiring, and expired teacher session display states", () => {
        const session = createTeacherSession(VALID_TOKEN, 1000);

        expect(buildTeacherSessionDisplay(session, 1000)).toMatchObject({
            label: "12시간 남음",
            actorLabel: "교사",
            level: "active",
            isExpired: false,
        });
        expect(buildTeacherSessionDisplay(session, session.expiresAt - 10 * 60 * 1000)).toMatchObject({
            label: "10분 남음",
            level: "expiring",
            isExpired: false,
        });
        expect(buildTeacherSessionDisplay(session, session.expiresAt + 1)).toMatchObject({
            label: "만료됨",
            level: "expired",
            isExpired: true,
        });
    });

    it("normalizes teacher-only redirect paths", () => {
        expect(normalizeTeacherRedirectPath("/teacher/users?tab=groups")).toBe("/teacher/users?tab=groups");
        expect(normalizeTeacherRedirectPath("/create")).toBe("/create");
        expect(normalizeTeacherRedirectPath("/create?edit=exam-1")).toBe("/create?edit=exam-1");
        expect(normalizeTeacherRedirectPath("/createevil")).toBe("/teacher/dashboard");
        expect(normalizeTeacherRedirectPath("https://evil.example/teacher/dashboard")).toBe("/teacher/dashboard");
        expect(normalizeTeacherRedirectPath("/student/dashboard")).toBe("/teacher/dashboard");
        expect(normalizeTeacherRedirectPath("//evil.example")).toBe("/teacher/dashboard");
    });
});
