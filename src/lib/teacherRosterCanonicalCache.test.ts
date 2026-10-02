import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
    buildCanonicalSurfaceCacheKey,
    type CanonicalSurfaceCacheIdentity,
} from "./canonicalSurfaceCache";
import type { TeacherRosterRemoteCandidate } from "./teacherRosterClient";
import type { RosterSnapshot } from "./rosterPersistence";
import {
    beginTeacherRosterIdentityOperation,
    canContinueTeacherRosterBoundOperation,
    canContinueTeacherRosterIdentityOperation,
    persistTeacherRosterCompletionIfCurrent,
    readTeacherRosterDegradedCache,
    sameTeacherRosterLoadIdentity,
    toTeacherRosterCacheProjection,
    type TeacherRosterDegradedData,
    type TeacherRosterIdentityOperation,
    type TeacherRosterLoadIdentity,
    type TeacherRosterSessionIdentity,
} from "./teacherRosterCanonicalCache";

function memoryStorage(initial: Record<string, string> = {}) {
    const data = { ...initial };
    const writes: string[] = [];
    return {
        getItem: (key: string) => data[key] ?? null,
        setItem: vi.fn((key: string, value: string) => { writes.push(key); data[key] = value; }),
        removeItem: vi.fn((key: string) => { writes.push(key); delete data[key]; }),
        data,
        writes,
    };
}

const now = new Date("2026-08-09T12:00:00.000Z");
const staleAt = "2026-08-09T11:59:00.000Z";
const identity: TeacherRosterLoadIdentity = {
    organizationId: "pilot_org_0123456789abcdef01234567",
    accountId: "teacher_0123456789abcdef",
    sessionGeneration: 4,
    requestGeneration: 9,
};

function snapshot(studentCount = 1): RosterSnapshot {
    return {
        groups: [{ id: "group-1", name: "가".repeat(1_000), count: studentCount, avgScore: 81, color: "#private" }],
        students: Array.from({ length: studentCount }, (_, index) => ({
            id: `student-${index}`,
            name: `학생 ${index} ${"🧑🏽‍🎓".repeat(100)}`,
            email: `student-${index}@example.com`,
            group: "가".repeat(1_000),
            avatar: `data:image/png;base64,private-${index}`,
            avgScore: 80,
            examsTaken: 2_000,
            lastActive: "오늘",
            trend: "up" as const,
            status: "active" as const,
        })),
        invites: [{
            id: "invite-1",
            email: "invited@example.com",
            sentAt: "방금 전",
            status: "pending",
        }],
    };
}

function candidate(roster = snapshot(), organizationId = identity.organizationId): TeacherRosterRemoteCandidate {
    return {
        snapshot: roster,
        revision: 7,
        meta: {
            organizationId,
            loadedAt: staleAt,
            rawCount: roster.students.length + roster.groups.length + roster.invites.length,
            parsedCount: roster.students.length + roster.groups.length + roster.invites.length,
        },
    };
}

describe("teacher roster canonical cache", () => {
    it("drops a delayed profile DTO after request, capability, or exact tenant identity changes", async () => {
        const captured: TeacherRosterLoadIdentity = { ...identity, requestGeneration: 11 };
        const operation = beginTeacherRosterIdentityOperation(captured, 7);
        const publish = vi.fn();
        let current: TeacherRosterLoadIdentity | null = captured;
        let capabilityEpoch = 7;
        let capability: "fresh" | "degraded" = "fresh";
        const complete = async (release: Promise<void>) => {
            await release;
            if (capability !== "fresh") return;
            if (!current || !sameTeacherRosterLoadIdentity(captured, current)) return;
            if (!canContinueTeacherRosterIdentityOperation(operation, current, capabilityEpoch)) return;
            publish();
        };

        let releaseRequest!: () => void;
        const delayedRequest = new Promise<void>(resolve => { releaseRequest = resolve; });
        const requestCompletion = complete(delayedRequest);
        current = { ...captured, requestGeneration: 12 };
        releaseRequest();
        await requestCompletion;

        let releaseTenant!: () => void;
        const delayedTenant = new Promise<void>(resolve => { releaseTenant = resolve; });
        current = captured;
        const tenantCompletion = complete(delayedTenant);
        current = { ...captured, organizationId: "pilot_org_fedcba9876543210fedcba98" };
        releaseTenant();
        await tenantCompletion;

        let releaseCapability!: () => void;
        const delayedCapability = new Promise<void>(resolve => { releaseCapability = resolve; });
        current = captured;
        const capabilityCompletion = complete(delayedCapability);
        capability = "degraded";
        capabilityEpoch += 1;
        releaseCapability();
        await capabilityCompletion;

        expect(publish).not.toHaveBeenCalled();
    });

    it("permanently invalidates delayed share, revoke, metadata, assignment, and undo continuations", () => {
        const session: TeacherRosterSessionIdentity = identity;
        const operation = beginTeacherRosterIdentityOperation(session, 4);
        const callbacks = {
            rawBearer: vi.fn(),
            shareState: vi.fn(),
            revokeState: vi.fn(),
            metadataState: vi.fn(),
            assignmentState: vi.fn(),
            undoMerge: vi.fn(),
            persist: vi.fn(),
            toast: vi.fn(),
        };

        const publish = (capabilityEpoch: number, current: TeacherRosterSessionIdentity) => {
            if (!canContinueTeacherRosterIdentityOperation(operation, current, capabilityEpoch)) return;
            Object.values(callbacks).forEach(callback => callback());
        };

        publish(5, session);
        publish(4, { ...session, organizationId: "pilot_org_fedcba9876543210fedcba98" });
        publish(6, session);
        for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
        expect(canContinueTeacherRosterIdentityOperation(operation, session, 4)).toBe(true);
    });

    it("binds each undo action to its own pending token instead of the latest tenant action", () => {
        const session: TeacherRosterSessionIdentity = identity;
        const operationA = beginTeacherRosterIdentityOperation(session, 4);
        const operationB = beginTeacherRosterIdentityOperation(session, 4);
        const undoA = vi.fn();
        const undoB = vi.fn();
        const invoke = (boundToken: number, operation: TeacherRosterIdentityOperation, currentToken: number, run: () => void) => {
            if (canContinueTeacherRosterBoundOperation(operation, boundToken, currentToken, session, 4)) run();
        };

        invoke(1, operationA, 2, undoA);
        invoke(2, operationB, 2, undoB);

        expect(undoA).not.toHaveBeenCalled();
        expect(undoB).toHaveBeenCalledOnce();
    });
    it("projects only exact bounded redacted group, student, and invite metadata", () => {
        const rich = snapshot();
        rich.invites = [{
            ...rich.invites[0],
            inviteUrl: "https://secret.example/invite?bearer=raw-token",
            credential: "private-credential",
        } as never];
        const projection = toTeacherRosterCacheProjection(rich);

        expect(Object.keys(projection)).toEqual(["students", "groups", "invites"]);
        expect(Object.keys(projection.students[0])).toEqual([
            "id", "name", "email", "groupId", "status", "avgScore", "examsTaken", "lastActive",
        ]);
        expect(Object.keys(projection.groups[0])).toEqual([
            "id", "name", "status", "studentCount", "avgScore",
        ]);
        expect(Object.keys(projection.invites[0])).toEqual(["id", "email", "status", "sentAt"]);
        expect(projection.students[0].groupId).toBe("group-1");
        expect(projection.students[0].name.endsWith("…")).toBe(true);
        expect(projection.groups[0].name.endsWith("…")).toBe(true);
        const serialized = JSON.stringify(projection).toLowerCase();
        for (const forbidden of ["inviteurl", "bearer", "credential", "private-credential", "raw-token", "data:image", "avatar", "trend", "color"]) {
            expect(serialized).not.toContain(forbidden);
        }
        expect(rich.students[0].avatar).toContain("private");
    });

    it("round trips the exact maximum 100 students into a distinct degraded type", () => {
        const storage = memoryStorage();
        const result = persistTeacherRosterCompletionIfCurrent(
            storage, candidate(snapshot(100)), identity, { ...identity }, now,
        );

        expect(result).toEqual({ status: "persisted", localPersisted: true, cacheWritten: true });
        const degraded = readTeacherRosterDegradedCache(storage, identity, now);
        expect(degraded).toMatchObject({ kind: "teacher_roster_degraded", staleAt });
        expect(degraded?.students).toHaveLength(100);
        expect(degraded?.students[0]).toMatchObject({ kind: "degraded_roster_student", id: "student-0" });
        expect(degraded?.groups[0]).toMatchObject({ kind: "degraded_roster_group", id: "group-1" });
        expect(degraded?.invites[0]).toMatchObject({ kind: "degraded_roster_invite", id: "invite-1" });
        expectTypeOf(degraded).toEqualTypeOf<TeacherRosterDegradedData | null>();
        expect(degraded?.students[0]).not.toHaveProperty("avatar");
    });

    it("does not cache an over-limit 101-student projection", () => {
        const storage = memoryStorage();
        const result = persistTeacherRosterCompletionIfCurrent(
            storage, candidate(snapshot(101)), identity, { ...identity }, now,
        );
        expect(result).toEqual({ status: "persisted", localPersisted: true, cacheWritten: false });
        expect(readTeacherRosterDegradedCache(storage, identity, now)).toBeNull();
    });

    it("performs zero legacy or scoped writes when org A completes after org B is current", () => {
        const storage = memoryStorage({ unrelated: "keep" });
        const current = { ...identity, organizationId: "pilot_org_fedcba9876543210fedcba98" };

        expect(sameTeacherRosterLoadIdentity(identity, current)).toBe(false);
        expect(persistTeacherRosterCompletionIfCurrent(storage, candidate(), identity, current, now)).toEqual({ status: "stale" });
        expect(storage.setItem).not.toHaveBeenCalled();
        expect(storage.removeItem).not.toHaveBeenCalled();
        expect(storage.data).toEqual({ unrelated: "keep" });
    });

    it("rejects a candidate for another organization before either persistence side effect", () => {
        const storage = memoryStorage();
        expect(persistTeacherRosterCompletionIfCurrent(
            storage, candidate(snapshot(), "pilot_org_fedcba9876543210fedcba98"), identity, identity, now,
        )).toEqual({ status: "rejected" });
        expect(storage.writes).toEqual([]);
    });

    it("rejects accessors, proxies, and extra secret fields before legacy or scoped persistence", () => {
        let getterCalls = 0;
        const accessorStudent = Object.defineProperty({ ...snapshot().students[0] }, "name", {
            enumerable: true,
            get() { getterCalls += 1; return "secret accessor"; },
        });
        const candidates = [
            candidate({ ...snapshot(), students: [{ ...snapshot().students[0], bearer: "raw-secret-token" } as never] }),
            candidate({ ...snapshot(), students: [accessorStudent as never] }),
            new Proxy(candidate(), {}),
        ];
        for (const unsafe of candidates) {
            const storage = memoryStorage();
            expect(persistTeacherRosterCompletionIfCurrent(storage, unsafe, identity, identity, now)).toEqual({ status: "rejected" });
            expect(storage.writes).toEqual([]);
            expect(JSON.stringify(storage.data)).not.toContain("raw-secret-token");
        }
        expect(getterCalls).toBe(0);
    });

    it("writes the scoped cache only after the exact identity is current", () => {
        const storage = memoryStorage();
        expect(persistTeacherRosterCompletionIfCurrent(
            storage, candidate(), identity, identity, now,
        )).toEqual({ status: "persisted", localPersisted: true, cacheWritten: true });
        const cacheIdentity: CanonicalSurfaceCacheIdentity = { surface: "teacher_roster", ...identity };
        delete (cacheIdentity as Partial<TeacherRosterLoadIdentity>).requestGeneration;
        expect(storage.data[buildCanonicalSurfaceCacheKey(cacheIdentity)]).toBeTruthy();
        expect(storage.data.omr_teacher_roster_cache_stale_at_v1).toBeUndefined();
    });
});
