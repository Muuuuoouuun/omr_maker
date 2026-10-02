import { INITIAL_OPERATIONS_LIMITS } from "@/lib/initialOperationsPolicy";
import { describe, expect, it } from "vitest";
import {
    CANONICAL_SURFACE_CACHE_BYTE_LIMITS,
    CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS,
    LEGACY_CANONICAL_SURFACE_MARKER_KEYS,
    buildCanonicalSurfaceCacheKey,
    normalizeCanonicalSurfaceCacheText,
    purgeLegacyCanonicalSurfaceMarkers,
    readCanonicalSurfaceCache,
    removeCanonicalSurfaceCache,
    removeCanonicalSurfaceCachesForIdentity,
    writeCanonicalSurfaceCache,
    type CanonicalDashboardCacheData,
    type CanonicalRosterCacheData,
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

const now = new Date("2026-08-09T12:00:00.000Z");
const staleAt = "2026-08-09T11:59:00.000Z";
const dashboardIdentity: CanonicalSurfaceCacheIdentity = {
    surface: "teacher_dashboard",
    organizationId: "org:alpha/one",
    accountId: "teacher@example.com",
    sessionGeneration: 7,
};
const rosterIdentity: CanonicalSurfaceCacheIdentity = { ...dashboardIdentity, surface: "teacher_roster" };

function jsonEscapedAtLimit(length: number, suffix = ""): string {
    const suffixBytes = new TextEncoder().encode(JSON.stringify(suffix)).byteLength - 2;
    let remaining = length - suffixBytes;
    let value = "";
    while (remaining >= 2) {
        value += value.length % 2 === 0 ? "\"" : "\\";
        remaining -= 2;
    }
    if (remaining === 1) value += "x";
    return value + suffix;
}

function dashboardData(): CanonicalDashboardCacheData {
    return {
        exams: [{
            id: "exam-1",
            title: "중간고사",
            status: "active",
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-02T00:00:00.000Z",
            questionCount: 20,
            attemptCount: 1,
        }],
        attempts: [{
            id: "attempt-1",
            examId: "exam-1",
            studentId: "student-1",
            studentName: "김학생",
            status: "completed",
            score: 80,
            totalScore: 100,
            startedAt: "2026-08-03T00:00:00.000Z",
            finishedAt: "2026-08-03T01:00:00.000Z",
            isRetake: false,
        }],
    };
}

function rosterData(): CanonicalRosterCacheData {
    return {
        students: [{
            id: "student-1",
            name: "김학생",
            email: "student@example.com",
            groupId: "group-1",
            status: "active",
            avgScore: 80,
            examsTaken: 3,
            lastActive: "오늘",
        }],
        groups: [{ id: "group-1", name: "A반", status: "active", studentCount: 1, avgScore: 80 }],
        invites: [{ id: "invite-1", email: "invited@example.com", status: "pending", sentAt: "방금 전" }],
    };
}

describe("canonical surface cache", () => {
    it("writes the exact envelope and a domain-separated identity key", () => {
        const storage = memoryStorage();
        expect(writeCanonicalSurfaceCache(storage, dashboardIdentity, staleAt, dashboardData(), now)).toEqual({ status: "written" });
        const key = buildCanonicalSurfaceCacheKey(dashboardIdentity);
        expect(key).toContain("canonical-surface-cache:v1:teacher_dashboard:");
        expect(key).not.toBe(buildCanonicalSurfaceCacheKey({ ...dashboardIdentity, surface: "teacher_roster" }));
        expect(key).not.toBe(buildCanonicalSurfaceCacheKey({ ...dashboardIdentity, sessionGeneration: 8 }));
        expect(Object.keys(JSON.parse(storage.data[key]))).toEqual([
            "schemaVersion", "surface", "organizationId", "accountId", "sessionGeneration", "staleAt", "data",
        ]);
    });

    it("round trips only an exact surface, organization, account, and generation", () => {
        const storage = memoryStorage();
        const data = dashboardData();
        expect(writeCanonicalSurfaceCache(storage, dashboardIdentity, staleAt, data, now)).toEqual({ status: "written" });
        expect(readCanonicalSurfaceCache(storage, dashboardIdentity, now)).toEqual({
            status: "hit",
            envelope: { schemaVersion: 1, ...dashboardIdentity, staleAt, data },
        });
        for (const mismatch of [
            { surface: "teacher_roster" as const },
            { organizationId: "org-beta" },
            { accountId: "other-account" },
            { sessionGeneration: 8 },
        ]) {
            expect(readCanonicalSurfaceCache(storage, { ...dashboardIdentity, ...mismatch }, now)).toEqual({ status: "miss" });
        }
    });

    it("requires an exact dashboard root and exact flat summary rows", () => {
        const valid = dashboardData();
        for (const data of [
            [],
            { exams: valid.exams },
            { attempts: valid.attempts },
            { ...valid, source: "local" },
            { ...valid, exams: [{ ...valid.exams[0], unknown: "field" }] },
            { ...valid, attempts: [{ ...valid.attempts[0], nested: { safe: true } }] },
            { ...valid, exams: [{ id: valid.exams[0].id, title: valid.exams[0].title }] },
        ]) {
            expect(writeCanonicalSurfaceCache(memoryStorage(), dashboardIdentity, staleAt, data, now)).toEqual({ status: "rejected" });
        }
    });

    it("requires an exact roster root and exact flat summary rows", () => {
        const valid = rosterData();
        for (const data of [
            [],
            { students: valid.students, groups: valid.groups },
            { ...valid, revision: 1 },
            { ...valid, students: [{ ...valid.students[0], avatar: "data:image/png;base64,secret" }] },
            { ...valid, groups: [{ ...valid.groups[0], metadata: {} }] },
            { ...valid, invites: [{ id: "partial" }] },
        ]) {
            expect(writeCanonicalSurfaceCache(memoryStorage(), rosterIdentity, staleAt, data, now)).toEqual({ status: "rejected" });
        }
    });

    it("runs the same exact projection codec on reads", () => {
        const storage = memoryStorage();
        const key = buildCanonicalSurfaceCacheKey(dashboardIdentity);
        const envelope = { schemaVersion: 1, ...dashboardIdentity, staleAt, data: dashboardData() };
        for (const data of [
            [],
            { exams: envelope.data.exams },
            { ...envelope.data, attempts: [{ ...envelope.data.attempts[0], secret: "private" }] },
        ]) {
            storage.setItem(key, JSON.stringify({ ...envelope, data }));
            expect(readCanonicalSurfaceCache(storage, dashboardIdentity, now)).toEqual({ status: "miss" });
        }
    });

    it("rejects extra envelope fields, invalid identities, and invalid timestamps", () => {
        const storage = memoryStorage();
        const key = buildCanonicalSurfaceCacheKey(dashboardIdentity);
        const valid = { schemaVersion: 1, ...dashboardIdentity, staleAt, data: dashboardData() };
        for (const malformed of [
            { ...valid, source: "local" },
            Object.fromEntries(Object.entries(valid).filter(([name]) => name !== "data")),
            { ...valid, organizationId: "org-beta" },
            { ...valid, staleAt: "2026-08-09 11:59:00Z" },
            { ...valid, staleAt: "2026-08-09T12:00:00.001Z" },
        ]) {
            storage.setItem(key, JSON.stringify(malformed));
            expect(readCanonicalSurfaceCache(storage, dashboardIdentity, now)).toEqual({ status: "miss" });
        }
        expect(writeCanonicalSurfaceCache(storage, { ...dashboardIdentity, accountId: " " }, staleAt, dashboardData(), now)).toEqual({ status: "rejected" });
        expect(writeCanonicalSurfaceCache(storage, { ...dashboardIdentity, sessionGeneration: 0 }, staleAt, dashboardData(), now)).toEqual({ status: "rejected" });
        expect(writeCanonicalSurfaceCache(storage, dashboardIdentity, "2026-08-09T12:00:00.001Z", dashboardData(), now)).toEqual({ status: "rejected" });
    });

    it("rejects accessors, proxies, cycles, sparse arrays, non-finite numbers, and mutation", () => {
        let getterCalls = 0;
        const accessor = Object.defineProperty({}, "exams", {
            enumerable: true,
            get() { getterCalls += 1; return []; },
        });
        const cyclic: { self?: unknown } = {};
        cyclic.self = cyclic;
        const sparse = Array(2);
        sparse[1] = dashboardData().attempts[0];
        const target = dashboardData();
        let descriptorReads = 0;
        const mutating = new Proxy(target, {
            getOwnPropertyDescriptor(current, property) {
                descriptorReads += 1;
                if (descriptorReads === 1) current.exams = [];
                return Reflect.getOwnPropertyDescriptor(current, property);
            },
        });
        for (const data of [
            accessor,
            new Proxy(dashboardData(), {}),
            cyclic,
            { exams: dashboardData().exams, attempts: sparse },
            { ...dashboardData(), attempts: [{ ...dashboardData().attempts[0], score: Number.NaN }] },
            mutating,
        ]) {
            expect(writeCanonicalSurfaceCache(memoryStorage(), dashboardIdentity, staleAt, data, now)).toEqual({ status: "rejected" });
        }
        expect(getterCalls).toBe(0);
    });

    it("rejects huge sparse array lengths on write and read without allocating or throwing", () => {
        const huge = Array(2 ** 32 - 1);
        const storage = memoryStorage();
        expect(() => writeCanonicalSurfaceCache(storage, dashboardIdentity, staleAt, {
            exams: huge,
            attempts: [],
        }, now)).not.toThrow();
        expect(writeCanonicalSurfaceCache(storage, dashboardIdentity, staleAt, { exams: huge, attempts: [] }, now))
            .toEqual({ status: "rejected" });

        const key = buildCanonicalSurfaceCacheKey(dashboardIdentity);
        storage.setItem(key, JSON.stringify({
            schemaVersion: 1,
            ...dashboardIdentity,
            staleAt,
            data: { exams: [], attempts: [] },
        }));
        const originalParse = JSON.parse;
        const parseSpy = (raw: string) => {
            const parsed = originalParse(raw);
            parsed.data.exams = huge;
            return parsed;
        };
        const originalJsonParse = JSON.parse;
        JSON.parse = parseSpy;
        try {
            expect(() => readCanonicalSurfaceCache(storage, dashboardIdentity, now)).not.toThrow();
            expect(readCanonicalSurfaceCache(storage, dashboardIdentity, now)).toEqual({ status: "miss" });
        } finally {
            JSON.parse = originalJsonParse;
        }
    });

    it("measures bounded fields by JSON-escaped UTF-8 bytes", () => {
        const dashboard = dashboardData();
        const rawUtf8FitsButEscapedDoesNot = "\"".repeat(CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.title / 2 + 1);
        expect(new TextEncoder().encode(rawUtf8FitsButEscapedDoesNot).byteLength)
            .toBeLessThanOrEqual(CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.title);
        expect(writeCanonicalSurfaceCache(memoryStorage(), dashboardIdentity, staleAt, {
            ...dashboard,
            exams: [{ ...dashboard.exams[0], title: rawUtf8FitsButEscapedDoesNot }],
        }, now)).toEqual({ status: "rejected" });
    });

    it("normalizes long upstream text at a JSON boundary with a visible ellipsis and intact Unicode", () => {
        const sourceGrapheme = "🧑🏽‍🎓";
        const title = normalizeCanonicalSurfaceCacheText("가".repeat(1_000), CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.title);
        const emojiTitle = normalizeCanonicalSurfaceCacheText(sourceGrapheme.repeat(1_000), CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.title);
        const name = normalizeCanonicalSurfaceCacheText(sourceGrapheme.repeat(1_000), CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.name);
        const escaped = normalizeCanonicalSurfaceCacheText("\"\\".repeat(1_000), CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.title);
        for (const normalized of [title, emojiTitle, name, escaped]) {
            expect(normalized.truncated).toBe(true);
            expect(normalized.value.endsWith("…")).toBe(true);
            expect(normalized.value).not.toContain("\uFFFD");
        }
        for (const normalized of [emojiTitle, name]) {
            const beforeEllipsis = normalized.value.slice(0, -1);
            expect(beforeEllipsis.length % sourceGrapheme.length).toBe(0);
            expect(beforeEllipsis).toBe(sourceGrapheme.repeat(beforeEllipsis.length / sourceGrapheme.length));
        }
        expect(new TextEncoder().encode(JSON.stringify(title.value)).byteLength - 2)
            .toBeLessThanOrEqual(CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.title);
        expect(new TextEncoder().encode(JSON.stringify(name.value)).byteLength - 2)
            .toBeLessThanOrEqual(CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.name);

        const dashboard = dashboardData();
        expect(writeCanonicalSurfaceCache(memoryStorage(), dashboardIdentity, staleAt, {
            ...dashboard,
            exams: [{ ...dashboard.exams[0], title: title.value }],
            attempts: [{ ...dashboard.attempts[0], studentName: name.value }],
        }, now)).toEqual({ status: "written" });
        expect(writeCanonicalSurfaceCache(memoryStorage(), dashboardIdentity, staleAt, {
            ...dashboard,
            exams: [{ ...dashboard.exams[0], title: "가".repeat(1_000) }],
        }, now)).toEqual({ status: "rejected" });
    });

    it("uses a stable non-splitting fallback when grapheme segmentation is unavailable", () => {
        const descriptor = Object.getOwnPropertyDescriptor(Intl, "Segmenter");
        Object.defineProperty(Intl, "Segmenter", { configurable: true, value: undefined });
        try {
            expect(normalizeCanonicalSurfaceCacheText(
                "🧑🏽‍🎓".repeat(1_000),
                CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.name,
            )).toEqual({ value: "…", truncated: true });
        } finally {
            if (descriptor) Object.defineProperty(Intl, "Segmenter", descriptor);
        }
    });

    it("normalizes control runs to a visible space and produces cache-valid text", () => {
        const normalized = normalizeCanonicalSurfaceCacheText(
            "\nExam\n\u007f\u0085Title\r",
            CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.title,
        );
        expect(normalized).toEqual({ value: "Exam Title", truncated: false });
        const dashboard = dashboardData();
        expect(writeCanonicalSurfaceCache(memoryStorage(), dashboardIdentity, staleAt, {
            ...dashboard,
            exams: [{ ...dashboard.exams[0], title: normalized.value }],
        }, now)).toEqual({ status: "written" });
    });

    it("uses a visible truncated fallback for nonempty control-only text but preserves truly empty input", () => {
        for (const input of ["\u0000", "\u0000\u001f\u007f\u0085"]) {
            const normalized = normalizeCanonicalSurfaceCacheText(
                input,
                CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.title,
            );
            expect(normalized).toEqual({ value: "…", truncated: true });
            const dashboard = dashboardData();
            expect(writeCanonicalSurfaceCache(memoryStorage(), dashboardIdentity, staleAt, {
                ...dashboard,
                exams: [{ ...dashboard.exams[0], title: normalized.value }],
            }, now)).toEqual({ status: "written" });
        }
        expect(normalizeCanonicalSurfaceCacheText(
            "",
            CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.title,
        )).toEqual({ value: "", truncated: false });
    });

    it("accepts any ordered finite nonnegative score magnitude", () => {
        const dashboard = dashboardData();
        expect(writeCanonicalSurfaceCache(memoryStorage(), dashboardIdentity, staleAt, {
            ...dashboard,
            attempts: [{ ...dashboard.attempts[0], score: Number.MAX_VALUE, totalScore: Number.MAX_VALUE }],
        }, now)).toEqual({ status: "written" });
    });

    it("accepts the shared attempt-count roster boundary", () => {
        const roster = rosterData();
        expect(writeCanonicalSurfaceCache(memoryStorage(), rosterIdentity, staleAt, {
            ...roster,
            students: [{ ...roster.students[0], examsTaken: INITIAL_OPERATIONS_LIMITS.teacherAttempts }],
        }, now)).toEqual({ status: "written" });
    });

    it("rejects every secret-bearing probe even when the key was not in the old denylist", () => {
        const base = dashboardData();
        for (const key of [
            "questions", "answers", "answerBody", "questionBody", "handwritingPayload", "drawings",
            "rawUrl", "url", "secret", "pin", "token", "credential", "bearer", "feedbackBody",
        ]) {
            const data = { ...base, attempts: [{ ...base.attempts[0], [key]: "private" }] };
            expect(writeCanonicalSurfaceCache(memoryStorage(), dashboardIdentity, staleAt, data, now)).toEqual({ status: "rejected" });
        }
    });

    it("accepts localized roster display labels and a null missing stable student identity", () => {
        const dashboard = dashboardData();
        const roster = rosterData();
        expect(writeCanonicalSurfaceCache(memoryStorage(), dashboardIdentity, staleAt, {
            ...dashboard,
            attempts: [{ ...dashboard.attempts[0], studentId: null }],
        }, now)).toEqual({ status: "written" });
        expect(writeCanonicalSurfaceCache(memoryStorage(), rosterIdentity, staleAt, {
            ...roster,
            students: [{ ...roster.students[0], lastActive: "기록 없음" }],
            invites: [{ ...roster.invites[0], sentAt: "방금 전" }],
        }, now)).toEqual({ status: "written" });
    });

    it("rejects blank, padded, or control-bearing semantic strings and impossible scores", () => {
        const dashboard = dashboardData();
        const roster = rosterData();
        for (const data of [
            { ...dashboard, exams: [{ ...dashboard.exams[0], id: " " }] },
            { ...dashboard, exams: [{ ...dashboard.exams[0], title: " padded" }] },
            { ...dashboard, attempts: [{ ...dashboard.attempts[0], studentName: "student\nname" }] },
            { ...dashboard, attempts: [{ ...dashboard.attempts[0], score: 101, totalScore: 100 }] },
        ]) {
            expect(writeCanonicalSurfaceCache(memoryStorage(), dashboardIdentity, staleAt, data, now)).toEqual({ status: "rejected" });
        }
        for (const data of [
            { ...roster, students: [{ ...roster.students[0], name: "학생\u0000이름" }] },
            { ...roster, students: [{ ...roster.students[0], email: " student@example.com" }] },
            { ...roster, students: [{ ...roster.students[0], lastActive: "오늘\n" }] },
            { ...roster, invites: [{ ...roster.invites[0], sentAt: " 방금 전" }] },
        ]) {
            expect(writeCanonicalSurfaceCache(memoryStorage(), rosterIdentity, staleAt, data, now)).toEqual({ status: "rejected" });
        }
        expect(writeCanonicalSurfaceCache(memoryStorage(), rosterIdentity, staleAt, {
            ...roster,
            students: [{ ...roster.students[0], email: "" }],
        }, now)).toEqual({ status: "written" });
    });

    it("rejects throwing and transparent identity objects without throwing", () => {
        let accessorCalls = 0;
        const accessorIdentity = Object.defineProperty({
            surface: "teacher_dashboard",
            organizationId: "org-a",
            sessionGeneration: 1,
        }, "accountId", {
            enumerable: true,
            get() { accessorCalls += 1; throw new Error("identity-secret"); },
        }) as CanonicalSurfaceCacheIdentity;
        const proxyIdentity = new Proxy(dashboardIdentity, {}) as CanonicalSurfaceCacheIdentity;
        for (const identity of [accessorIdentity, proxyIdentity]) {
            expect(() => writeCanonicalSurfaceCache(memoryStorage(), identity, staleAt, dashboardData(), now)).not.toThrow();
            expect(writeCanonicalSurfaceCache(memoryStorage(), identity, staleAt, dashboardData(), now)).toEqual({ status: "rejected" });
            expect(() => readCanonicalSurfaceCache(memoryStorage(), identity, now)).not.toThrow();
            expect(readCanonicalSurfaceCache(memoryStorage(), identity, now)).toEqual({ status: "miss" });
            expect(() => removeCanonicalSurfaceCache(memoryStorage(), identity)).not.toThrow();
        }
        expect(accessorCalls).toBe(0);
    });

    it("round trips true maximum dashboard counts and maximum-byte fields under 2 MiB", () => {
        const data: CanonicalDashboardCacheData = {
            exams: Array.from({ length: INITIAL_OPERATIONS_LIMITS.teacherExams }, (_, index) => ({
                id: jsonEscapedAtLimit(CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.id, `-${index}`),
                title: jsonEscapedAtLimit(CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.title),
                status: "archived",
                createdAt: staleAt,
                updatedAt: staleAt,
                questionCount: 1_000,
                attemptCount: INITIAL_OPERATIONS_LIMITS.teacherAttempts,
            })),
            attempts: Array.from({ length: INITIAL_OPERATIONS_LIMITS.teacherAttempts }, (_, index) => ({
                id: jsonEscapedAtLimit(CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.id, `-${index}`),
                examId: jsonEscapedAtLimit(CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.id, `-${index % INITIAL_OPERATIONS_LIMITS.teacherExams}`),
                studentId: jsonEscapedAtLimit(CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.id, `-${index}`),
                studentName: jsonEscapedAtLimit(CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.name),
                status: "in_progress",
                score: 1_000_000,
                totalScore: 1_000_000,
                startedAt: staleAt,
                finishedAt: staleAt,
                isRetake: index % 2 === 0,
            })),
        };
        const storage = memoryStorage();
        expect(writeCanonicalSurfaceCache(storage, dashboardIdentity, staleAt, data, now)).toEqual({ status: "written" });
        expect(new TextEncoder().encode(Object.values(storage.data)[0]).byteLength)
            .toBeLessThanOrEqual(CANONICAL_SURFACE_CACHE_BYTE_LIMITS.teacher_dashboard);
        expect(readCanonicalSurfaceCache(storage, dashboardIdentity, now)).toMatchObject({ status: "hit", envelope: { data } });
    });

    it("round trips true maximum roster counts and maximum-byte fields under 1 MiB", () => {
        const data: CanonicalRosterCacheData = {
            students: Array.from({ length: INITIAL_OPERATIONS_LIMITS.activeStudents }, (_, index) => ({
                id: jsonEscapedAtLimit(CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.id, `-${index}`),
                name: jsonEscapedAtLimit(CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.name),
                email: jsonEscapedAtLimit(CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.email, "@example.com"),
                groupId: jsonEscapedAtLimit(CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.id, `-${index}`),
                status: "invited",
                avgScore: 100,
                examsTaken: INITIAL_OPERATIONS_LIMITS.teacherAttempts,
                lastActive: jsonEscapedAtLimit(CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.lastActiveLabel),
            })),
            groups: Array.from({ length: INITIAL_OPERATIONS_LIMITS.classes }, (_, index) => ({
                id: jsonEscapedAtLimit(CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.id, `-${index}`),
                name: jsonEscapedAtLimit(CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.name),
                status: "archived",
                studentCount: INITIAL_OPERATIONS_LIMITS.activeStudents,
                avgScore: 100,
            })),
            invites: Array.from({ length: INITIAL_OPERATIONS_LIMITS.invites }, (_, index) => ({
                id: jsonEscapedAtLimit(CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.id, `-${index}`),
                email: jsonEscapedAtLimit(CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.email, "@example.com"),
                status: "accepted",
                sentAt: jsonEscapedAtLimit(CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.inviteSentAtLabel),
            })),
        };
        const storage = memoryStorage();
        expect(writeCanonicalSurfaceCache(storage, rosterIdentity, staleAt, data, now)).toEqual({ status: "written" });
        expect(new TextEncoder().encode(Object.values(storage.data)[0]).byteLength)
            .toBeLessThanOrEqual(CANONICAL_SURFACE_CACHE_BYTE_LIMITS.teacher_roster);
        expect(readCanonicalSurfaceCache(storage, rosterIdentity, now)).toMatchObject({ status: "hit", envelope: { data } });
    });

    it("rejects every surface count overflow and oversized UTF-8 field", () => {
        const dashboard = dashboardData();
        const roster = rosterData();
        expect(writeCanonicalSurfaceCache(memoryStorage(), dashboardIdentity, staleAt, {
            ...dashboard,
            exams: Array.from({ length: INITIAL_OPERATIONS_LIMITS.teacherExams + 1 }, () => dashboard.exams[0]),
        }, now)).toEqual({ status: "rejected" });
        expect(writeCanonicalSurfaceCache(memoryStorage(), dashboardIdentity, staleAt, {
            ...dashboard,
            attempts: Array.from({ length: INITIAL_OPERATIONS_LIMITS.teacherAttempts + 1 }, () => dashboard.attempts[0]),
        }, now)).toEqual({ status: "rejected" });
        for (const [field, count] of [["students", INITIAL_OPERATIONS_LIMITS.activeStudents], ["groups", INITIAL_OPERATIONS_LIMITS.classes], ["invites", INITIAL_OPERATIONS_LIMITS.invites]] as const) {
            expect(writeCanonicalSurfaceCache(memoryStorage(), rosterIdentity, staleAt, {
                ...roster,
                [field]: Array.from({ length: count + 1 }, () => roster[field][0]),
            }, now)).toEqual({ status: "rejected" });
        }
        expect(writeCanonicalSurfaceCache(memoryStorage(), dashboardIdentity, staleAt, {
            ...dashboard,
            exams: [{ ...dashboard.exams[0], title: "가".repeat(CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.title) }],
        }, now)).toEqual({ status: "rejected" });
    });

    it("removes exact scoped surfaces and purges only legacy evidence markers idempotently", () => {
        const storage = memoryStorage({ unrelated: "keep" });
        expect(writeCanonicalSurfaceCache(storage, dashboardIdentity, staleAt, dashboardData(), now)).toEqual({ status: "written" });
        expect(writeCanonicalSurfaceCache(storage, rosterIdentity, staleAt, rosterData(), now)).toEqual({ status: "written" });
        removeCanonicalSurfaceCache(storage, dashboardIdentity);
        removeCanonicalSurfaceCache(storage, dashboardIdentity);
        expect(readCanonicalSurfaceCache(storage, dashboardIdentity, now)).toEqual({ status: "miss" });
        expect(readCanonicalSurfaceCache(storage, rosterIdentity, now).status).toBe("hit");
        removeCanonicalSurfaceCachesForIdentity(storage, dashboardIdentity);
        removeCanonicalSurfaceCachesForIdentity(storage, dashboardIdentity);
        for (const marker of LEGACY_CANONICAL_SURFACE_MARKER_KEYS) storage.setItem(marker, staleAt);
        purgeLegacyCanonicalSurfaceMarkers(storage);
        expect(storage.data).toEqual({ unrelated: "keep" });
    });

    it("turns storage exceptions into stable failures or misses", () => {
        const throwing = {
            getItem: () => { throw new Error("provider details"); },
            setItem: () => { throw new Error("provider details"); },
            removeItem: () => { throw new Error("provider details"); },
        };
        expect(writeCanonicalSurfaceCache(throwing, dashboardIdentity, staleAt, dashboardData(), now)).toEqual({ status: "storage_failure" });
        expect(readCanonicalSurfaceCache(throwing, dashboardIdentity, now)).toEqual({ status: "miss" });
        expect(() => removeCanonicalSurfaceCache(throwing, dashboardIdentity)).not.toThrow();
        expect(() => purgeLegacyCanonicalSurfaceMarkers(throwing)).not.toThrow();
    });
});
