import {
    CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS,
    normalizeCanonicalSurfaceCacheText,
    readCanonicalSurfaceCache,
    writeCanonicalSurfaceCache,
    type CanonicalRosterCacheData,
    type CanonicalRosterGroupSummary,
    type CanonicalRosterInviteSummary,
    type CanonicalRosterStudentSummary,
    type CanonicalSurfaceCacheIdentity,
    type CanonicalSurfaceCacheStorage,
} from "@/lib/canonicalSurfaceCache";
import {
    persistTeacherRosterCandidate,
    type TeacherRosterRemoteCandidate,
} from "@/lib/teacherRosterClient";
import { rosterSnapshotWithStudentGroups, type RosterSnapshot } from "@/lib/rosterPersistence";
import {
    AVATAR_COLORS,
    GROUP_COLORS,
    rosterGroupMatchesStudent,
    type RosterGroup,
    type RosterInvite,
    type RosterStudent,
} from "@/lib/rosterStorage";
import { INITIAL_OPERATIONS_LIMITS } from "@/lib/initialOperationsPolicy";

const CANDIDATE_KEYS = ["snapshot", "revision", "meta"] as const;
const SNAPSHOT_KEYS = ["students", "groups", "invites"] as const;
const STUDENT_KEYS = [
    "id", "name", "email", "group", "avatar", "avgScore", "examsTaken", "lastActive", "trend", "status",
] as const;
const GROUP_KEYS = ["id", "name", "count", "avgScore", "color"] as const;
const INVITE_KEYS = ["id", "email", "sentAt", "status"] as const;
const META_KEYS = ["organizationId", "loadedAt", "rawCount", "parsedCount"] as const;

export interface TeacherRosterSessionIdentity {
    organizationId: string;
    accountId: string;
    sessionGeneration: number;
}

export interface TeacherRosterLoadIdentity extends TeacherRosterSessionIdentity {
    requestGeneration: number;
}

export interface TeacherRosterIdentityOperation {
    readonly identity: TeacherRosterSessionIdentity;
    readonly capabilityEpoch: number;
}

export interface TeacherRosterDegradedStudent extends CanonicalRosterStudentSummary {
    readonly kind: "degraded_roster_student";
}

export interface TeacherRosterDegradedGroup extends CanonicalRosterGroupSummary {
    readonly kind: "degraded_roster_group";
}

export interface TeacherRosterDegradedInvite extends CanonicalRosterInviteSummary {
    readonly kind: "degraded_roster_invite";
}

export interface TeacherRosterDegradedData {
    readonly kind: "teacher_roster_degraded";
    readonly staleAt: string;
    readonly students: readonly TeacherRosterDegradedStudent[];
    readonly groups: readonly TeacherRosterDegradedGroup[];
    readonly invites: readonly TeacherRosterDegradedInvite[];
}

export interface TeacherRosterDegradedDisplayData {
    students: RosterStudent[];
    groups: RosterGroup[];
    invites: RosterInvite[];
}

export type TeacherRosterCompletionPersistenceResult =
    | { status: "stale" }
    | { status: "rejected" }
    | { status: "persisted"; localPersisted: boolean; cacheWritten: boolean };

function cacheIdentity(identity: TeacherRosterSessionIdentity): CanonicalSurfaceCacheIdentity {
    return {
        surface: "teacher_roster",
        organizationId: identity.organizationId,
        accountId: identity.accountId,
        sessionGeneration: identity.sessionGeneration,
    };
}

function normalized(value: string, maximum: number): string {
    return normalizeCanonicalSurfaceCacheText(value, maximum).value;
}

function stableDataRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== "string")) return null;
    const stringKeys = keys as string[];
    if (required.some(key => !stringKeys.includes(key))
        || stringKeys.some(key => !required.includes(key) && !optional.includes(key))
        || stringKeys.length < required.length
        || stringKeys.length > required.length + optional.length) return null;
    const result: Record<string, unknown> = {};
    for (const key of stringKeys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
        result[key] = descriptor.value;
    }
    return result;
}

function stableDenseArray(value: unknown, maximum: number): unknown[] | null {
    if (!Array.isArray(value)
        || Object.getPrototypeOf(value) !== Array.prototype
        || !Number.isSafeInteger(value.length)
        || value.length > maximum) return null;
    const keys = Reflect.ownKeys(value).filter(key => key !== "length");
    if (keys.length !== value.length) return null;
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
        result.push(descriptor.value);
    }
    return result;
}

function primitiveString(value: unknown): value is string {
    return typeof value === "string";
}

function finiteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

export function sanitizeTeacherRosterCandidate(
    candidate: TeacherRosterRemoteCandidate,
): TeacherRosterRemoteCandidate | null {
    try {
        const candidateRecord = stableDataRecord(candidate, CANDIDATE_KEYS);
        if (!candidateRecord || !Number.isSafeInteger(candidateRecord.revision) || Number(candidateRecord.revision) < 0) return null;
        const snapshotRecord = stableDataRecord(candidateRecord.snapshot, SNAPSHOT_KEYS);
        const metaRecord = stableDataRecord(candidateRecord.meta, META_KEYS);
        if (!snapshotRecord || !metaRecord) return null;
        // The legacy snapshot can legitimately exceed the 100-row degraded
        // display envelope. Keep sanitization bounded by the shared hard node
        // ceiling; the cache codec itself enforces the visible 100-row limit.
        const students = stableDenseArray(snapshotRecord.students, INITIAL_OPERATIONS_LIMITS.teacherAttempts);
        const groups = stableDenseArray(snapshotRecord.groups, INITIAL_OPERATIONS_LIMITS.classes);
        const invites = stableDenseArray(snapshotRecord.invites, INITIAL_OPERATIONS_LIMITS.invites);
        if (!students || !groups || !invites) return null;

        const safeStudents: RosterStudent[] = [];
        for (const value of students) {
            const row = stableDataRecord(value, STUDENT_KEYS, ["region"]);
            if (!row
                || !primitiveString(row.id) || !primitiveString(row.name) || !primitiveString(row.email)
                || !primitiveString(row.group) || !primitiveString(row.avatar) || !primitiveString(row.lastActive)
                || !finiteNumber(row.avgScore) || !finiteNumber(row.examsTaken)
                || (row.trend !== "up" && row.trend !== "down" && row.trend !== "flat")
                || (row.status !== "active" && row.status !== "idle")
                || (row.region !== undefined && !primitiveString(row.region))) return null;
            safeStudents.push({
                id: row.id, name: row.name, email: row.email, group: row.group,
                ...(row.region === undefined ? {} : { region: row.region }),
                avatar: row.avatar, avgScore: row.avgScore, examsTaken: row.examsTaken,
                lastActive: row.lastActive, trend: row.trend, status: row.status,
            });
        }
        const safeGroups: RosterGroup[] = [];
        for (const value of groups) {
            const row = stableDataRecord(value, GROUP_KEYS, ["region"]);
            if (!row
                || !primitiveString(row.id) || !primitiveString(row.name) || !primitiveString(row.color)
                || !finiteNumber(row.count) || !finiteNumber(row.avgScore)
                || (row.region !== undefined && !primitiveString(row.region))) return null;
            safeGroups.push({
                id: row.id, name: row.name,
                ...(row.region === undefined ? {} : { region: row.region }),
                count: row.count, avgScore: row.avgScore, color: row.color,
            });
        }
        const safeInvites: RosterInvite[] = [];
        for (const value of invites) {
            const row = stableDataRecord(value, INVITE_KEYS);
            if (!row || !primitiveString(row.id) || !primitiveString(row.email) || !primitiveString(row.sentAt)
                || (row.status !== "pending" && row.status !== "accepted" && row.status !== "expired")) return null;
            safeInvites.push({ id: row.id, email: row.email, sentAt: row.sentAt, status: row.status });
        }
        if (!primitiveString(metaRecord.organizationId) || !primitiveString(metaRecord.loadedAt)
            || !Number.isSafeInteger(metaRecord.rawCount) || !Number.isSafeInteger(metaRecord.parsedCount)) return null;
        if (typeof structuredClone !== "function") return null;
        structuredClone(candidate);
        return {
            snapshot: { students: safeStudents, groups: safeGroups, invites: safeInvites },
            revision: candidateRecord.revision as number,
            meta: {
                organizationId: metaRecord.organizationId,
                loadedAt: metaRecord.loadedAt,
                rawCount: metaRecord.rawCount as number,
                parsedCount: metaRecord.parsedCount as number,
            },
        };
    } catch {
        return null;
    }
}

/**
 * Projects rich upstream roster records into the exact redacted cache schema.
 * Upstream display labels are normalized before writing so truncation remains
 * visible and grapheme-safe in a degraded surface.
 */
export function toTeacherRosterCacheProjection(snapshot: RosterSnapshot): CanonicalRosterCacheData {
    const complete = rosterSnapshotWithStudentGroups(snapshot);
    const groupCounts = new Map<string, number>();
    const studentGroupIds = new Map<string, string>();
    for (const student of complete.students) {
        const group = complete.groups.find(candidate => rosterGroupMatchesStudent(candidate, student));
        const groupId = group?.id || "";
        studentGroupIds.set(student.id, groupId);
        if (groupId) groupCounts.set(groupId, (groupCounts.get(groupId) || 0) + 1);
    }

    return {
        students: complete.students.map(student => ({
            id: student.id,
            name: normalized(student.name, CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.name),
            email: normalized(student.email, CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.email),
            groupId: studentGroupIds.get(student.id) || "",
            status: student.status,
            avgScore: student.avgScore,
            examsTaken: student.examsTaken,
            lastActive: normalized(
                student.lastActive,
                CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.lastActiveLabel,
            ),
        })),
        groups: complete.groups.map(group => ({
            id: group.id,
            name: normalized(group.name, CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.name),
            status: "active",
            studentCount: groupCounts.get(group.id) || 0,
            avgScore: group.avgScore,
        })),
        invites: complete.invites.map(invite => ({
            id: invite.id,
            email: normalized(invite.email, CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.email),
            status: invite.status,
            sentAt: normalized(
                invite.sentAt,
                CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.inviteSentAtLabel,
            ),
        })),
    };
}

export function materializeTeacherRosterDegradedCache(
    data: CanonicalRosterCacheData,
    staleAt: string,
): TeacherRosterDegradedData {
    const students = Object.freeze(data.students.map(student => Object.freeze({
        kind: "degraded_roster_student" as const,
        ...student,
    })));
    const groups = Object.freeze(data.groups.map(group => Object.freeze({
        kind: "degraded_roster_group" as const,
        ...group,
    })));
    const invites = Object.freeze(data.invites.map(invite => Object.freeze({
        kind: "degraded_roster_invite" as const,
        ...invite,
    })));
    return Object.freeze({
        kind: "teacher_roster_degraded" as const,
        staleAt,
        students,
        groups,
        invites,
    });
}

export function readTeacherRosterDegradedCache(
    storage: CanonicalSurfaceCacheStorage,
    identity: TeacherRosterSessionIdentity,
    now = new Date(),
): TeacherRosterDegradedData | null {
    const result = readCanonicalSurfaceCache<CanonicalRosterCacheData>(
        storage,
        cacheIdentity(identity),
        now,
    );
    return result.status === "hit"
        ? materializeTeacherRosterDegradedCache(result.envelope.data, result.envelope.staleAt)
        : null;
}

export function toTeacherRosterDegradedDisplayData(
    degraded: TeacherRosterDegradedData,
): TeacherRosterDegradedDisplayData {
    const groupNames = new Map(degraded.groups.map(group => [group.id, group.name]));
    return {
        groups: degraded.groups.map((group, index) => ({
            id: group.id,
            name: group.name,
            count: group.studentCount,
            avgScore: group.avgScore,
            color: GROUP_COLORS[index % GROUP_COLORS.length],
        })),
        students: degraded.students.map((student, index) => ({
            id: student.id,
            name: student.name,
            email: student.email,
            group: groupNames.get(student.groupId) || "미분류",
            avatar: AVATAR_COLORS[index % AVATAR_COLORS.length],
            avgScore: student.avgScore,
            examsTaken: student.examsTaken,
            lastActive: student.lastActive,
            trend: "flat",
            status: student.status === "active" ? "active" : "idle",
        })),
        invites: degraded.invites.map(invite => ({
            id: invite.id,
            email: invite.email,
            sentAt: invite.sentAt,
            status: invite.status,
        })),
    };
}

export function sameTeacherRosterSessionIdentity(
    left: TeacherRosterSessionIdentity,
    right: TeacherRosterSessionIdentity,
): boolean {
    try {
        return left.organizationId === right.organizationId
            && left.accountId === right.accountId
            && left.sessionGeneration === right.sessionGeneration;
    } catch {
        return false;
    }
}

export function sameTeacherRosterLoadIdentity(
    left: TeacherRosterLoadIdentity,
    right: TeacherRosterLoadIdentity,
): boolean {
    try {
        return sameTeacherRosterSessionIdentity(left, right)
            && left.requestGeneration === right.requestGeneration;
    } catch {
        return false;
    }
}

export function beginTeacherRosterIdentityOperation(
    identity: TeacherRosterSessionIdentity,
    capabilityEpoch: number,
): TeacherRosterIdentityOperation {
    return {
        identity: {
            organizationId: identity.organizationId,
            accountId: identity.accountId,
            sessionGeneration: identity.sessionGeneration,
        },
        capabilityEpoch,
    };
}

export function canContinueTeacherRosterIdentityOperation(
    operation: TeacherRosterIdentityOperation,
    currentIdentity: TeacherRosterSessionIdentity | null,
    currentCapabilityEpoch: number,
): boolean {
    return operation.capabilityEpoch === currentCapabilityEpoch
        && !!currentIdentity
        && sameTeacherRosterSessionIdentity(operation.identity, currentIdentity);
}

export function canContinueTeacherRosterBoundOperation(
    operation: TeacherRosterIdentityOperation,
    boundToken: number,
    currentToken: number | null,
    currentIdentity: TeacherRosterSessionIdentity | null,
    currentCapabilityEpoch: number,
): boolean {
    return Number.isSafeInteger(boundToken)
        && boundToken === currentToken
        && canContinueTeacherRosterIdentityOperation(operation, currentIdentity, currentCapabilityEpoch);
}

export function persistTeacherRosterCompletionIfCurrent(
    storage: CanonicalSurfaceCacheStorage,
    candidate: TeacherRosterRemoteCandidate,
    captured: TeacherRosterLoadIdentity,
    current: TeacherRosterLoadIdentity,
    now = new Date(),
): TeacherRosterCompletionPersistenceResult {
    if (!sameTeacherRosterLoadIdentity(captured, current)) return { status: "stale" };
    try {
        const safeCandidate = sanitizeTeacherRosterCandidate(candidate);
        if (!safeCandidate || safeCandidate.meta.organizationId !== captured.organizationId) return { status: "rejected" };
        const projection = toTeacherRosterCacheProjection(safeCandidate.snapshot);
        const localPersisted = persistTeacherRosterCandidate(storage, safeCandidate);
        const cacheWritten = writeCanonicalSurfaceCache(
            storage,
            cacheIdentity(captured),
            safeCandidate.meta.loadedAt,
            projection,
            now,
        ).status === "written";
        return { status: "persisted", localPersisted, cacheWritten };
    } catch {
        return { status: "rejected" };
    }
}
