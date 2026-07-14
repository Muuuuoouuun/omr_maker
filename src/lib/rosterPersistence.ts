import {
    AVATAR_COLORS,
    GROUP_COLORS,
    ROSTER_STORAGE_KEYS,
    normalizeRosterGroup,
    normalizeRosterStudent,
    parseStoredRosterGroups,
    parseStoredRosterInvites,
    parseStoredRosterStudents,
    readRosterGroups,
    readRosterInvites,
    readRosterStudents,
    rosterGroupMatchesStudent,
    rosterGroupScopeKey,
    type RosterGroup,
    type RosterInvite,
    type RosterStudent,
} from "@/lib/rosterStorage";
import {
    DEFAULT_WORKSPACE_ORGANIZATION_ID,
    DEFAULT_WORKSPACE_ORGANIZATION_NAME,
} from "@/lib/workspaceContext";

export const DEFAULT_ROSTER_ORGANIZATION_ID = DEFAULT_WORKSPACE_ORGANIZATION_ID;
export const ROSTER_TOMBSTONE_STORAGE_KEY = "omr_roster_tombstones";
const DEFAULT_ROSTER_ORGANIZATION_NAME = DEFAULT_WORKSPACE_ORGANIZATION_NAME;

export interface RosterSnapshot {
    students: RosterStudent[];
    groups: RosterGroup[];
    invites: RosterInvite[];
}
export interface RosterPersistenceResult {
    localSaved: boolean;
    remoteSaved: boolean;
    remoteError?: string;
}

export interface RosterLoadResult extends RosterSnapshot {
    remoteLoaded: boolean;
    remoteSynced?: boolean;
    pendingSyncCount?: number;
    remoteError?: string;
}

export interface RosterTombstones {
    students: Record<string, string>;
    groups: Record<string, string>;
}

export interface SupabaseOrganizationRow {
    id: string;
    name: string;
    plan: "free" | "pro" | "academy";
    metadata: Record<string, unknown>;
}

export interface SupabaseRosterClassRow {
    id: string;
    organization_id: string;
    name: string;
    campus: string | null;
    status: "active" | "archived";
    metadata: Record<string, unknown>;
    updated_at?: string;
}

export interface SupabaseRosterStudentProfileRow {
    id: string;
    organization_id: string;
    display_name: string;
    external_id: string | null;
    email: string | null;
    status: "invited" | "active" | "inactive" | "graduated" | "withdrawn";
    metadata: Record<string, unknown>;
    updated_at?: string;
}

export interface SupabaseRosterClassStudentRow {
    class_id: string;
    organization_id: string;
    student_profile_id: string;
    enrollment_status: "active" | "inactive" | "transferred" | "completed";
}

interface SupabaseRosterRows {
    organization: SupabaseOrganizationRow;
    classes: SupabaseRosterClassRow[];
    students: SupabaseRosterStudentProfileRow[];
    enrollments: SupabaseRosterClassStudentRow[];
}

export interface SupabaseRemoteRosterRows {
    classes: SupabaseRosterClassRow[];
    students: SupabaseRosterStudentProfileRow[];
    enrollments: SupabaseRosterClassStudentRow[];
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown, fallback = 0): number {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function metadata(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    if (value && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
        return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

function deepEqualJson(a: unknown, b: unknown): boolean {
    return stableStringify(a) === stableStringify(b);
}

function parseJson(value: string | null | undefined): unknown {
    if (!value) return null;
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return null;
    }
}

function stringRecord(value: unknown): Record<string, string> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .filter(([key, item]) => !!clean(key) && !!clean(item))
            .map(([key, item]) => [clean(key), clean(item)]),
    );
}

function rosterStatusToProfileStatus(status: RosterStudent["status"]): SupabaseRosterStudentProfileRow["status"] {
    return status === "idle" ? "inactive" : "active";
}

function profileStatusToRosterStatus(status: SupabaseRosterStudentProfileRow["status"]): RosterStudent["status"] {
    return status === "inactive" ? "idle" : "active";
}

function rosterStatusToEnrollmentStatus(status: RosterStudent["status"]): SupabaseRosterClassStudentRow["enrollment_status"] {
    return status === "idle" ? "inactive" : "active";
}

function groupForStudent(student: RosterStudent, groups: RosterGroup[]): RosterGroup {
    const matched = groups.find(group => rosterGroupMatchesStudent(group, student));
    if (matched) return matched;

    const region = clean(student.region);
    return {
        id: `group:${rosterGroupScopeKey(student.group, region)}`,
        name: student.group || "미분류",
        ...(region ? { region } : {}),
        count: 0,
        avgScore: 0,
        color: GROUP_COLORS[0],
    };
}

export function rosterSnapshotWithStudentGroups(snapshot: RosterSnapshot): RosterSnapshot {
    const groupsById = new Map(snapshot.groups.map(group => [group.id, group]));
    for (const student of snapshot.students) {
        const group = groupForStudent(student, Array.from(groupsById.values()));
        if (!groupsById.has(group.id)) groupsById.set(group.id, group);
    }
    return { ...snapshot, groups: Array.from(groupsById.values()) };
}

export function rosterGroupToSupabaseRow(
    group: RosterGroup,
    organizationId = DEFAULT_ROSTER_ORGANIZATION_ID,
    updatedAt = new Date().toISOString(),
): SupabaseRosterClassRow {
    return {
        id: group.id,
        organization_id: organizationId,
        name: group.name,
        campus: group.region || null,
        status: "active",
        metadata: {
            source: "omr_maker_roster",
            color: group.color,
            count: group.count,
            avgScore: group.avgScore,
            region: group.region || null,
        },
        updated_at: updatedAt,
    };
}

export function rosterStudentToSupabaseRow(
    student: RosterStudent,
    organizationId = DEFAULT_ROSTER_ORGANIZATION_ID,
    updatedAt = new Date().toISOString(),
): SupabaseRosterStudentProfileRow {
    return {
        id: student.id,
        organization_id: organizationId,
        display_name: student.name,
        external_id: student.id,
        email: student.email || null,
        status: rosterStatusToProfileStatus(student.status),
        metadata: {
            source: "omr_maker_roster",
            group: student.group,
            region: student.region || null,
            avatar: student.avatar,
            avgScore: student.avgScore,
            examsTaken: student.examsTaken,
            lastActive: student.lastActive,
            trend: student.trend,
            status: student.status,
        },
        updated_at: updatedAt,
    };
}

export function rosterEnrollmentToSupabaseRow(
    student: RosterStudent,
    groups: RosterGroup[],
    organizationId = DEFAULT_ROSTER_ORGANIZATION_ID,
): SupabaseRosterClassStudentRow {
    const group = groupForStudent(student, groups);
    return {
        class_id: group.id,
        organization_id: organizationId,
        student_profile_id: student.id,
        enrollment_status: rosterStatusToEnrollmentStatus(student.status),
    };
}

export function rosterSnapshotToSupabaseRows(
    snapshot: RosterSnapshot,
    organizationId = DEFAULT_ROSTER_ORGANIZATION_ID,
    updatedAt = new Date().toISOString(),
    organizationName = DEFAULT_ROSTER_ORGANIZATION_NAME,
): SupabaseRosterRows {
    const normalized = rosterSnapshotWithStudentGroups(snapshot);
    return {
        organization: {
            id: organizationId,
            name: organizationName,
            plan: "free",
            metadata: { source: "omr_maker_roster" },
        },
        classes: normalized.groups.map(group => rosterGroupToSupabaseRow(group, organizationId, updatedAt)),
        students: normalized.students.map(student => rosterStudentToSupabaseRow(student, organizationId, updatedAt)),
        enrollments: normalized.students.map(student => rosterEnrollmentToSupabaseRow(student, normalized.groups, organizationId)),
    };
}

function enrollmentKey(row: Pick<SupabaseRosterClassStudentRow, "class_id" | "student_profile_id">): string {
    return `${row.class_id}::${row.student_profile_id}`;
}

export function staleRosterRowsForSnapshot(
    snapshot: RosterSnapshot,
    remoteRows: SupabaseRemoteRosterRows,
    organizationId = DEFAULT_ROSTER_ORGANIZATION_ID,
    updatedAt = new Date().toISOString(),
): Pick<SupabaseRosterRows, "classes" | "students" | "enrollments"> {
    const activeRows = rosterSnapshotToSupabaseRows(snapshot, organizationId, updatedAt);
    const activeClassIds = new Set(activeRows.classes.map(row => row.id));
    const activeStudentIds = new Set(activeRows.students.map(row => row.id));
    const activeEnrollmentKeys = new Set(activeRows.enrollments.map(enrollmentKey));

    const classes = remoteRows.classes
        .filter(row => row.organization_id === organizationId)
        .filter(row => row.status !== "archived")
        .filter(row => !activeClassIds.has(row.id))
        .map(row => ({
            ...row,
            status: "archived" as const,
            metadata: {
                ...metadata(row.metadata),
                source: clean(metadata(row.metadata).source) || "omr_maker_roster",
                archivedBySync: true,
            },
            updated_at: updatedAt,
        }));

    const students = remoteRows.students
        .filter(row => row.organization_id === organizationId)
        .filter(row => row.status !== "withdrawn")
        .filter(row => !activeStudentIds.has(row.id))
        .map(row => ({
            ...row,
            status: "withdrawn" as const,
            metadata: {
                ...metadata(row.metadata),
                source: clean(metadata(row.metadata).source) || "omr_maker_roster",
                withdrawnBySync: true,
            },
            updated_at: updatedAt,
        }));

    const enrollments = remoteRows.enrollments
        .filter(row => row.organization_id === organizationId)
        .filter(row => row.enrollment_status !== "inactive")
        .filter(row => !activeEnrollmentKeys.has(enrollmentKey(row)))
        .map(row => ({
            ...row,
            enrollment_status: "inactive" as const,
        }));

    return { classes, students, enrollments };
}

export function rosterGroupFromSupabaseRow(row: SupabaseRosterClassRow, index = 0): RosterGroup | null {
    if (row.status === "archived") return null;
    const meta = metadata(row.metadata);
    return normalizeRosterGroup({
        id: row.id,
        name: row.name,
        region: row.campus || clean(meta.region),
        color: clean(meta.color) || GROUP_COLORS[index % GROUP_COLORS.length],
        count: numberValue(meta.count),
        avgScore: numberValue(meta.avgScore),
    }, index);
}

export function rosterStudentFromSupabaseRow(
    row: SupabaseRosterStudentProfileRow,
    groups: RosterGroup[],
    enrollment?: SupabaseRosterClassStudentRow,
    index = 0,
): RosterStudent | null {
    if (row.status === "withdrawn") return null;
    const meta = metadata(row.metadata);
    const group = enrollment
        ? groups.find(item => item.id === enrollment.class_id)
        : undefined;
    const status = clean(meta.status);

    return normalizeRosterStudent({
        id: row.id,
        name: row.display_name,
        email: row.email || "",
        group: group?.name || clean(meta.group) || "미분류",
        region: group?.region || clean(meta.region),
        avatar: clean(meta.avatar) || AVATAR_COLORS[index % AVATAR_COLORS.length],
        avgScore: numberValue(meta.avgScore),
        examsTaken: numberValue(meta.examsTaken),
        lastActive: clean(meta.lastActive) || "기록 없음",
        trend: clean(meta.trend) || "flat",
        status: status === "active" || status === "idle" ? status : profileStatusToRosterStatus(row.status),
    }, index);
}

export function readLocalRosterSnapshot(storage: Pick<Storage, "getItem">): RosterSnapshot {
    return {
        students: readRosterStudents(storage as Storage),
        groups: readRosterGroups(storage as Storage),
        invites: readRosterInvites(storage as Storage),
    };
}

export function writeLocalRosterSnapshot(
    storage: Pick<Storage, "setItem">,
    snapshot: RosterSnapshot,
): boolean {
    try {
        storage.setItem(ROSTER_STORAGE_KEYS.students, JSON.stringify(snapshot.students));
        storage.setItem(ROSTER_STORAGE_KEYS.groups, JSON.stringify(snapshot.groups));
        storage.setItem(ROSTER_STORAGE_KEYS.invites, JSON.stringify(snapshot.invites));
        return true;
    } catch {
        return false;
    }
}

export function readRosterTombstones(storage: Pick<Storage, "getItem">): RosterTombstones {
    const parsed = parseJson(storage.getItem(ROSTER_TOMBSTONE_STORAGE_KEY));
    return {
        students: stringRecord(metadata(parsed).students),
        groups: stringRecord(metadata(parsed).groups),
    };
}

export function writeRosterTombstones(
    storage: Pick<Storage, "setItem">,
    tombstones: RosterTombstones,
): boolean {
    try {
        storage.setItem(ROSTER_TOMBSTONE_STORAGE_KEY, JSON.stringify(tombstones));
        return true;
    } catch {
        return false;
    }
}

export function nextRosterTombstones(
    previous: RosterSnapshot,
    next: RosterSnapshot,
    current: RosterTombstones,
    deletedAt = new Date().toISOString(),
): RosterTombstones {
    const nextStudentIds = new Set(next.students.map(student => student.id));
    const nextGroupIds = new Set(next.groups.map(group => group.id));
    const previousStudentIds = new Set(previous.students.map(student => student.id));
    const previousGroupIds = new Set(previous.groups.map(group => group.id));

    const students = Object.fromEntries(
        Object.entries(current.students).filter(([id]) => !nextStudentIds.has(id)),
    );
    const groups = Object.fromEntries(
        Object.entries(current.groups).filter(([id]) => !nextGroupIds.has(id)),
    );

    for (const id of previousStudentIds) {
        if (!nextStudentIds.has(id)) students[id] = deletedAt;
    }
    for (const id of previousGroupIds) {
        if (!nextGroupIds.has(id)) groups[id] = deletedAt;
    }

    return { students, groups };
}

export function applyRosterTombstonesToSnapshot(
    snapshot: RosterSnapshot,
    tombstones: RosterTombstones,
): RosterSnapshot {
    const students = snapshot.students.filter(student => !tombstones.students[student.id]);
    const groups = snapshot.groups.filter(group => !tombstones.groups[group.id]);
    return { ...snapshot, students, groups };
}

/**
 * Reconcile an already-fetched remote snapshot without opening a browser database
 * connection. The server roster gateway owns all network reads and writes; this pure
 * helper remains useful for cache migration and conflict tests.
 */
export function reconcileRemoteDeletions(
    snapshot: RosterSnapshot,
    previousSnapshot: RosterSnapshot,
    remoteRows: SupabaseRemoteRosterRows,
    tombstones: RosterTombstones,
): { snapshot: RosterSnapshot; tombstones: RosterTombstones } {
    const previousStudentsById = new Map(previousSnapshot.students.map(student => [student.id, student]));
    const previousGroupsById = new Map(previousSnapshot.groups.map(group => [group.id, group]));
    const withdrawnStudentIds = new Set(
        remoteRows.students.filter(row => row.status === "withdrawn").map(row => row.id),
    );
    const archivedGroupIds = new Set(
        remoteRows.classes.filter(row => row.status === "archived").map(row => row.id),
    );
    const droppedStudentIds = new Set<string>();
    const droppedGroupIds = new Set<string>();

    const students = snapshot.students.filter(student => {
        if (!withdrawnStudentIds.has(student.id)) return true;
        const priorLocal = previousStudentsById.get(student.id);
        if (!priorLocal || !deepEqualJson(priorLocal, student)) return true;
        droppedStudentIds.add(student.id);
        return false;
    });
    const groups = snapshot.groups.filter(group => {
        if (!archivedGroupIds.has(group.id)) return true;
        const priorLocal = previousGroupsById.get(group.id);
        if (!priorLocal || !deepEqualJson(priorLocal, group)) return true;
        droppedGroupIds.add(group.id);
        return false;
    });

    if (droppedStudentIds.size === 0 && droppedGroupIds.size === 0) {
        return { snapshot, tombstones };
    }

    const deletedAt = new Date().toISOString();
    const nextTombstones: RosterTombstones = {
        students: { ...tombstones.students },
        groups: { ...tombstones.groups },
    };
    for (const id of droppedStudentIds) nextTombstones.students[id] ||= deletedAt;
    for (const id of droppedGroupIds) nextTombstones.groups[id] ||= deletedAt;
    return { snapshot: { ...snapshot, students, groups }, tombstones: nextTombstones };
}

/**
 * @deprecated Teacher UI must use teacherRosterClient. This local-only helper remains
 * for offline utilities and tests, and never opens a browser Supabase connection.
 */
export async function loadRosterSnapshot(
    storage: Pick<Storage, "getItem" | "setItem">,
): Promise<RosterLoadResult> {
    const localSnapshot = {
        students: parseStoredRosterStudents(storage.getItem(ROSTER_STORAGE_KEYS.students)),
        groups: parseStoredRosterGroups(storage.getItem(ROSTER_STORAGE_KEYS.groups)),
        invites: parseStoredRosterInvites(storage.getItem(ROSTER_STORAGE_KEYS.invites)),
    };

    return { ...localSnapshot, remoteLoaded: false };
}

/** @deprecated Teacher UI must use teacherRosterClient. */
export async function saveRosterSnapshot(
    storage: Pick<Storage, "getItem" | "setItem">,
    snapshot: RosterSnapshot,
): Promise<RosterPersistenceResult> {
    const previousSnapshot = readLocalRosterSnapshot(storage);
    const tombstones = nextRosterTombstones(
        previousSnapshot,
        snapshot,
        readRosterTombstones(storage),
    );
    const localSaved = writeLocalRosterSnapshot(storage, snapshot);
    writeRosterTombstones(storage, tombstones);
    return { localSaved, remoteSaved: false };
}
