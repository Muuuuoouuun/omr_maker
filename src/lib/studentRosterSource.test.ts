import { describe, expect, it } from "vitest";
import { loadStudentRosterSnapshot } from "./studentRosterSource";
import type { SupabaseAdminReadClientLike } from "./supabaseServerAdmin";

function mockClient(tables: Record<string, Record<string, unknown>[]>): SupabaseAdminReadClientLike {
    return {
        from(table: string) {
            const rows = tables[table] || [];
            return {
                select() {
                    return {
                        eq(column: string, value: string) {
                            const filtered = rows.filter(row => row[column] === value);
                            return {
                                eq(c2: string, v2: string) {
                                    const f2 = filtered.filter(row => row[c2] === v2);
                                    return { eq() { throw new Error("unused"); }, async maybeSingle() { return { data: f2[0] ?? null, error: null }; }, async order() { return { data: f2, error: null }; } };
                                },
                                async maybeSingle() { return { data: filtered[0] ?? null, error: null }; },
                                async order() { return { data: filtered, error: null }; },
                            };
                        },
                    };
                },
            };
        },
    };
}

describe("loadStudentRosterSnapshot", () => {
    it("assembles groups, students, start codes and roster-match scoped to the org", async () => {
        const client = mockClient({
            omr_classes: [{ id: "c1", organization_id: "org_a", name: "1반", campus: "서울" }],
            omr_student_profiles: [
                { id: "sp_1", organization_id: "org_a", display_name: "김철수", email: "k@x.com", metadata: { startCode: "abc234" } },
                { id: "sp_2", organization_id: "org_a", display_name: "이영희", metadata: {} },
            ],
            omr_class_students: [
                { class_id: "c1", organization_id: "org_a", student_profile_id: "sp_1" },
            ],
        });

        const snapshot = await loadStudentRosterSnapshot(client, "org_a");
        expect(snapshot.organizationId).toBe("org_a");
        expect(snapshot.requireRosterMatch).toBe(true);
        expect(snapshot.groups).toEqual([{ id: "c1", name: "1반", region: "서울" }]);
        expect(snapshot.students).toContainEqual({ id: "sp_1", name: "김철수", group: "1반", region: "서울", email: "k@x.com" });
        expect(snapshot.startCodes).toEqual({ sp_1: "ABC234" });   // normalized to upper case
    });

    it("does not require a roster match when the org has no provisioned students", async () => {
        const client = mockClient({ omr_classes: [], omr_student_profiles: [], omr_class_students: [] });
        const snapshot = await loadStudentRosterSnapshot(client, "org_empty");
        expect(snapshot.requireRosterMatch).toBe(false);
        expect(snapshot.students).toEqual([]);
    });
});
