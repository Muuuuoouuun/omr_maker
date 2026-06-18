import { afterEach, describe, expect, it, vi } from "vitest";
import type { RosterGroup, RosterInvite, RosterStudent } from "@/lib/rosterStorage";
import {
    applyRosterTombstonesToSnapshot,
    DEFAULT_ROSTER_ORGANIZATION_ID,
    loadRosterSnapshot,
    nextRosterTombstones,
    readLocalRosterSnapshot,
    readRosterTombstones,
    rosterGroupFromSupabaseRow,
    rosterSnapshotToSupabaseRows,
    rosterSnapshotWithStudentGroups,
    rosterStudentFromSupabaseRow,
    saveRosterSnapshot,
    staleRosterRowsForSnapshot,
    writeLocalRosterSnapshot,
    writeRosterTombstones,
    type RosterSnapshot,
    type SupabaseRosterClassRow,
    type SupabaseRosterClassStudentRow,
    type SupabaseRosterStudentProfileRow,
} from "./rosterPersistence";
import { workspaceContextFromIdentity } from "./workspaceContext";

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
});
