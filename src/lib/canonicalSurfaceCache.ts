import { INITIAL_OPERATIONS_LIMITS } from "@/lib/initialOperationsPolicy";

export type CanonicalSurface = "teacher_dashboard" | "teacher_roster";

export interface CanonicalSurfaceCacheIdentity {
    surface: CanonicalSurface;
    organizationId: string;
    accountId: string;
    sessionGeneration: number;
}

export interface CanonicalDashboardExamSummary {
    id: string;
    title: string;
    status: "active" | "archived";
    createdAt: string;
    updatedAt: string;
    questionCount: number;
    attemptCount: number;
}

export interface CanonicalDashboardAttemptSummary {
    id: string;
    examId: string;
    studentId: string | null;
    studentName: string;
    status: "completed" | "in_progress";
    score: number;
    totalScore: number;
    startedAt: string;
    finishedAt: string;
    isRetake: boolean;
}

export interface CanonicalDashboardCacheData {
    exams: CanonicalDashboardExamSummary[];
    attempts: CanonicalDashboardAttemptSummary[];
}

export interface CanonicalRosterStudentSummary {
    id: string;
    name: string;
    email: string;
    groupId: string;
    status: "active" | "idle" | "invited";
    avgScore: number;
    examsTaken: number;
    lastActive: string;
}

export interface CanonicalRosterGroupSummary {
    id: string;
    name: string;
    status: "active" | "archived";
    studentCount: number;
    avgScore: number;
}

export interface CanonicalRosterInviteSummary {
    id: string;
    email: string;
    status: "pending" | "accepted" | "expired";
    sentAt: string;
}

export interface CanonicalRosterCacheData {
    students: CanonicalRosterStudentSummary[];
    groups: CanonicalRosterGroupSummary[];
    invites: CanonicalRosterInviteSummary[];
}

export type CanonicalSurfaceCacheData = CanonicalDashboardCacheData | CanonicalRosterCacheData;

export interface CanonicalSurfaceCacheEnvelope<T> extends CanonicalSurfaceCacheIdentity {
    schemaVersion: 1;
    staleAt: string;
    data: T;
}

export interface CanonicalSurfaceCacheStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

export const CANONICAL_SURFACE_CACHE_BYTE_LIMITS = Object.freeze({
    teacher_dashboard: 2 * 1024 * 1024,
    teacher_roster: 1024 * 1024,
} satisfies Record<CanonicalSurface, number>);

export const CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS = Object.freeze({
    id: 128,
    title: 256,
    name: 192,
    email: 254,
    lastActiveLabel: 120,
    inviteSentAtLabel: 192,
} as const);

export const LEGACY_CANONICAL_SURFACE_MARKER_KEYS = Object.freeze([
    "omr_teacher_dashboard_cache_stale_at_v1",
    "omr_teacher_roster_cache_stale_at_v1",
] as const);

export type CanonicalSurfaceCacheWriteResult =
    | { status: "written" }
    | { status: "rejected" }
    | { status: "storage_failure" };

export type CanonicalSurfaceCacheReadResult<T> =
    | { status: "hit"; envelope: CanonicalSurfaceCacheEnvelope<T> }
    | { status: "miss" };

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const CACHE_KEY_PREFIX = "omr:canonical-surface-cache:v1";
const IDENTITY_KEYS = ["surface", "organizationId", "accountId", "sessionGeneration"] as const;
const ENVELOPE_KEYS = [
    "schemaVersion", "surface", "organizationId", "accountId", "sessionGeneration", "staleAt", "data",
] as const;
const DASHBOARD_ROOT_KEYS = ["exams", "attempts"] as const;
const DASHBOARD_EXAM_KEYS = [
    "id", "title", "status", "createdAt", "updatedAt", "questionCount", "attemptCount",
] as const;
const DASHBOARD_ATTEMPT_KEYS = [
    "id", "examId", "studentId", "studentName", "status", "score", "totalScore",
    "startedAt", "finishedAt", "isRetake",
] as const;
const ROSTER_ROOT_KEYS = ["students", "groups", "invites"] as const;
const ROSTER_STUDENT_KEYS = [
    "id", "name", "email", "groupId", "status", "avgScore", "examsTaken", "lastActive",
] as const;
const ROSTER_GROUP_KEYS = ["id", "name", "status", "studentCount", "avgScore"] as const;
const ROSTER_INVITE_KEYS = ["id", "email", "status", "sentAt"] as const;
const MAX_VALIDATION_DEPTH = 32;
const MAX_VALIDATION_NODES = 100_000;
const MAX_QUESTION_COUNT = 1_000;
const DANGEROUS_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const textEncoder = new TextEncoder();
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_CHARACTER_RUN_PATTERN = /[\u0000-\u001f\u007f-\u009f]+/g;

class InvalidCacheValue extends Error {}

export interface CanonicalSurfaceCacheTextNormalization {
    value: string;
    truncated: boolean;
}

function encodeKeyPart(value: string): string {
    return encodeURIComponent(value);
}

function buildKey(identity: CanonicalSurfaceCacheIdentity): string {
    return [
        CACHE_KEY_PREFIX,
        identity.surface,
        encodeKeyPart(identity.organizationId),
        encodeKeyPart(identity.accountId),
        String(identity.sessionGeneration),
    ].join(":");
}

export function buildCanonicalSurfaceCacheKey(identity: CanonicalSurfaceCacheIdentity): string {
    try {
        const snapshot = snapshotIdentity(identity);
        return snapshot ? buildKey(snapshot) : "";
    } catch {
        return "";
    }
}

function isCanonicalUtc(value: unknown): value is string {
    if (typeof value !== "string") return false;
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isCanonicalUtcAtOrBefore(value: unknown, now: Date): value is string {
    return isCanonicalUtc(value) && Number.isFinite(now.getTime()) && Date.parse(value) <= now.getTime();
}

function jsonEscapedStringByteLength(value: string): number {
    return textEncoder.encode(JSON.stringify(value)).byteLength - 2;
}

function wellFormedCodePoint(value: string): string {
    if (value.length === 1) {
        const code = value.charCodeAt(0);
        if (code >= 0xd800 && code <= 0xdfff) return "\ufffd";
    }
    return value;
}

/**
 * Replaces control runs with a visible space and bounds a display string
 * without splitting a user-perceived grapheme.
 * Task 3 and Task 5 projection callers must apply this to upstream title/name
 * fields before attempting a canonical cache write and retain `truncated` for
 * truthful degraded-display treatment.
 */
export function normalizeCanonicalSurfaceCacheText(
    input: string,
    maxJsonEscapedBytes: number,
): CanonicalSurfaceCacheTextNormalization {
    const trimmed = input.replace(CONTROL_CHARACTER_RUN_PATTERN, " ").trim();
    const normalized = Array.from(trimmed, wellFormedCodePoint).join("");
    const ellipsis = "…";
    if (!Number.isSafeInteger(maxJsonEscapedBytes) || maxJsonEscapedBytes < jsonEscapedStringByteLength(ellipsis)) {
        return { value: "", truncated: input.length > 0 };
    }
    if (input.length > 0 && normalized.length === 0) return { value: ellipsis, truncated: true };
    if (jsonEscapedStringByteLength(normalized) <= maxJsonEscapedBytes) {
        return { value: normalized, truncated: false };
    }

    const budget = maxJsonEscapedBytes - jsonEscapedStringByteLength(ellipsis);
    if (typeof Intl.Segmenter !== "function") return { value: ellipsis, truncated: true };

    let graphemes: Intl.Segments;
    try {
        graphemes = new Intl.Segmenter("und", { granularity: "grapheme" }).segment(normalized);
    } catch {
        return { value: ellipsis, truncated: true };
    }
    const parts: string[] = [];
    let used = 0;
    for (const { segment: part } of graphemes) {
        const bytes = jsonEscapedStringByteLength(part);
        if (used + bytes > budget) break;
        parts.push(part);
        used += bytes;
    }
    return { value: `${parts.join("")}${ellipsis}`, truncated: true };
}

function assertStableOwnData(
    value: unknown,
    arrayLimit: (path: readonly string[]) => number = () => MAX_VALIDATION_NODES,
): JsonValue {
    const seen = new WeakSet<object>();
    let nodeCount = 0;

    function visit(current: unknown, depth: number, path: readonly string[]): JsonValue {
        nodeCount += 1;
        if (nodeCount > MAX_VALIDATION_NODES || depth > MAX_VALIDATION_DEPTH) throw new InvalidCacheValue();
        if (current === null || typeof current === "boolean" || typeof current === "string") return current;
        if (typeof current === "number") {
            if (!Number.isFinite(current)) throw new InvalidCacheValue();
            return current;
        }
        if (typeof current !== "object" || seen.has(current)) throw new InvalidCacheValue();
        seen.add(current);

        const isArray = Array.isArray(current);
        const prototype = Object.getPrototypeOf(current);
        if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
            throw new InvalidCacheValue();
        }
        if (isArray) {
            const array = current as unknown[];
            const maximumLength = Math.min(MAX_VALIDATION_NODES, arrayLimit(path));
            if (!Number.isSafeInteger(array.length) || array.length > maximumLength) throw new InvalidCacheValue();
        }

        const keys = Reflect.ownKeys(current);
        if (keys.some(key => typeof key !== "string")) throw new InvalidCacheValue();

        if (isArray) {
            const array = current as unknown[];
            const stringKeys = keys.filter(key => key !== "length") as string[];
            if (stringKeys.length !== array.length) throw new InvalidCacheValue();
            const result: JsonValue[] = [];
            for (let index = 0; index < array.length; index += 1) {
                const key = String(index);
                if (stringKeys[index] !== key) throw new InvalidCacheValue();
                const descriptor = Object.getOwnPropertyDescriptor(current, key);
                if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new InvalidCacheValue();
                result.push(visit(descriptor.value, depth + 1, [...path, key]));
                assertDescriptorUnchanged(current, key, descriptor);
            }
            const lengthDescriptor = Object.getOwnPropertyDescriptor(current, "length");
            if (!lengthDescriptor || !("value" in lengthDescriptor) || lengthDescriptor.value !== array.length) {
                throw new InvalidCacheValue();
            }
            return result;
        }

        const result: { [key: string]: JsonValue } = {};
        for (const key of keys as string[]) {
            if (DANGEROUS_OBJECT_KEYS.has(key)) throw new InvalidCacheValue();
            const descriptor = Object.getOwnPropertyDescriptor(current, key);
            if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new InvalidCacheValue();
            result[key] = visit(descriptor.value, depth + 1, [...path, key]);
            assertDescriptorUnchanged(current, key, descriptor);
        }
        const finalKeys = Reflect.ownKeys(current);
        if (finalKeys.length !== keys.length || finalKeys.some((key, index) => key !== keys[index])) throw new InvalidCacheValue();
        return result;
    }

    const snapshot = visit(value, 0, []);
    if (typeof structuredClone !== "function") throw new InvalidCacheValue();
    structuredClone(value);
    return snapshot;
}

function assertDescriptorUnchanged(object: object, key: PropertyKey, before: PropertyDescriptor): void {
    const after = Object.getOwnPropertyDescriptor(object, key);
    if (!after
        || !("value" in before)
        || !("value" in after)
        || after.value !== before.value
        || after.enumerable !== before.enumerable
        || after.configurable !== before.configurable
        || after.writable !== before.writable) throw new InvalidCacheValue();
}

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
    return value !== null && !Array.isArray(value) && typeof value === "object";
}

function hasExactOwnKeys(value: object, expected: readonly string[]): boolean {
    const keys = Reflect.ownKeys(value);
    return keys.length === expected.length && expected.every(key => keys.includes(key));
}

function validIdentityPart(value: JsonValue | undefined): value is string {
    return typeof value === "string"
        && value.length >= 1
        && value.length <= 256
        && value.trim() === value
        && !CONTROL_CHARACTER_PATTERN.test(value);
}

function snapshotIdentity(identity: CanonicalSurfaceCacheIdentity): CanonicalSurfaceCacheIdentity | null {
    const value = assertStableOwnData(identity);
    if (!isRecord(value) || !hasExactOwnKeys(value, IDENTITY_KEYS)) return null;
    if ((value.surface !== "teacher_dashboard" && value.surface !== "teacher_roster")
        || !validIdentityPart(value.organizationId)
        || !validIdentityPart(value.accountId)
        || !Number.isSafeInteger(value.sessionGeneration)
        || (value.sessionGeneration as number) < 1) return null;
    return value as unknown as CanonicalSurfaceCacheIdentity;
}

function validBoundedString(value: JsonValue | undefined, maxBytes: number, allowEmpty = false): value is string {
    return typeof value === "string"
        && (allowEmpty || value.length > 0)
        && value.trim() === value
        && !CONTROL_CHARACTER_PATTERN.test(value)
        && jsonEscapedStringByteLength(value) <= maxBytes;
}

function surfaceArrayLimit(surface: CanonicalSurface, path: readonly string[]): number {
    const field = path[path.length - 1];
    if (surface === "teacher_dashboard") {
        if (field === "exams") return INITIAL_OPERATIONS_LIMITS.teacherExams;
        if (field === "attempts") return INITIAL_OPERATIONS_LIMITS.teacherAttempts;
        return 0;
    }
    if (field === "students") return INITIAL_OPERATIONS_LIMITS.activeStudents;
    if (field === "groups") return INITIAL_OPERATIONS_LIMITS.classes;
    if (field === "invites") return INITIAL_OPERATIONS_LIMITS.invites;
    return 0;
}

function validNumber(value: JsonValue | undefined, min: number, max: number): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function validInteger(value: JsonValue | undefined, min: number, max: number): value is number {
    return validNumber(value, min, max) && Number.isSafeInteger(value);
}

function validDashboardExam(value: JsonValue): boolean {
    return isRecord(value)
        && hasExactOwnKeys(value, DASHBOARD_EXAM_KEYS)
        && validBoundedString(value.id, CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.id)
        && validBoundedString(value.title, CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.title)
        && (value.status === "active" || value.status === "archived")
        && isCanonicalUtc(value.createdAt)
        && isCanonicalUtc(value.updatedAt)
        && validInteger(value.questionCount, 0, MAX_QUESTION_COUNT)
        && validInteger(value.attemptCount, 0, INITIAL_OPERATIONS_LIMITS.teacherAttempts);
}

function validDashboardAttempt(value: JsonValue): boolean {
    return isRecord(value)
        && hasExactOwnKeys(value, DASHBOARD_ATTEMPT_KEYS)
        && validBoundedString(value.id, CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.id)
        && validBoundedString(value.examId, CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.id)
        && (value.studentId === null || validBoundedString(value.studentId, CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.id))
        && validBoundedString(value.studentName, CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.name)
        && (value.status === "completed" || value.status === "in_progress")
        && validNumber(value.score, 0, Number.MAX_VALUE)
        && validNumber(value.totalScore, 0, Number.MAX_VALUE)
        && value.score <= value.totalScore
        && isCanonicalUtc(value.startedAt)
        && isCanonicalUtc(value.finishedAt)
        && typeof value.isRetake === "boolean";
}

function validDashboardData(value: JsonValue): boolean {
    return isRecord(value)
        && hasExactOwnKeys(value, DASHBOARD_ROOT_KEYS)
        && Array.isArray(value.exams)
        && value.exams.length <= INITIAL_OPERATIONS_LIMITS.teacherExams
        && value.exams.every(validDashboardExam)
        && Array.isArray(value.attempts)
        && value.attempts.length <= INITIAL_OPERATIONS_LIMITS.teacherAttempts
        && value.attempts.every(validDashboardAttempt);
}

function validRosterStudent(value: JsonValue): boolean {
    return isRecord(value)
        && hasExactOwnKeys(value, ROSTER_STUDENT_KEYS)
        && validBoundedString(value.id, CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.id)
        && validBoundedString(value.name, CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.name)
        && validBoundedString(value.email, CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.email, true)
        && validBoundedString(value.groupId, CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.id, true)
        && (value.status === "active" || value.status === "idle" || value.status === "invited")
        && validNumber(value.avgScore, 0, 100)
        && validInteger(value.examsTaken, 0, INITIAL_OPERATIONS_LIMITS.teacherAttempts)
        && validBoundedString(value.lastActive, CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.lastActiveLabel);
}

function validRosterGroup(value: JsonValue): boolean {
    return isRecord(value)
        && hasExactOwnKeys(value, ROSTER_GROUP_KEYS)
        && validBoundedString(value.id, CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.id)
        && validBoundedString(value.name, CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.name)
        && (value.status === "active" || value.status === "archived")
        && validInteger(value.studentCount, 0, INITIAL_OPERATIONS_LIMITS.activeStudents)
        && validNumber(value.avgScore, 0, 100);
}

function validRosterInvite(value: JsonValue): boolean {
    return isRecord(value)
        && hasExactOwnKeys(value, ROSTER_INVITE_KEYS)
        && validBoundedString(value.id, CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.id)
        && validBoundedString(value.email, CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.email)
        && (value.status === "pending" || value.status === "accepted" || value.status === "expired")
        && validBoundedString(value.sentAt, CANONICAL_SURFACE_CACHE_FIELD_BYTE_LIMITS.inviteSentAtLabel);
}

function validRosterData(value: JsonValue): boolean {
    return isRecord(value)
        && hasExactOwnKeys(value, ROSTER_ROOT_KEYS)
        && Array.isArray(value.students)
        && value.students.length <= INITIAL_OPERATIONS_LIMITS.activeStudents
        && value.students.every(validRosterStudent)
        && Array.isArray(value.groups)
        && value.groups.length <= INITIAL_OPERATIONS_LIMITS.classes
        && value.groups.every(validRosterGroup)
        && Array.isArray(value.invites)
        && value.invites.length <= INITIAL_OPERATIONS_LIMITS.invites
        && value.invites.every(validRosterInvite);
}

function validSurfaceProjection(surface: CanonicalSurface, data: JsonValue): boolean {
    return surface === "teacher_dashboard" ? validDashboardData(data) : validRosterData(data);
}

function validateEnvelope(value: JsonValue, identity: CanonicalSurfaceCacheIdentity, now: Date): boolean {
    return isRecord(value)
        && hasExactOwnKeys(value, ENVELOPE_KEYS)
        && value.schemaVersion === 1
        && value.surface === identity.surface
        && value.organizationId === identity.organizationId
        && value.accountId === identity.accountId
        && value.sessionGeneration === identity.sessionGeneration
        && isCanonicalUtcAtOrBefore(value.staleAt, now)
        && validSurfaceProjection(identity.surface, value.data);
}

export function writeCanonicalSurfaceCache<T>(
    storage: CanonicalSurfaceCacheStorage,
    identity: CanonicalSurfaceCacheIdentity,
    staleAt: string,
    data: T,
    now = new Date(),
): CanonicalSurfaceCacheWriteResult {
    let safeIdentity: CanonicalSurfaceCacheIdentity;
    let serialized: string;
    try {
        const identitySnapshot = snapshotIdentity(identity);
        if (!identitySnapshot || !isCanonicalUtcAtOrBefore(staleAt, now)) return { status: "rejected" };
        safeIdentity = identitySnapshot;
        const limitArray = (path: readonly string[]) => surfaceArrayLimit(safeIdentity.surface, path);
        const dataSnapshot = assertStableOwnData(data, limitArray);
        if (!validSurfaceProjection(safeIdentity.surface, dataSnapshot)) return { status: "rejected" };
        const envelope: CanonicalSurfaceCacheEnvelope<CanonicalSurfaceCacheData> = {
            schemaVersion: 1,
            ...safeIdentity,
            staleAt,
            data: dataSnapshot as unknown as CanonicalSurfaceCacheData,
        };
        serialized = JSON.stringify(envelope);
        if (textEncoder.encode(serialized).byteLength > CANONICAL_SURFACE_CACHE_BYTE_LIMITS[safeIdentity.surface]) {
            return { status: "rejected" };
        }
        const reparsed = assertStableOwnData(JSON.parse(serialized), limitArray);
        if (!validateEnvelope(reparsed, safeIdentity, now) || JSON.stringify(reparsed) !== serialized) {
            return { status: "rejected" };
        }
    } catch {
        return { status: "rejected" };
    }
    try {
        storage.setItem(buildKey(safeIdentity), serialized);
        return { status: "written" };
    } catch {
        return { status: "storage_failure" };
    }
}

export function readCanonicalSurfaceCache<T>(
    storage: CanonicalSurfaceCacheStorage,
    identity: CanonicalSurfaceCacheIdentity,
    now = new Date(),
): CanonicalSurfaceCacheReadResult<T> {
    try {
        const safeIdentity = snapshotIdentity(identity);
        if (!safeIdentity || !Number.isFinite(now.getTime())) return { status: "miss" };
        const raw = storage.getItem(buildKey(safeIdentity));
        if (!raw || textEncoder.encode(raw).byteLength > CANONICAL_SURFACE_CACHE_BYTE_LIMITS[safeIdentity.surface]) {
            return { status: "miss" };
        }
        const snapshot = assertStableOwnData(
            JSON.parse(raw),
            path => surfaceArrayLimit(safeIdentity.surface, path),
        );
        if (!validateEnvelope(snapshot, safeIdentity, now) || JSON.stringify(snapshot) !== raw) return { status: "miss" };
        return { status: "hit", envelope: snapshot as unknown as CanonicalSurfaceCacheEnvelope<T> };
    } catch {
        return { status: "miss" };
    }
}

export function removeCanonicalSurfaceCache(
    storage: CanonicalSurfaceCacheStorage,
    identity: CanonicalSurfaceCacheIdentity,
): void {
    try {
        const safeIdentity = snapshotIdentity(identity);
        if (safeIdentity) storage.removeItem(buildKey(safeIdentity));
    } catch {
        // Cache cleanup is best-effort and must not block identity transitions.
    }
}

export function removeCanonicalSurfaceCachesForIdentity(
    storage: CanonicalSurfaceCacheStorage,
    identity: Omit<CanonicalSurfaceCacheIdentity, "surface">,
): void {
    try {
        const organizationId = identity.organizationId;
        const accountId = identity.accountId;
        const sessionGeneration = identity.sessionGeneration;
        for (const surface of ["teacher_dashboard", "teacher_roster"] as const) {
            removeCanonicalSurfaceCache(storage, { surface, organizationId, accountId, sessionGeneration });
        }
    } catch {
        // An adversarial identity must not make logout throw.
    }
}

export function purgeLegacyCanonicalSurfaceMarkers(storage: CanonicalSurfaceCacheStorage): void {
    for (const key of LEGACY_CANONICAL_SURFACE_MARKER_KEYS) {
        try {
            storage.removeItem(key);
        } catch {
            // Keep attempting the other exact legacy key.
        }
    }
}
