import { studentIdFor } from "@/utils/storage";

export const ROSTER_STORAGE_KEYS = {
    students: "omr_students",
    groups: "omr_groups",
    invites: "omr_invites",
} as const;

export const GROUP_COLORS = ["#4f46e5", "#ec4899", "#8b5cf6", "#10b981", "#f59e0b", "#ef4444"];
export const AVATAR_COLORS = ["#4f46e5", "#ec4899", "#8b5cf6", "#10b981", "#f59e0b", "#0ea5e9", "#ef4444"];

export interface RosterStudent {
    id: string;
    name: string;
    email: string;
    group: string;
    /** Optional operating region/campus/branch for academy-level rollups. */
    region?: string;
    avatar: string;
    avgScore: number;
    examsTaken: number;
    lastActive: string;
    trend: "up" | "down" | "flat";
    status: "active" | "idle";
}

export interface RosterGroup {
    id: string;
    name: string;
    /** Optional operating region/campus/branch for academy-level rollups. */
    region?: string;
    count: number;
    avgScore: number;
    color: string;
}

export interface RosterInvite {
    id: string;
    email: string;
    sentAt: string;
    status: "pending" | "accepted" | "expired";
}

type Trend = RosterStudent["trend"];
type Status = RosterStudent["status"];
type InviteStatus = RosterInvite["status"];

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

export function rosterGroupScopeKey(name: string | undefined, region?: string): string {
    const groupName = asString(name).toLocaleLowerCase("ko-KR");
    const regionName = asString(region).toLocaleLowerCase("ko-KR");
    return `${regionName}::${groupName}`;
}

export function rosterStudentFallbackGroupKey(group: string | undefined, region?: string): string {
    const groupName = asString(group) || "미분류";
    const regionName = asString(region);
    return regionName ? `${regionName}/${groupName}` : groupName;
}

export function rosterStudentFallbackId(name: string, group: string, region?: string): string {
    return studentIdFor(name, rosterStudentFallbackGroupKey(group, region));
}

export function disambiguateRosterStudentId(baseId: string, uniqueHint: string): string {
    const normalizedBase = asString(baseId);
    const normalizedHint = asString(uniqueHint).toLocaleLowerCase("ko-KR");
    if (!normalizedBase || !normalizedHint) return normalizedBase;

    let hash = 2166136261;
    for (let i = 0; i < normalizedHint.length; i += 1) {
        hash ^= normalizedHint.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }

    return `${normalizedBase}#${(hash >>> 0).toString(36)}`;
}

export function scopedGroupKeyForStudentId(studentId: string | undefined): string {
    const normalized = asString(studentId);
    const separator = normalized.indexOf("::");
    return separator > 0 ? normalized.slice(0, separator).trim() : "";
}

export function rosterGroupMatchesStudent(group: Pick<RosterGroup, "id" | "name" | "region">, student: Pick<RosterStudent, "id" | "group" | "region">): boolean {
    const groupId = asString(group.id);
    const groupName = asString(group.name);
    const groupRegion = asString(group.region);
    const studentGroup = asString(student.group);
    const studentRegion = asString(student.region);

    // Student ids are scoped to the group they were created in
    // (`${groupId}::${name}`) and never change when a student is moved to a
    // different group — regenerating them would break studentCodeRegistry
    // and other id-keyed references. So once a student carries an explicit
    // group field, that field (not the id-encoded scope) is the source of
    // truth for membership. Falling back to the id scope here as well as
    // the name match used to double-count a moved student in both their old
    // and new group, and made the old (now-empty) group look "not empty"
    // forever, blocking deletion.
    if (studentGroup) {
        if (studentGroup !== groupName) return false;
        if (!groupRegion) return true;
        if (studentRegion) return studentRegion === groupRegion;
        return false;
    }

    // Legacy/malformed records with no group field: fall back to the
    // id-encoded scope so pre-existing data keeps matching.
    const scopedGroup = scopedGroupKeyForStudentId(student.id);
    const regionScopedGroup = rosterStudentFallbackGroupKey(groupName, groupRegion);

    if (groupId && scopedGroup === groupId) return true;
    if (groupRegion && scopedGroup === regionScopedGroup) return true;
    return !!groupName && scopedGroup === groupName;
}

function finiteNumber(value: unknown, fallback = 0): number {
    const number = typeof value === "number" ? value : Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function clampPercent(value: unknown): number {
    return Math.max(0, Math.min(100, Math.round(finiteNumber(value))));
}

function nonNegativeInt(value: unknown): number {
    return Math.max(0, Math.floor(finiteNumber(value)));
}

function parseJsonArray(raw: string | null | undefined): unknown[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export function normalizeRosterStudent(value: unknown, index = 0): RosterStudent | null {
    if (!isRecord(value)) return null;
    const name = asString(value.name);
    if (!name) return null;
    const group = asString(value.group) || "미분류";
    const region = asString(value.region) || asString(value.campus) || asString(value.branch);
    const id = asString(value.id) || rosterStudentFallbackId(name, group, region);
    const rawTrend = asString(value.trend) as Trend;
    const rawStatus = asString(value.status) as Status;

    const student: RosterStudent = {
        id,
        name,
        email: asString(value.email),
        group,
        avatar: asString(value.avatar) || AVATAR_COLORS[index % AVATAR_COLORS.length],
        avgScore: clampPercent(value.avgScore),
        examsTaken: nonNegativeInt(value.examsTaken),
        lastActive: asString(value.lastActive) || "기록 없음",
        trend: rawTrend === "up" || rawTrend === "down" || rawTrend === "flat" ? rawTrend : "flat",
        status: rawStatus === "active" || rawStatus === "idle" ? rawStatus : "active",
    };
    return region ? { ...student, region } : student;
}

export function normalizeRosterGroup(value: unknown, index = 0): RosterGroup | null {
    if (!isRecord(value)) return null;
    const name = asString(value.name);
    if (!name) return null;
    const region = asString(value.region) || asString(value.campus) || asString(value.branch);

    const group: RosterGroup = {
        id: asString(value.id) || `group:${name}`,
        name,
        count: nonNegativeInt(value.count),
        avgScore: clampPercent(value.avgScore),
        color: asString(value.color) || GROUP_COLORS[index % GROUP_COLORS.length],
    };
    return region ? { ...group, region } : group;
}

export function normalizeRosterInvite(value: unknown, index = 0): RosterInvite | null {
    if (!isRecord(value)) return null;
    const email = asString(value.email).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    const rawStatus = asString(value.status) as InviteStatus;

    return {
        id: asString(value.id) || `invite:${email}:${index}`,
        email,
        sentAt: asString(value.sentAt) || "기록 없음",
        status: rawStatus === "accepted" || rawStatus === "expired" || rawStatus === "pending" ? rawStatus : "pending",
    };
}

export function parseStoredRosterStudents(raw: string | null | undefined, fallback: RosterStudent[] = []): RosterStudent[] {
    const parsed = parseJsonArray(raw).map(normalizeRosterStudent).filter((item): item is RosterStudent => !!item);
    return parsed.length > 0 ? parsed : fallback;
}

export function parseStoredRosterGroups(raw: string | null | undefined, fallback: RosterGroup[] = []): RosterGroup[] {
    const parsed = parseJsonArray(raw).map(normalizeRosterGroup).filter((item): item is RosterGroup => !!item);
    return parsed.length > 0 ? parsed : fallback;
}

export function parseStoredRosterInvites(raw: string | null | undefined, fallback: RosterInvite[] = []): RosterInvite[] {
    const parsed = parseJsonArray(raw).map(normalizeRosterInvite).filter((item): item is RosterInvite => !!item);
    return parsed.length > 0 ? parsed : fallback;
}

export function readRosterStudents(storage: Pick<Storage, "getItem">, fallback: RosterStudent[] = []): RosterStudent[] {
    return parseStoredRosterStudents(storage.getItem(ROSTER_STORAGE_KEYS.students), fallback);
}

export function readRosterGroups(storage: Pick<Storage, "getItem">, fallback: RosterGroup[] = []): RosterGroup[] {
    return parseStoredRosterGroups(storage.getItem(ROSTER_STORAGE_KEYS.groups), fallback);
}

export function readRosterInvites(storage: Pick<Storage, "getItem">, fallback: RosterInvite[] = []): RosterInvite[] {
    return parseStoredRosterInvites(storage.getItem(ROSTER_STORAGE_KEYS.invites), fallback);
}

export function hasStoredRosterData(storage: Pick<Storage, "getItem">): boolean {
    return Object.values(ROSTER_STORAGE_KEYS).some(key => storage.getItem(key) !== null);
}
