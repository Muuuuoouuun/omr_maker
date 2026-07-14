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
import { getSupabaseConfigFromEnv, isSupabaseConfigured, type SupabaseConfig } from "@/lib/omrPersistence";
import {
    DEFAULT_WORKSPACE_ORGANIZATION_ID,
    DEFAULT_WORKSPACE_ORGANIZATION_NAME,
    readActiveWorkspaceContext,
    workspaceBootstrapRows,
    type WorkspaceContext,
} from "@/lib/workspaceContext";

type Env = Record<string, string | undefined>;

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

interface SupabaseQueryResult<T> {
    data: T | null;
    error: { message?: string } | null;
}

type SupabaseClientLike = {
    from(table: string): {
        select(columns?: string): {
            eq(column: string, value: string): Promise<SupabaseQueryResult<unknown[]>>;
        };
        upsert(row: unknown): Promise<SupabaseQueryResult<unknown>>;
    };
};

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

let supabaseClientPromise: Promise<SupabaseClientLike | null> | null = null;

function getSupabaseConfig(env: Env = process.env): SupabaseConfig | null {
    return getSupabaseConfigFromEnv(env);
}

async function getSupabaseClient(): Promise<SupabaseClientLike | null> {
    const config = getSupabaseConfig();
    if (!config) return null;
    if (supabaseClientPromise) return supabaseClientPromise;

    supabaseClientPromise = import("@supabase/supabase-js")
        .then((supabaseModule: unknown) => {
            const { createClient } = supabaseModule as {
                createClient: (url: string, key: string, options: unknown) => SupabaseClientLike;
            };

            return createClient(config.url, config.publishableKey, {
                auth: {
                    persistSession: false,
                    autoRefreshToken: false,
                },
            });
        })
        .catch(error => {
            console.warn("Supabase client unavailable for roster sync", error);
            return null;
        });

    return supabaseClientPromise;
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (error && typeof error === "object" && "message" in error) {
        return String((error as { message?: unknown }).message || "Unknown Supabase error");
    }
    return "Unknown Supabase error";
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

/** Deterministic JSON stringify (object keys sorted) so structurally-equal
 * values compare equal regardless of property insertion order — used to diff
 * a locally-built row against a previously-fetched remote row. */
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

function omitUpdatedAt<T extends object>(row: T): Omit<T, "updated_at"> {
    const rest = { ...row } as T & { updated_at?: unknown };
    delete rest.updated_at;
    return rest as Omit<T, "updated_at">;
}

/** True when `nextRow` carries no observable change over `remoteRow` (ignoring
 * `updated_at`, which is always refreshed to "now" and would otherwise make
 * every row look "changed" on every save). A missing `remoteRow` always counts
 * as changed (it's a new row). */
function rosterRowUnchanged(
    nextRow: object,
    remoteRow: object | undefined,
): boolean {
    if (!remoteRow) return false;
    return deepEqualJson(omitUpdatedAt(nextRow), omitUpdatedAt(remoteRow));
}

function preserveRemoteStudentMetadata(
    nextRow: SupabaseRosterStudentProfileRow,
    remoteRow: SupabaseRosterStudentProfileRow | undefined,
): SupabaseRosterStudentProfileRow {
    if (!remoteRow) return nextRow;
    return {
        ...nextRow,
        metadata: {
            ...metadata(remoteRow.metadata),
            ...metadata(nextRow.metadata),
        },
    };
}

function activeRosterOrganizationId(): string {
    return readActiveWorkspaceContext().organizationId;
}

function activeRosterOrganizationName(organizationId: string): string {
    const context = readActiveWorkspaceContext();
    return context.organizationId === organizationId
        ? context.organizationName
        : DEFAULT_ROSTER_ORGANIZATION_NAME;
}

function workspaceContextForRosterOrganization(organizationId: string): WorkspaceContext {
    const context = readActiveWorkspaceContext();
    if (context.organizationId === organizationId) return context;
    return {
        organizationId,
        organizationName: DEFAULT_ROSTER_ORGANIZATION_NAME,
    };
}

async function upsertRemoteWorkspaceBootstrap(
    client: SupabaseClientLike,
    context: WorkspaceContext,
): Promise<void> {
    const rows = workspaceBootstrapRows(context);
    const organizationResult = await client.from("omr_organizations").upsert(rows.organization);
    if (organizationResult.error) {
        throw new Error(organizationResult.error.message || "Failed to bootstrap roster organization in Supabase");
    }

    if (rows.userProfile) {
        const userResult = await client.from("omr_user_profiles").upsert(rows.userProfile);
        if (userResult.error) {
            throw new Error(userResult.error.message || "Failed to bootstrap roster user profile in Supabase");
        }
    }

    if (rows.member) {
        const memberResult = await client.from("omr_organization_members").upsert(rows.member);
        if (memberResult.error) {
            throw new Error(memberResult.error.message || "Failed to bootstrap roster organization member in Supabase");
        }
    }

    if (rows.teacherProfile) {
        const teacherResult = await client.from("omr_teacher_profiles").upsert(rows.teacherProfile);
        if (teacherResult.error) {
            throw new Error(teacherResult.error.message || "Failed to bootstrap roster teacher profile in Supabase");
        }
    }
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

function mergeById<T extends { id: string }>(localItems: T[], remoteItems: T[]): T[] {
    const items = new Map(remoteItems.map(item => [item.id, item]));
    for (const item of localItems) items.set(item.id, item);
    return Array.from(items.values());
}

function mergeRosterSnapshots(localSnapshot: RosterSnapshot, remoteSnapshot: RosterSnapshot): RosterSnapshot {
    return {
        students: mergeById(localSnapshot.students, remoteSnapshot.students),
        groups: mergeById(localSnapshot.groups, remoteSnapshot.groups),
        invites: localSnapshot.invites,
    };
}

/**
 * mergeRosterSnapshots is local-wins-by-presence: any id still present in the
 * snapshot passed as `snapshot` survives, regardless of what remote says.
 * That is correct when this device intentionally edited a row, but it means a
 * row another device deleted (remote status "withdrawn"/"archived") gets
 * silently resurrected the moment this device's stale local cache is merged
 * back in — even without this device touching that row at all (e.g. just
 * opening the roster page, or saving an unrelated edit).
 *
 * This reconciles that: for every id this device's snapshot still carries
 * that remote now reports as withdrawn/archived, compare the row against
 * `previousSnapshot` (this device's own last-synced baseline, e.g. what
 * `loadRosterSnapshot`/`saveRosterSnapshot` last wrote to local storage):
 *   - Unchanged since last sync (no local edit) -> this is just a stale
 *     cached copy. Respect the remote deletion: drop it and adopt a local
 *     tombstone so this device stops re-offering it on every future save.
 *   - Changed since last sync (genuine edit-vs-delete race) -> keep the
 *     local edit. Silently discarding a teacher's edit is worse than
 *     resurrecting a row someone else just deleted; the teacher can delete
 *     it again if that was truly intended.
 *
 * For loadRosterSnapshot (no separate edit-intent input), callers pass the
 * same snapshot as both `snapshot` and `previousSnapshot` so every remotely
 * -withdrawn row is treated as unchanged and the deletion always wins.
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
        const editedSinceSync = !priorLocal || !deepEqualJson(priorLocal, student);
        if (editedSinceSync) return true;
        droppedStudentIds.add(student.id);
        return false;
    });

    const groups = snapshot.groups.filter(group => {
        if (!archivedGroupIds.has(group.id)) return true;
        const priorLocal = previousGroupsById.get(group.id);
        const editedSinceSync = !priorLocal || !deepEqualJson(priorLocal, group);
        if (editedSinceSync) return true;
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
    for (const id of droppedStudentIds) nextTombstones.students[id] = nextTombstones.students[id] || deletedAt;
    for (const id of droppedGroupIds) nextTombstones.groups[id] = nextTombstones.groups[id] || deletedAt;

    return { snapshot: { ...snapshot, students, groups }, tombstones: nextTombstones };
}

function rosterSnapshotFromRemoteRows(rows: SupabaseRemoteRosterRows): RosterSnapshot {
    const groups = rows.classes
        .map((row, index) => rosterGroupFromSupabaseRow(row, index))
        .filter((group): group is RosterGroup => !!group)
        .sort((a, b) => `${a.region || ""}:${a.name}`.localeCompare(`${b.region || ""}:${b.name}`, "ko"));
    const enrollmentByStudentId = new Map<string, SupabaseRosterClassStudentRow>();
    for (const row of rows.enrollments) {
        const current = enrollmentByStudentId.get(row.student_profile_id);
        if (!current || row.enrollment_status === "active") {
            enrollmentByStudentId.set(row.student_profile_id, row);
        }
    }
    const students = rows.students
        .map((row, index) => rosterStudentFromSupabaseRow(row, groups, enrollmentByStudentId.get(row.id), index))
        .filter((student): student is RosterStudent => !!student)
        .sort((a, b) => a.name.localeCompare(b.name, "ko"));

    return { students, groups, invites: [] };
}

async function fetchRemoteRosterRows(
    client: SupabaseClientLike,
    organizationId = activeRosterOrganizationId(),
): Promise<SupabaseRemoteRosterRows> {
    const [classResult, studentResult, enrollmentResult] = await Promise.all([
        client.from("omr_classes").select("*").eq("organization_id", organizationId),
        client.from("omr_student_profiles").select("*").eq("organization_id", organizationId),
        client.from("omr_class_students").select("*").eq("organization_id", organizationId),
    ]);

    if (classResult.error) throw new Error(classResult.error.message || "Failed to load roster classes from Supabase");
    if (studentResult.error) throw new Error(studentResult.error.message || "Failed to load roster students from Supabase");
    if (enrollmentResult.error) throw new Error(enrollmentResult.error.message || "Failed to load roster enrollments from Supabase");

    return {
        classes: (classResult.data || []).map(row => row as SupabaseRosterClassRow),
        students: (studentResult.data || []).map(row => row as SupabaseRosterStudentProfileRow),
        enrollments: (enrollmentResult.data || []).map(row => row as SupabaseRosterClassStudentRow),
    };
}

async function upsertRemoteRosterSnapshot(
    snapshot: RosterSnapshot,
    organizationId = activeRosterOrganizationId(),
    // Callers that already fetched remote rows for the pre-save merge (see
    // saveRosterSnapshot/loadRosterSnapshot) pass them through instead of
    // triggering a second round-trip — that halves the query count per save
    // and, more importantly, narrows the window between "read remote" and
    // "write remote" in which a concurrent save from another device/tab could
    // be clobbered.
    remoteRows?: SupabaseRemoteRosterRows,
): Promise<void> {
    const client = await getSupabaseClient();
    if (!client && isSupabaseConfigured()) throw new Error("Supabase client unavailable");
    if (!client) return;

    const workspaceContext = workspaceContextForRosterOrganization(organizationId);
    const remote = remoteRows ?? await fetchRemoteRosterRows(client, organizationId);
    const rows = rosterSnapshotToSupabaseRows(
        snapshot,
        organizationId,
        undefined,
        workspaceContext.organizationName || activeRosterOrganizationName(organizationId),
    );
    const staleRows = staleRosterRowsForSnapshot(snapshot, remote, organizationId);
    await upsertRemoteWorkspaceBootstrap(client, workspaceContext);

    // Only push rows whose content actually differs from what we just read
    // from remote (ignoring updated_at). staleRows are always a real status
    // change (archived/withdrawn/inactive), so they don't need this filter —
    // only the "still active" rows built fresh from `snapshot` do, since most
    // of a full roster snapshot is typically unchanged between saves. Writing
    // fewer rows means fewer rows this save could stomp if another device's
    // write to one of those same ids landed in the gap between our read and
    // our write.
    const remoteClassesById = new Map(remote.classes.map(row => [row.id, row]));
    const remoteStudentsById = new Map(remote.students.map(row => [row.id, row]));
    const remoteEnrollmentsById = new Map(remote.enrollments.map(row => [enrollmentKey(row), row]));

    const changedClassRows = rows.classes.filter(row => !rosterRowUnchanged(row, remoteClassesById.get(row.id)));
    const mergedStudentRows = rows.students.map(row => preserveRemoteStudentMetadata(row, remoteStudentsById.get(row.id)));
    const changedStudentRows = mergedStudentRows.filter(row => !rosterRowUnchanged(row, remoteStudentsById.get(row.id)));
    const changedEnrollmentRows = rows.enrollments.filter(
        row => !rosterRowUnchanged(row, remoteEnrollmentsById.get(enrollmentKey(row))),
    );

    const classRows = [...changedClassRows, ...staleRows.classes];
    if (classRows.length > 0) {
        const classResult = await client.from("omr_classes").upsert(classRows);
        if (classResult.error) throw new Error(classResult.error.message || "Failed to save roster classes to Supabase");
    }

    const studentRows = [...changedStudentRows, ...staleRows.students];
    if (studentRows.length > 0) {
        const studentResult = await client.from("omr_student_profiles").upsert(studentRows);
        if (studentResult.error) throw new Error(studentResult.error.message || "Failed to save roster students to Supabase");
    }

    const enrollmentRows = [...changedEnrollmentRows, ...staleRows.enrollments];
    if (enrollmentRows.length > 0) {
        const enrollmentResult = await client.from("omr_class_students").upsert(enrollmentRows);
        if (enrollmentResult.error) throw new Error(enrollmentResult.error.message || "Failed to save roster enrollments to Supabase");
    }
}

export async function loadRosterSnapshot(
    storage: Pick<Storage, "getItem" | "setItem">,
): Promise<RosterLoadResult> {
    const localSnapshot = {
        students: parseStoredRosterStudents(storage.getItem(ROSTER_STORAGE_KEYS.students)),
        groups: parseStoredRosterGroups(storage.getItem(ROSTER_STORAGE_KEYS.groups)),
        invites: parseStoredRosterInvites(storage.getItem(ROSTER_STORAGE_KEYS.invites)),
    };

    if (!isSupabaseConfigured()) {
        return { ...localSnapshot, remoteLoaded: false };
    }

    try {
        const organizationId = activeRosterOrganizationId();
        const client = await getSupabaseClient();
        if (!client) throw new Error("Supabase client unavailable");
        const remoteRows = await fetchRemoteRosterRows(client, organizationId);

        // A plain load carries no local edit intent — there is only one
        // snapshot, not a "before" and "after" — so any row this device still
        // has cached that another device has since deleted remotely should
        // never be resurrected just by opening the page. Passing localSnapshot
        // as both arguments makes reconcileRemoteDeletions treat every row as
        // unedited, so a remote withdrawal/archive always wins here.
        const tombstones = readRosterTombstones(storage);
        const reconciled = reconcileRemoteDeletions(localSnapshot, localSnapshot, remoteRows, tombstones);
        if (reconciled.tombstones !== tombstones) writeRosterTombstones(storage, reconciled.tombstones);

        const remoteSnapshot = applyRosterTombstonesToSnapshot(
            rosterSnapshotFromRemoteRows(remoteRows),
            reconciled.tombstones,
        );
        const merged = mergeRosterSnapshots(reconciled.snapshot, remoteSnapshot);
        writeLocalRosterSnapshot(storage, merged);
        await upsertRemoteRosterSnapshot(merged, organizationId, remoteRows);
        return {
            ...merged,
            remoteLoaded: true,
            remoteSynced: true,
            pendingSyncCount: 0,
        };
    } catch (error) {
        return {
            ...localSnapshot,
            remoteLoaded: false,
            remoteSynced: false,
            pendingSyncCount: localSnapshot.students.length + localSnapshot.groups.length,
            remoteError: errorMessage(error),
        };
    }
}

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
    if (!isSupabaseConfigured()) return { localSaved, remoteSaved: false };

    try {
        // Pushing this device's in-memory snapshot straight to Supabase would
        // be last-writer-wins: any row added/edited on another device or tab
        // since this one last loaded would be silently dropped. Fetch the
        // current remote state once (reused below both for the merge and for
        // the upsert diff, instead of two independent round-trips) and merge
        // it with the local snapshot (local wins on conflicting ids) before
        // upserting, so concurrent changes are preserved. Tombstones are
        // applied to the remote read so an intentional local deletion isn't
        // resurrected by a stale remote row.
        const organizationId = activeRosterOrganizationId();
        const client = await getSupabaseClient();
        if (!client) throw new Error("Supabase client unavailable");
        const remoteRows = await fetchRemoteRosterRows(client, organizationId);

        // Another device/tab may have deleted a row this device still has
        // cached locally. If this device did not edit that row since its own
        // last sync, respect the remote deletion instead of resurrecting it
        // purely because a stale local copy still lists it. If this device DID
        // edit the row, keep the edit — see reconcileRemoteDeletions.
        const reconciled = reconcileRemoteDeletions(snapshot, previousSnapshot, remoteRows, tombstones);
        if (reconciled.tombstones !== tombstones) writeRosterTombstones(storage, reconciled.tombstones);

        const remoteSnapshot = applyRosterTombstonesToSnapshot(
            rosterSnapshotFromRemoteRows(remoteRows),
            reconciled.tombstones,
        );
        const merged = mergeRosterSnapshots(reconciled.snapshot, remoteSnapshot);
        writeLocalRosterSnapshot(storage, merged);
        await upsertRemoteRosterSnapshot(merged, organizationId, remoteRows);
        return { localSaved, remoteSaved: true };
    } catch (error) {
        return { localSaved, remoteSaved: false, remoteError: errorMessage(error) };
    }
}
