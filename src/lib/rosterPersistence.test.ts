import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RosterGroup, RosterInvite, RosterStudent } from "@/lib/rosterStorage";
import {
    applyRosterTombstonesToSnapshot,
    DEFAULT_ROSTER_ORGANIZATION_ID,
    loadRosterSnapshot,
    nextRosterTombstones,
    readLocalRosterSnapshot,
    readRosterTombstones,
    reconcileRemoteDeletions,
    rosterGroupFromSupabaseRow,
    rosterSnapshotToSupabaseRows,
    rosterSnapshotWithStudentGroups,
    rosterStudentFromSupabaseRow,
    saveRosterSnapshot,
    staleRosterRowsForSnapshot,
    writeLocalRosterSnapshot,
    writeRosterTombstones,
    type RosterSnapshot,
    type SupabaseRemoteRosterRows,
    type SupabaseRosterClassRow,
    type SupabaseRosterClassStudentRow,
    type SupabaseRosterStudentProfileRow,
} from "./rosterPersistence";
import { workspaceContextFromIdentity } from "./workspaceContext";

// In-memory fake for the Supabase tables saveRosterSnapshot/loadRosterSnapshot
// touch. Reads are served fresh from `remoteTables` on every call (mutable
// between tests), and every upsert is recorded so the merge test below can
// assert on exactly what got pushed back to the "server".
const remoteTables: Record<string, Array<Record<string, unknown>>> = {
    omr_organizations: [],
    omr_classes: [],
    omr_student_profiles: [],
    omr_class_students: [],
};
const recordedUpserts: Array<{ table: string; rows: Array<Record<string, unknown>> }> = [];

// Primary keys used to make the fake `upsert()` below actually persist into
// `remoteTables` (matching real Supabase upsert-by-primary-key semantics)
// instead of only recording the call. This lets multi-step tests simulate a
// second device reading the state a first device just wrote (e.g. "device A
// deletes X, then device B independently edits X").
const TABLE_PRIMARY_KEYS: Record<string, string[]> = {
    omr_organizations: ["id"],
    omr_user_profiles: ["user_id"],
    omr_organization_members: ["organization_id", "user_id"],
    omr_teacher_profiles: ["organization_id", "user_id"],
    omr_classes: ["id"],
    omr_student_profiles: ["id"],
    omr_class_students: ["class_id", "student_profile_id"],
};

function rowKey(table: string, row: Record<string, unknown>): string {
    const keys = TABLE_PRIMARY_KEYS[table] || ["id"];
    return keys.map(key => String(row[key])).join("::");
}

vi.mock("@supabase/supabase-js", () => ({
    createClient: () => ({
        from(table: string) {
            return {
                select() {
                    return {
                        eq(column: string, value: string) {
                            const rows = (remoteTables[table] || []).filter(row => row[column] === value);
                            return Promise.resolve({ data: rows, error: null });
                        },
                    };
                },
                upsert(row: unknown) {
                    const rows = Array.isArray(row) ? row as Array<Record<string, unknown>> : [row as Record<string, unknown>];
                    recordedUpserts.push({ table, rows });
                    const existing = remoteTables[table] || (remoteTables[table] = []);
                    for (const nextRow of rows) {
                        const key = rowKey(table, nextRow);
                        const index = existing.findIndex(current => rowKey(table, current) === key);
                        if (index >= 0) existing[index] = { ...existing[index], ...nextRow };
                        else existing.push(nextRow);
                    }
                    return Promise.resolve({ data: row, error: null });
                },
            };
        },
    }),
}));

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

const groups: RosterGroup[] = [
    { id: "seoul-a", name: "A반", region: "서울", count: 1, avgScore: 80, color: "#4f46e5" },
    { id: "busan-a", name: "A반", region: "부산", count: 1, avgScore: 70, color: "#10b981" },
];

const students: RosterStudent[] = [
    {
        id: "seoul-a::김학생",
        name: "김학생",
        email: "kim.seoul@example.com",
        group: "A반",
        region: "서울",
        avatar: "#4f46e5",
        avgScore: 82,
        examsTaken: 4,
        lastActive: "오늘",
        trend: "up",
        status: "active",
    },
    {
        id: "busan-a::김학생",
        name: "김학생",
        email: "kim.busan@example.com",
        group: "A반",
        region: "부산",
        avatar: "#10b981",
        avgScore: 71,
        examsTaken: 2,
        lastActive: "어제",
        trend: "flat",
        status: "idle",
    },
];

const invites: RosterInvite[] = [
    { id: "invite-1", email: "parent@example.com", sentAt: "오늘", status: "pending" },
];

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("roster persistence", () => {
    it("maps roster snapshots to Supabase organization, class, student, and enrollment rows", () => {
        const rows = rosterSnapshotToSupabaseRows({ students, groups, invites }, "academy-1", "2026-06-16T00:00:00.000Z");

        expect(rows.organization).toEqual({
            id: "academy-1",
            name: "OMR Maker",
            plan: "free",
            metadata: { source: "omr_maker_roster" },
        });
        expect(rows.classes).toEqual([
            expect.objectContaining({
                id: "seoul-a",
                organization_id: "academy-1",
                name: "A반",
                campus: "서울",
                status: "active",
                updated_at: "2026-06-16T00:00:00.000Z",
            }),
            expect.objectContaining({
                id: "busan-a",
                campus: "부산",
            }),
        ]);
        expect(rows.students).toEqual([
            expect.objectContaining({
                id: "seoul-a::김학생",
                organization_id: "academy-1",
                display_name: "김학생",
                email: "kim.seoul@example.com",
                status: "active",
            }),
            expect.objectContaining({
                id: "busan-a::김학생",
                organization_id: "academy-1",
                display_name: "김학생",
                email: "kim.busan@example.com",
                status: "inactive",
            }),
        ]);
        expect(rows.students[0].metadata).toMatchObject({
            group: "A반",
            region: "서울",
            avgScore: 82,
            trend: "up",
        });
        expect(rows.enrollments).toEqual([
            {
                class_id: "seoul-a",
                organization_id: "academy-1",
                student_profile_id: "seoul-a::김학생",
                enrollment_status: "active",
            },
            {
                class_id: "busan-a",
                organization_id: "academy-1",
                student_profile_id: "busan-a::김학생",
                enrollment_status: "inactive",
            },
        ]);
    });

    it("can map roster snapshots into a teacher-scoped organization", () => {
        const context = workspaceContextFromIdentity({
            teacherId: "teacher-a",
            displayName: "Teacher A",
        });
        const rows = rosterSnapshotToSupabaseRows(
            { students: [students[0]], groups: [groups[0]], invites: [] },
            context.organizationId,
            "2026-06-16T00:00:00.000Z",
            context.organizationName,
        );

        expect(rows.organization).toMatchObject({
            id: context.organizationId,
            name: "Teacher A Workspace",
        });
        expect(rows.classes[0].organization_id).toBe(context.organizationId);
        expect(rows.students[0].organization_id).toBe(context.organizationId);
        expect(rows.enrollments[0].organization_id).toBe(context.organizationId);
    });

    it("adds missing student groups before remote enrollment rows are generated", () => {
        const snapshot = rosterSnapshotWithStudentGroups({
            students: [students[0]],
            groups: [],
            invites: [],
        });

        expect(snapshot.groups).toEqual([
            expect.objectContaining({
                id: "group:서울::a반",
                name: "A반",
                region: "서울",
            }),
        ]);
        expect(rosterSnapshotToSupabaseRows(snapshot).enrollments[0]).toMatchObject({
            class_id: "group:서울::a반",
            organization_id: DEFAULT_ROSTER_ORGANIZATION_ID,
            student_profile_id: "seoul-a::김학생",
        });
    });

    it("marks remote-only roster rows stale so deleted students and classes do not reappear", () => {
        const remoteRows = {
            classes: [
                ...rosterSnapshotToSupabaseRows({ students, groups, invites }, "academy-1").classes,
                {
                    id: "old-class",
                    organization_id: "academy-1",
                    name: "이전반",
                    campus: "서울",
                    status: "active" as const,
                    metadata: { color: "#ef4444", source: "omr_maker_roster" },
                },
                {
                    id: "other-org-class",
                    organization_id: "other",
                    name: "다른조직",
                    campus: "서울",
                    status: "active" as const,
                    metadata: {},
                },
            ],
            students: [
                ...rosterSnapshotToSupabaseRows({ students, groups, invites }, "academy-1").students,
                {
                    id: "old-class::오래된학생",
                    organization_id: "academy-1",
                    display_name: "오래된학생",
                    external_id: "old-class::오래된학생",
                    email: "old@example.com",
                    status: "active" as const,
                    metadata: { group: "이전반", source: "omr_maker_roster" },
                },
                {
                    id: "already-withdrawn",
                    organization_id: "academy-1",
                    display_name: "졸업생",
                    external_id: "already-withdrawn",
                    email: null,
                    status: "withdrawn" as const,
                    metadata: {},
                },
            ],
            enrollments: [
                ...rosterSnapshotToSupabaseRows({ students, groups, invites }, "academy-1").enrollments,
                {
                    class_id: "old-class",
                    organization_id: "academy-1",
                    student_profile_id: "old-class::오래된학생",
                    enrollment_status: "active" as const,
                },
                {
                    class_id: "old-class",
                    organization_id: "academy-1",
                    student_profile_id: "already-inactive",
                    enrollment_status: "inactive" as const,
                },
            ],
        };

        const staleRows = staleRosterRowsForSnapshot(
            { students: [students[0]], groups: [groups[0]], invites: [] },
            remoteRows,
            "academy-1",
            "2026-06-16T01:00:00.000Z",
        );

        expect(staleRows.classes).toEqual([
            expect.objectContaining({
                id: "busan-a",
                status: "archived",
                updated_at: "2026-06-16T01:00:00.000Z",
            }),
            expect.objectContaining({
                id: "old-class",
                status: "archived",
                metadata: expect.objectContaining({ archivedBySync: true }),
            }),
        ]);
        expect(staleRows.students).toEqual([
            expect.objectContaining({
                id: "busan-a::김학생",
                status: "withdrawn",
                updated_at: "2026-06-16T01:00:00.000Z",
            }),
            expect.objectContaining({
                id: "old-class::오래된학생",
                status: "withdrawn",
                metadata: expect.objectContaining({ withdrawnBySync: true }),
            }),
        ]);
        expect(staleRows.enrollments).toEqual([
            {
                class_id: "old-class",
                organization_id: "academy-1",
                student_profile_id: "old-class::오래된학생",
                enrollment_status: "inactive",
            },
        ]);
    });

    it("keeps old inactive enrollments from overriding a current active class membership", () => {
        const seoulGroup = rosterGroupFromSupabaseRow({
            id: "seoul-a",
            organization_id: "academy-1",
            name: "A반",
            campus: "서울",
            status: "active",
            metadata: {},
        }) as RosterGroup;
        const busanGroup = rosterGroupFromSupabaseRow({
            id: "busan-a",
            organization_id: "academy-1",
            name: "A반",
            campus: "부산",
            status: "active",
            metadata: {},
        }) as RosterGroup;
        const row: SupabaseRosterStudentProfileRow = {
            id: "seoul-a::김학생",
            organization_id: "academy-1",
            display_name: "김학생",
            external_id: "seoul-a::김학생",
            email: "kim@example.com",
            status: "active",
            metadata: {
                group: "A반",
                region: "서울",
            },
        };
        const activeEnrollment: SupabaseRosterClassStudentRow = {
            class_id: "seoul-a",
            organization_id: "academy-1",
            student_profile_id: "seoul-a::김학생",
            enrollment_status: "active",
        };
        const inactiveEnrollment: SupabaseRosterClassStudentRow = {
            class_id: "busan-a",
            organization_id: "academy-1",
            student_profile_id: "seoul-a::김학생",
            enrollment_status: "inactive",
        };

        expect(rosterStudentFromSupabaseRow(row, [seoulGroup, busanGroup], inactiveEnrollment)).toMatchObject({
            group: "A반",
            region: "부산",
        });
        expect(rosterStudentFromSupabaseRow(row, [seoulGroup, busanGroup], activeEnrollment)).toMatchObject({
            group: "A반",
            region: "서울",
        });
    });

    it("round-trips Supabase rows back to roster rows with region and status metadata", () => {
        const classRow: SupabaseRosterClassRow = {
            id: "seoul-a",
            organization_id: "academy-1",
            name: "A반",
            campus: "서울",
            status: "active",
            metadata: {
                color: "#4f46e5",
                count: 12,
                avgScore: 83,
            },
        };
        const studentRow: SupabaseRosterStudentProfileRow = {
            id: "seoul-a::김학생",
            organization_id: "academy-1",
            display_name: "김학생",
            external_id: "seoul-a::김학생",
            email: "kim@example.com",
            status: "active",
            metadata: {
                group: "A반",
                avatar: "#4f46e5",
                avgScore: 91,
                examsTaken: 5,
                lastActive: "방금 전",
                trend: "down",
                status: "idle",
            },
        };
        const group = rosterGroupFromSupabaseRow(classRow);
        const student = rosterStudentFromSupabaseRow(studentRow, [group as RosterGroup], {
            class_id: "seoul-a",
            organization_id: "academy-1",
            student_profile_id: "seoul-a::김학생",
            enrollment_status: "active",
        });

        expect(group).toMatchObject({
            id: "seoul-a",
            name: "A반",
            region: "서울",
            count: 12,
            avgScore: 83,
        });
        expect(student).toMatchObject({
            id: "seoul-a::김학생",
            name: "김학생",
            email: "kim@example.com",
            group: "A반",
            region: "서울",
            avgScore: 91,
            examsTaken: 5,
            trend: "down",
            status: "idle",
        });
    });

    it("reads and writes local roster snapshots as the offline fallback", () => {
        const storage = createStorage();
        const snapshot: RosterSnapshot = { students, groups, invites };

        expect(writeLocalRosterSnapshot(storage, snapshot)).toBe(true);
        expect(readLocalRosterSnapshot(storage)).toEqual(snapshot);
    });

    it("tracks local roster deletions as tombstones so failed remote sync cannot resurrect them", async () => {
        vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
        vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
        const storage = createStorage({
            omr_students: JSON.stringify(students),
            omr_groups: JSON.stringify(groups),
            omr_invites: JSON.stringify(invites),
        });

        const nextSnapshot: RosterSnapshot = {
            students: [students[0]],
            groups: [groups[0]],
            invites: [],
        };
        const result = await saveRosterSnapshot(storage, nextSnapshot);

        expect(result).toEqual({ localSaved: true, remoteSaved: false });
        expect(readRosterTombstones(storage)).toEqual({
            students: { "busan-a::김학생": expect.any(String) },
            groups: { "busan-a": expect.any(String) },
        });
        expect(applyRosterTombstonesToSnapshot(
            { students, groups, invites: [] },
            readRosterTombstones(storage),
        )).toEqual({
            students: [students[0]],
            groups: [groups[0]],
            invites: [],
        });
    });

    it("clears tombstones when the same roster row is intentionally re-added", () => {
        const deletedAt = "2026-06-16T02:00:00.000Z";
        const current = nextRosterTombstones(
            { students, groups, invites: [] },
            { students: [students[0]], groups: [groups[0]], invites: [] },
            { students: {}, groups: {} },
            deletedAt,
        );

        expect(current).toEqual({
            students: { "busan-a::김학생": deletedAt },
            groups: { "busan-a": deletedAt },
        });
        expect(nextRosterTombstones(
            { students: [students[0]], groups: [groups[0]], invites: [] },
            { students, groups, invites: [] },
            current,
            "2026-06-16T03:00:00.000Z",
        )).toEqual({ students: {}, groups: {} });
    });

    it("persists tombstone records separately from the roster snapshot", () => {
        const storage = createStorage();

        expect(writeRosterTombstones(storage, {
            students: { "student-1": "2026-06-16T02:00:00.000Z" },
            groups: { "group-1": "2026-06-16T02:00:00.000Z" },
        })).toBe(true);
        expect(readRosterTombstones(storage)).toEqual({
            students: { "student-1": "2026-06-16T02:00:00.000Z" },
            groups: { "group-1": "2026-06-16T02:00:00.000Z" },
        });
    });

    it("loads and saves locally without trying remote sync when Supabase is not configured", async () => {
        vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
        vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
        const storage = createStorage({
            omr_students: JSON.stringify(students),
            omr_groups: JSON.stringify(groups),
            omr_invites: JSON.stringify(invites),
        });

        await expect(loadRosterSnapshot(storage)).resolves.toMatchObject({
            students,
            groups,
            invites,
            remoteLoaded: false,
        });
        await expect(saveRosterSnapshot(storage, { students, groups, invites })).resolves.toEqual({
            localSaved: true,
            remoteSaved: false,
        });
    });

    it("M3 regression: merges the current remote snapshot into a save instead of overwriting it (last-writer-wins)", async () => {
        vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
        vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "public-anon-key");

        // Seed the "remote" with a student/group this browser tab has never
        // seen locally — as if another device added it after this tab's last
        // sync. reuse the busan fixtures so the round-trip is exercised via
        // the already-tested Supabase row shapes.
        const remoteOnlyRows = rosterSnapshotToSupabaseRows(
            { students: [students[1]], groups: [groups[1]], invites: [] },
            DEFAULT_ROSTER_ORGANIZATION_ID,
            "2026-06-16T00:00:00.000Z",
        );
        remoteTables.omr_classes = remoteOnlyRows.classes as unknown as Array<Record<string, unknown>>;
        remoteTables.omr_student_profiles = remoteOnlyRows.students as unknown as Array<Record<string, unknown>>;
        remoteTables.omr_class_students = remoteOnlyRows.enrollments as unknown as Array<Record<string, unknown>>;
        recordedUpserts.length = 0;

        const storage = createStorage();
        const localOnlySnapshot: RosterSnapshot = { students: [students[0]], groups: [groups[0]], invites: [] };

        const result = await saveRosterSnapshot(storage, localOnlySnapshot);

        expect(result.remoteSaved).toBe(true);

        // The remotely-added student/group must survive the save instead of
        // being clobbered by this tab's narrower local snapshot.
        const savedLocally = readLocalRosterSnapshot(storage);
        expect(savedLocally.students.map(s => s.id).sort()).toEqual(
            [students[0].id, students[1].id].sort(),
        );
        expect(savedLocally.groups.map(g => g.id).sort()).toEqual(
            [groups[0].id, groups[1].id].sort(),
        );

        expect(remoteTables.omr_student_profiles.map(row => row.id)).toEqual(
            expect.arrayContaining([students[0].id, students[1].id]),
        );
    });

    function seedRemoteRosterBaseline(snapshot: RosterSnapshot, updatedAt = "2026-06-16T00:00:00.000Z"): void {
        const rows = rosterSnapshotToSupabaseRows(snapshot, DEFAULT_ROSTER_ORGANIZATION_ID, updatedAt);
        remoteTables.omr_classes = rows.classes as unknown as Array<Record<string, unknown>>;
        remoteTables.omr_student_profiles = rows.students as unknown as Array<Record<string, unknown>>;
        remoteTables.omr_class_students = rows.enrollments as unknown as Array<Record<string, unknown>>;
        recordedUpserts.length = 0;
    }

    describe("concurrent roster edits across devices (T2)", () => {
        beforeEach(() => {
            vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
            vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "public-anon-key");
        });

        it("keeps additions from two devices that each add a different student", async () => {
            const baseline: RosterSnapshot = { students: [students[0]], groups: [groups[0]], invites: [] };
            seedRemoteRosterBaseline(baseline);

            // Device 1 starts from the baseline and adds students[1] (a different group/region).
            const deviceOne = createStorage();
            writeLocalRosterSnapshot(deviceOne, baseline);
            const resultOne = await saveRosterSnapshot(deviceOne, {
                students: [students[0], students[1]],
                groups: [groups[0], groups[1]],
                invites: [],
            });
            expect(resultOne.remoteSaved).toBe(true);

            // Device 2 independently starts from the SAME original baseline
            // (never saw device 1's addition) and adds a third, different student.
            const newStudent: RosterStudent = {
                id: "seoul-a::박학생",
                name: "박학생",
                email: "park@example.com",
                group: "A반",
                region: "서울",
                avatar: "#000000",
                avgScore: 60,
                examsTaken: 1,
                lastActive: "오늘",
                trend: "flat",
                status: "active",
            };
            const deviceTwo = createStorage();
            writeLocalRosterSnapshot(deviceTwo, baseline);
            const resultTwo = await saveRosterSnapshot(deviceTwo, {
                students: [students[0], newStudent],
                groups: [groups[0]],
                invites: [],
            });
            expect(resultTwo.remoteSaved).toBe(true);

            // Both additions must survive — neither device's add should clobber the other's.
            const finalLocal = readLocalRosterSnapshot(deviceTwo);
            expect(finalLocal.students.map(s => s.id).sort()).toEqual(
                [students[0].id, students[1].id, newStudent.id].sort(),
            );
        });

        it("is last-writer-wins at the row level when two devices edit the same student concurrently (documented limitation)", async () => {
            const baseline: RosterSnapshot = { students: [students[0]], groups: [groups[0]], invites: [] };
            seedRemoteRosterBaseline(baseline);

            const deviceA = createStorage();
            writeLocalRosterSnapshot(deviceA, baseline);
            const renamedByA: RosterStudent = { ...students[0], name: "김학생(A)" };
            await saveRosterSnapshot(deviceA, { students: [renamedByA], groups: [groups[0]], invites: [] });

            // Device B started from the same original baseline (before A's save
            // landed) and edits a DIFFERENT field.
            const deviceB = createStorage();
            writeLocalRosterSnapshot(deviceB, baseline);
            const rescoredByB: RosterStudent = { ...students[0], avgScore: 99 };
            const resultB = await saveRosterSnapshot(deviceB, { students: [rescoredByB], groups: [groups[0]], invites: [] });

            expect(resultB.remoteSaved).toBe(true);
            const finalLocal = readLocalRosterSnapshot(deviceB).students.find(s => s.id === students[0].id);
            // B's whole row wins on save: B's own change is present, but A's
            // rename — which never made it into B's local snapshot — is lost.
            // This is expected row-granularity last-writer-wins, not a bug: true
            // field-level conflict resolution needs per-row optimistic
            // concurrency (updated_at column), which is out of scope without a
            // schema change — see the draft migration under supabase/drafts/.
            expect(finalLocal?.avgScore).toBe(99);
            expect(finalLocal?.name).toBe(students[0].name);
        });

        it("keeps a local edit when the same student was deleted remotely by another device (edit-vs-delete race)", async () => {
            const baseline: RosterSnapshot = {
                students: [students[0], students[1]],
                groups: [groups[0], groups[1]],
                invites: [],
            };
            seedRemoteRosterBaseline(baseline);

            // Device A deletes students[1] and saves — this withdraws it remotely.
            const deviceA = createStorage();
            writeLocalRosterSnapshot(deviceA, baseline);
            const resultA = await saveRosterSnapshot(deviceA, {
                students: [students[0]],
                groups: [groups[0], groups[1]],
                invites: [],
            });
            expect(resultA.remoteSaved).toBe(true);
            expect(remoteTables.omr_student_profiles.find(row => row.id === students[1].id)?.status).toBe("withdrawn");

            // Device B, unaware of the deletion, independently EDITS students[1]
            // starting from the same original baseline.
            const deviceB = createStorage();
            writeLocalRosterSnapshot(deviceB, baseline);
            const editedByB: RosterStudent = { ...students[1], avgScore: 95 };
            const resultB = await saveRosterSnapshot(deviceB, {
                students: [students[0], editedByB],
                groups: [groups[0], groups[1]],
                invites: [],
            });

            expect(resultB.remoteSaved).toBe(true);
            // The edit wins: B's change is preserved rather than silently dropped
            // just because another device deleted the row first.
            const finalLocal = readLocalRosterSnapshot(deviceB);
            expect(finalLocal.students.find(s => s.id === students[1].id)?.avgScore).toBe(95);
            // The remote row is revived as a consequence — B never saw the
            // deletion, so from B's perspective it never intentionally deleted it.
            expect(remoteTables.omr_student_profiles.find(row => row.id === students[1].id)?.status).not.toBe("withdrawn");
        });

        it("does NOT resurrect a student deleted by another device when this device made no edit to it (stale cache)", async () => {
            const baseline: RosterSnapshot = {
                students: [students[0], students[1]],
                groups: [groups[0], groups[1]],
                invites: [],
            };
            seedRemoteRosterBaseline(baseline);

            const deviceA = createStorage();
            writeLocalRosterSnapshot(deviceA, baseline);
            await saveRosterSnapshot(deviceA, { students: [students[0]], groups: [groups[0], groups[1]], invites: [] });
            expect(remoteTables.omr_student_profiles.find(row => row.id === students[1].id)?.status).toBe("withdrawn");

            // Device B still has the pre-deletion baseline cached locally and
            // saves an UNRELATED edit, never touching students[1] at all.
            const deviceB = createStorage();
            writeLocalRosterSnapshot(deviceB, baseline);
            const unrelatedEdit: RosterStudent = { ...students[0], avgScore: 77 };
            const resultB = await saveRosterSnapshot(deviceB, {
                students: [unrelatedEdit, students[1]],
                groups: [groups[0], groups[1]],
                invites: [],
            });

            expect(resultB.remoteSaved).toBe(true);
            const finalLocal = readLocalRosterSnapshot(deviceB);
            // students[1] is NOT resurrected: B's copy was identical to its own
            // last-synced baseline, so the remote deletion wins instead.
            expect(finalLocal.students.find(s => s.id === students[1].id)).toBeUndefined();
            expect(remoteTables.omr_student_profiles.find(row => row.id === students[1].id)?.status).toBe("withdrawn");
            // B adopts a local tombstone too, so it stops re-offering the row on future saves.
            expect(readRosterTombstones(deviceB).students[students[1].id]).toEqual(expect.any(String));
            // The unrelated edit to students[0] still went through.
            expect(finalLocal.students.find(s => s.id === students[0].id)?.avgScore).toBe(77);
        });

        it("loadRosterSnapshot does not resurrect a remotely-deleted student purely from a stale local cache", async () => {
            const baseline: RosterSnapshot = {
                students: [students[0], students[1]],
                groups: [groups[0], groups[1]],
                invites: [],
            };
            seedRemoteRosterBaseline(baseline);

            const deviceA = createStorage();
            writeLocalRosterSnapshot(deviceA, baseline);
            await saveRosterSnapshot(deviceA, { students: [students[0]], groups: [groups[0], groups[1]], invites: [] });
            expect(remoteTables.omr_student_profiles.find(row => row.id === students[1].id)?.status).toBe("withdrawn");

            // Device B never edits anything — it just opens the roster page.
            const deviceB = createStorage();
            writeLocalRosterSnapshot(deviceB, baseline);
            const loaded = await loadRosterSnapshot(deviceB);

            expect(loaded.remoteLoaded).toBe(true);
            expect(loaded.students.find(s => s.id === students[1].id)).toBeUndefined();
            expect(remoteTables.omr_student_profiles.find(row => row.id === students[1].id)?.status).toBe("withdrawn");
        });

        it("only upserts roster rows that actually changed vs remote, not the whole snapshot, on a no-op save", async () => {
            const snapshot: RosterSnapshot = { students: [students[0]], groups: [groups[0]], invites: [] };
            seedRemoteRosterBaseline(snapshot);

            const storage = createStorage();
            writeLocalRosterSnapshot(storage, snapshot);
            recordedUpserts.length = 0;

            // Save the IDENTICAL snapshot again (e.g. a no-op autosave tick).
            const result = await saveRosterSnapshot(storage, snapshot);

            expect(result.remoteSaved).toBe(true);
            const rosterUpserts = recordedUpserts.filter(call =>
                call.table === "omr_classes"
                || call.table === "omr_student_profiles"
                || call.table === "omr_class_students");
            expect(rosterUpserts).toEqual([]);
        });

        it("upserts only the row that changed when one student among several is edited", async () => {
            const snapshot: RosterSnapshot = { students, groups, invites: [] };
            seedRemoteRosterBaseline(snapshot);

            const storage = createStorage();
            writeLocalRosterSnapshot(storage, snapshot);
            recordedUpserts.length = 0;

            const edited: RosterStudent = { ...students[0], avgScore: 88 };
            await saveRosterSnapshot(storage, { students: [edited, students[1]], groups, invites: [] });

            const studentUpsert = recordedUpserts.find(call => call.table === "omr_student_profiles");
            expect(studentUpsert?.rows.map(row => row.id)).toEqual([edited.id]);
        });

        it("preserves server-managed student access-code metadata during roster edits", async () => {
            const snapshot: RosterSnapshot = { students: [students[0]], groups: [groups[0]], invites: [] };
            seedRemoteRosterBaseline(snapshot);
            const remoteStudent = remoteTables.omr_student_profiles[0];
            remoteStudent.metadata = {
                ...(remoteStudent.metadata as Record<string, unknown>),
                studentAccessCode: {
                    version: 1,
                    hash: "a".repeat(64),
                    updatedAt: "2026-06-16T01:00:00.000Z",
                },
            };

            const storage = createStorage();
            writeLocalRosterSnapshot(storage, snapshot);
            recordedUpserts.length = 0;

            await saveRosterSnapshot(storage, {
                ...snapshot,
                students: [{ ...students[0], avgScore: 91 }],
            });

            const studentUpsert = recordedUpserts.find(call => call.table === "omr_student_profiles");
            expect(studentUpsert?.rows[0].metadata).toMatchObject({
                avgScore: 91,
                studentAccessCode: {
                    version: 1,
                    hash: "a".repeat(64),
                },
            });
        });
    });

    describe("reconcileRemoteDeletions", () => {
        it("drops a row unchanged since last sync when remote reports it withdrawn/archived, and adopts a tombstone", () => {
            const remoteRows: SupabaseRemoteRosterRows = {
                classes: [{
                    id: groups[1].id,
                    organization_id: DEFAULT_ROSTER_ORGANIZATION_ID,
                    name: groups[1].name,
                    campus: groups[1].region || null,
                    status: "archived",
                    metadata: {},
                }],
                students: [{
                    id: students[1].id,
                    organization_id: DEFAULT_ROSTER_ORGANIZATION_ID,
                    display_name: students[1].name,
                    external_id: students[1].id,
                    email: students[1].email,
                    status: "withdrawn",
                    metadata: {},
                }],
                enrollments: [],
            };
            const baseline: RosterSnapshot = { students, groups, invites: [] };

            const result = reconcileRemoteDeletions(baseline, baseline, remoteRows, { students: {}, groups: {} });

            expect(result.snapshot.students.map(s => s.id)).toEqual([students[0].id]);
            expect(result.snapshot.groups.map(g => g.id)).toEqual([groups[0].id]);
            expect(result.tombstones.students[students[1].id]).toEqual(expect.any(String));
            expect(result.tombstones.groups[groups[1].id]).toEqual(expect.any(String));
        });

        it("keeps a row remote reports withdrawn/archived if it differs from the last-synced baseline (a genuine edit)", () => {
            const remoteRows: SupabaseRemoteRosterRows = {
                classes: [],
                students: [{
                    id: students[1].id,
                    organization_id: DEFAULT_ROSTER_ORGANIZATION_ID,
                    display_name: students[1].name,
                    external_id: students[1].id,
                    email: students[1].email,
                    status: "withdrawn",
                    metadata: {},
                }],
                enrollments: [],
            };
            const previous: RosterSnapshot = { students: [students[1]], groups: [], invites: [] };
            const edited: RosterSnapshot = { students: [{ ...students[1], avgScore: 42 }], groups: [], invites: [] };

            const result = reconcileRemoteDeletions(edited, previous, remoteRows, { students: {}, groups: {} });

            expect(result.snapshot.students).toEqual(edited.students);
            expect(result.tombstones).toEqual({ students: {}, groups: {} });
        });
    });
});
