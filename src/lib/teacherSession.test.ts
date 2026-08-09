import { describe, expect, it, vi } from "vitest";
import { MOCKUP_TEACHER_IDENTITY } from "./mockupAccount";
import {
    buildTeacherSessionDisplay,
    canTeacherRoleWrite,
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
    TEACHER_SESSION_IDENTITY_CHANGED_EVENT,
    teacherSessionRemainingMs,
} from "./teacherSession";
import {
    LEGACY_CANONICAL_SURFACE_MARKER_KEYS,
    buildCanonicalSurfaceCacheKey,
    type CanonicalSurfaceCacheIdentity,
} from "./canonicalSurfaceCache";

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
const STALE_AT = "2026-08-09T11:59:00.000Z";

describe("teacher session", () => {
    it("synchronously emits same-document identity changes only after replacement and clear take effect", () => {
        const storage = memoryStorage();
        const browser = new EventTarget() as EventTarget & { localStorage?: unknown };
        const observedSessions: Array<string | null> = [];
        browser.addEventListener(TEACHER_SESSION_IDENTITY_CHANGED_EVENT, () => {
            observedSessions.push(storage.getItem(TEACHER_SESSION_KEY));
        });
        vi.stubGlobal("window", browser);

        try {
            const first = createTeacherSession(VALID_TOKEN, 1_000, {
                teacherId: "teacher_0123456789abcdef",
                organizationId: "pilot_org_0123456789abcdef01234567",
                accountSessionGeneration: 1,
                sessionAuthority: "account",
                organizationName: "First org",
                memberRole: "owner",
                plan: "pro",
            });
            const second = createTeacherSession(VALID_TOKEN, 2_000, {
                teacherId: "teacher_fedcba9876543210",
                organizationId: "pilot_org_fedcba9876543210fedcba98",
                accountSessionGeneration: 2,
                sessionAuthority: "account",
                organizationName: "Second org",
                memberRole: "owner",
                plan: "pro",
            });

            expect(saveTeacherSessionSnapshot(first, storage, 2_500, null)).toBe(true);
            expect(parseTeacherSession(observedSessions.at(-1), 2_500)).toMatchObject({
                teacherId: first.teacherId,
                organizationId: first.organizationId,
                accountSessionGeneration: 1,
            });

            expect(saveTeacherSessionSnapshot(second, storage, 2_500, null)).toBe(true);
            expect(parseTeacherSession(observedSessions.at(-1), 2_500)).toMatchObject({
                teacherId: second.teacherId,
                organizationId: second.organizationId,
                accountSessionGeneration: 2,
            });

            clearTeacherSession(storage, null);
            expect(observedSessions.at(-1)).toBeNull();
            expect(observedSessions).toHaveLength(3);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("allows only explicit write-capable organization roles to mutate canonical data", () => {
        expect(canTeacherRoleWrite("owner")).toBe(true);
        expect(canTeacherRoleWrite("admin")).toBe(true);
        expect(canTeacherRoleWrite("teacher")).toBe(true);
        expect(canTeacherRoleWrite("assistant")).toBe(true);
        expect(canTeacherRoleWrite("viewer")).toBe(false);
        expect(canTeacherRoleWrite(undefined)).toBe(false);
    });

    it("stores and reads an active teacher session", () => {
        const storage = memoryStorage();
        expect(saveTeacherSession(VALID_TOKEN, storage, 1000)).toBe(true);
        expect(readTeacherSession(storage, 1000)).toMatchObject({
            role: "teacher",
            token: VALID_TOKEN,
        });
        expect(hasTeacherSession(storage, 1000)).toBe(true);
    });

    it("purges legacy global evidence markers when reading an existing valid session", () => {
        const sessionStorage = memoryStorage();
        const localStorage = memoryStorage({ unrelated: "keep" });
        expect(saveTeacherSession(VALID_TOKEN, sessionStorage, 1000, null)).toBe(true);
        for (const marker of LEGACY_CANONICAL_SURFACE_MARKER_KEYS) localStorage.setItem(marker, STALE_AT);

        expect(readTeacherSession(sessionStorage, 1000, localStorage)).toMatchObject({ token: VALID_TOKEN });

        expect(localStorage.data).toEqual({ unrelated: "keep" });
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

    it("preserves shared workspace, member role, and plan ceiling metadata", () => {
        const storage = memoryStorage();
        const identity = {
            teacherId: "teacher2",
            organizationId: "teacher_sharedqa",
            organizationName: "OMR Maker 테스트",
            memberRole: "teacher" as const,
            plan: "pro" as const,
        };

        expect(saveTeacherSessionWithIdentity(VALID_TOKEN, identity, storage, 1000)).toBe(true);
        expect(readTeacherSession(storage, 1000)).toMatchObject(identity);
        expect(parseTeacherSession(storage.data[TEACHER_SESSION_KEY], 1000)).toMatchObject(identity);
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

    it("accepts only the structurally exact showcase snapshot in browser storage", () => {
        const exact = createTeacherSession(VALID_TOKEN, 1_000, {
            ...MOCKUP_TEACHER_IDENTITY,
            sessionAuthority: "mockup",
        });
        expect(parseTeacherSession(JSON.stringify(exact), 1_000)).toMatchObject({
            ...MOCKUP_TEACHER_IDENTITY,
            sessionAuthority: "mockup",
        });
        for (const escalation of [
            { memberRole: "owner" },
            { organizationId: "pilot_org_0123456789abcdef01234567" },
            { accountSessionGeneration: 1 },
            { plan: "free" },
            { email: "attacker@example.com" },
        ]) {
            expect(parseTeacherSession(JSON.stringify({ ...exact, ...escalation }), 1_000)).toBeNull();
        }
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

    it("purges the previous exact cache identity and legacy markers on logout without clearing unrelated storage", () => {
        const sessionStorage = memoryStorage();
        const localStorage = memoryStorage({ unrelated: "keep" });
        const identity = {
            teacherId: "teacher_0123456789abcdef",
            organizationId: "pilot_org_0123456789abcdef01234567",
            organizationName: "Alpha",
            memberRole: "owner" as const,
            plan: "pro" as const,
            sessionAuthority: "account" as const,
            accountSessionGeneration: 4,
        };
        expect(saveTeacherSessionWithIdentity(VALID_TOKEN, identity, sessionStorage, 1000, localStorage)).toBe(true);
        const cacheIdentity: CanonicalSurfaceCacheIdentity = {
            surface: "teacher_dashboard",
            organizationId: identity.organizationId,
            accountId: identity.teacherId,
            sessionGeneration: identity.accountSessionGeneration,
        };
        localStorage.setItem(buildCanonicalSurfaceCacheKey(cacheIdentity), "cached-dashboard");
        localStorage.setItem(buildCanonicalSurfaceCacheKey({ ...cacheIdentity, surface: "teacher_roster" }), "cached-roster");
        for (const marker of LEGACY_CANONICAL_SURFACE_MARKER_KEYS) localStorage.setItem(marker, STALE_AT);

        clearTeacherSession(sessionStorage, localStorage);

        expect(sessionStorage.data).toEqual({});
        expect(localStorage.data).toEqual({ unrelated: "keep" });
    });

    it("purges only the replaced identity caches while preserving the new and unrelated identities", () => {
        const sessionStorage = memoryStorage();
        const localStorage = memoryStorage({ unrelated: "keep" });
        const previous = {
            teacherId: "teacher_0123456789abcdef",
            organizationId: "pilot_org_0123456789abcdef01234567",
            organizationName: "Alpha",
            memberRole: "owner" as const,
            plan: "pro" as const,
            sessionAuthority: "account" as const,
            accountSessionGeneration: 4,
        };
        const next = {
            ...previous,
            teacherId: "teacher_fedcba9876543210",
            organizationId: "pilot_org_fedcba9876543210fedcba98",
            organizationName: "Beta",
            accountSessionGeneration: 5,
        };
        expect(saveTeacherSessionWithIdentity(VALID_TOKEN, previous, sessionStorage, 1000, localStorage)).toBe(true);
        const cacheIdentity = (identity: typeof previous, surface: CanonicalSurfaceCacheIdentity["surface"]): CanonicalSurfaceCacheIdentity => ({
            surface,
            organizationId: identity.organizationId,
            accountId: identity.teacherId,
            sessionGeneration: identity.accountSessionGeneration,
        });
        for (const surface of ["teacher_dashboard", "teacher_roster"] as const) {
            localStorage.setItem(buildCanonicalSurfaceCacheKey(cacheIdentity(previous, surface)), "old");
            localStorage.setItem(buildCanonicalSurfaceCacheKey(cacheIdentity(next, surface)), "new");
        }
        for (const marker of LEGACY_CANONICAL_SURFACE_MARKER_KEYS) localStorage.setItem(marker, STALE_AT);

        expect(saveTeacherSessionWithIdentity(VALID_TOKEN, next, sessionStorage, 2000, localStorage)).toBe(true);

        for (const surface of ["teacher_dashboard", "teacher_roster"] as const) {
            expect(localStorage.getItem(buildCanonicalSurfaceCacheKey(cacheIdentity(previous, surface)))).toBeNull();
            expect(localStorage.getItem(buildCanonicalSurfaceCacheKey(cacheIdentity(next, surface)))).toBe("new");
        }
        expect(localStorage.data.unrelated).toBe("keep");
        for (const marker of LEGACY_CANONICAL_SURFACE_MARKER_KEYS) expect(localStorage.getItem(marker)).toBeNull();
    });

    it("purges the previous identity before a partially failing replacement write", () => {
        const stored = memoryStorage();
        const localStorage = memoryStorage({ unrelated: "keep" });
        const previous = {
            teacherId: "teacher_0123456789abcdef",
            organizationId: "pilot_org_0123456789abcdef01234567",
            organizationName: "Alpha",
            memberRole: "owner" as const,
            plan: "pro" as const,
            sessionAuthority: "account" as const,
            accountSessionGeneration: 4,
        };
        const next = {
            ...previous,
            teacherId: "teacher_fedcba9876543210",
            organizationId: "pilot_org_fedcba9876543210fedcba98",
            accountSessionGeneration: 5,
        };
        expect(saveTeacherSessionWithIdentity(VALID_TOKEN, previous, stored, 1000, localStorage)).toBe(true);
        const oldIdentity = (surface: CanonicalSurfaceCacheIdentity["surface"]): CanonicalSurfaceCacheIdentity => ({
            surface,
            organizationId: previous.organizationId,
            accountId: previous.teacherId,
            sessionGeneration: previous.accountSessionGeneration,
        });
        for (const surface of ["teacher_dashboard", "teacher_roster"] as const) {
            localStorage.setItem(buildCanonicalSurfaceCacheKey(oldIdentity(surface)), "old");
        }
        for (const marker of LEGACY_CANONICAL_SURFACE_MARKER_KEYS) localStorage.setItem(marker, STALE_AT);
        let writes = 0;
        const partialFailureStorage = {
            getItem: stored.getItem,
            removeItem: stored.removeItem,
            setItem(key: string, value: string) {
                writes += 1;
                stored.setItem(key, value);
                if (writes === 2) throw new Error("legacy token write failed");
            },
        };

        expect(saveTeacherSessionWithIdentity(VALID_TOKEN, next, partialFailureStorage, 2000, localStorage)).toBe(false);

        for (const surface of ["teacher_dashboard", "teacher_roster"] as const) {
            expect(localStorage.getItem(buildCanonicalSurfaceCacheKey(oldIdentity(surface)))).toBeNull();
        }
        expect(localStorage.data).toEqual({ unrelated: "keep" });
    });

    it("resolves browser localStorage lazily and contains a throwing getter", () => {
        const sessionStorage = memoryStorage();
        const browser = Object.defineProperty({ sessionStorage }, "localStorage", {
            get() { throw new Error("blocked localStorage"); },
        });
        vi.stubGlobal("window", browser);
        try {
            expect(() => saveTeacherSession(VALID_TOKEN, sessionStorage, 1000)).not.toThrow();
            expect(() => readTeacherSession(sessionStorage, 1000)).not.toThrow();
            expect(() => clearTeacherSession(sessionStorage)).not.toThrow();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("attempts both session key removals and cache cleanup when either removal throws", () => {
        const identity = {
            teacherId: "teacher_0123456789abcdef",
            organizationId: "pilot_org_0123456789abcdef01234567",
            organizationName: "Alpha",
            memberRole: "owner" as const,
            plan: "pro" as const,
            sessionAuthority: "account" as const,
            accountSessionGeneration: 4,
        };
        for (const failingKey of [TEACHER_SESSION_KEY, LEGACY_TEACHER_TOKEN_KEY]) {
            const stored = memoryStorage();
            const localStorage = memoryStorage({ unrelated: "keep" });
            expect(saveTeacherSessionWithIdentity(VALID_TOKEN, identity, stored, 1000, localStorage)).toBe(true);
            const cacheIdentity = (surface: CanonicalSurfaceCacheIdentity["surface"]): CanonicalSurfaceCacheIdentity => ({
                surface,
                organizationId: identity.organizationId,
                accountId: identity.teacherId,
                sessionGeneration: identity.accountSessionGeneration,
            });
            for (const surface of ["teacher_dashboard", "teacher_roster"] as const) {
                localStorage.setItem(buildCanonicalSurfaceCacheKey(cacheIdentity(surface)), "old");
            }
            const attempted: string[] = [];
            const failingStorage = {
                getItem: stored.getItem,
                setItem: stored.setItem,
                removeItem(key: string) {
                    attempted.push(key);
                    if (key === failingKey) throw new Error("blocked removal");
                    stored.removeItem(key);
                },
            };

            expect(() => clearTeacherSession(failingStorage, localStorage)).not.toThrow();

            expect(attempted).toEqual([TEACHER_SESSION_KEY, LEGACY_TEACHER_TOKEN_KEY]);
            expect(stored.getItem(failingKey)).not.toBeNull();
            expect(stored.getItem(failingKey === TEACHER_SESSION_KEY ? LEGACY_TEACHER_TOKEN_KEY : TEACHER_SESSION_KEY)).toBeNull();
            expect(localStorage.data).toEqual({ unrelated: "keep" });
        }
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
