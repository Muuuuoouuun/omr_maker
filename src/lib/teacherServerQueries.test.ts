import { describe, expect, it } from "vitest";
import {
    deleteExamCascadeForOrg,
    fetchAttemptOrganizationId,
    fetchAttemptRowByIdForOrg,
    fetchAttemptRowsForOrg,
    fetchExamRowsForOrg,
    saveAttemptRowWithResults,
    saveExamRowWithQuestions,
    type SupabaseAdminDeleteFilter,
    type TeacherAdminClientLike,
} from "./teacherServerQueries";
import type { SupabaseAttemptRow, SupabaseExamQuestionRow, SupabaseExamRow } from "./omrPersistence";

interface Recorded {
    reads: { table: string; filters: [string, string][] }[];
    upserts: { table: string; rows: unknown }[];
    deletes: { table: string; filters: [string, string][] }[];
}

function mockClient(rows: Record<string, Record<string, unknown>[]>, failTable?: string): {
    client: TeacherAdminClientLike;
    log: Recorded;
} {
    const log: Recorded = { reads: [], upserts: [], deletes: [] };
    const client: TeacherAdminClientLike = {
        from(table: string) {
            return {
                select() {
                    const filters: [string, string][] = [];
                    const source = rows[table] || [];
                    const builder = {
                        eq(column: string, value: string) {
                            filters.push([column, value]);
                            return builder;
                        },
                        async maybeSingle() {
                            const match = source.find(row => filters.every(([c, v]) => row[c] === v));
                            return { data: match ?? null, error: null };
                        },
                        async order() {
                            log.reads.push({ table, filters });
                            const data = source.filter(row => filters.every(([c, v]) => row[c] === v));
                            return { data, error: null };
                        },
                    };
                    return builder;
                },
                async upsert(rowsArg: unknown) {
                    log.upserts.push({ table, rows: rowsArg });
                    return { error: table === failTable ? { message: `${table} upsert failed` } : null };
                },
                delete() {
                    const filters: [string, string][] = [];
                    const result = { error: table === failTable ? { message: `${table} delete failed` } : null };
                    const filter = {
                        eq(column: string, value: string) {
                            filters.push([column, value]);
                            return filter;
                        },
                        then<T>(resolve: (value: { error: { message?: string } | null }) => T) {
                            log.deletes.push({ table, filters });
                            return Promise.resolve(result).then(resolve);
                        },
                    };
                    return filter as unknown as SupabaseAdminDeleteFilter;
                },
            };
        },
    };
    return { client, log };
}

const examRow = { id: "e1", organization_id: "org_a", title: "T" } as unknown as SupabaseExamRow;
const questionRow = { id: "e1:1", exam_id: "e1", organization_id: "org_a" } as unknown as SupabaseExamQuestionRow;

describe("teacherServerQueries org scoping", () => {
    it("reads exams scoped to the organization", async () => {
        const { client } = mockClient({
            omr_exams: [
                { id: "e1", organization_id: "org_a", title: "A" },
                { id: "e2", organization_id: "org_b", title: "B" },
            ],
        });
        const rows = await fetchExamRowsForOrg(client, "org_a");
        expect(rows.map(r => r.id)).toEqual(["e1"]);
    });

    it("reads attempts scoped to the organization", async () => {
        const { client } = mockClient({
            omr_attempts: [
                { id: "a1", organization_id: "org_a" },
                { id: "a2", organization_id: "org_b" },
            ],
        });
        const rows = await fetchAttemptRowsForOrg(client, "org_a");
        expect(rows.map(r => r.id)).toEqual(["a1"]);
    });

    it("reads one attempt only within the org scope", async () => {
        const { client } = mockClient({
            omr_attempts: [
                { id: "a1", organization_id: "org_a" },
                { id: "a1", organization_id: "org_b" },
            ],
        });
        expect(await fetchAttemptRowByIdForOrg(client, "org_a", "a1")).toMatchObject({ organization_id: "org_a" });
        expect(await fetchAttemptRowByIdForOrg(client, "org_c", "a1")).toBeNull();
    });

    it("reports the owning org of an attempt for the clobber guard", async () => {
        const { client } = mockClient({
            omr_attempts: [{ id: "a1", organization_id: "org_b" }],
        });
        expect(await fetchAttemptOrganizationId(client, "a1")).toBe("org_b");
        expect(await fetchAttemptOrganizationId(client, "missing")).toBeNull();
    });

    it("saves an exam then replaces its questions within the org scope", async () => {
        const { client, log } = mockClient({});
        await saveExamRowWithQuestions(client, "org_a", examRow, [questionRow]);
        expect(log.upserts.map(u => u.table)).toEqual(["omr_exams", "omr_exam_questions"]);
        // The question-replace delete is org-scoped so it never wipes another org's questions.
        expect(log.deletes).toEqual([
            { table: "omr_exam_questions", filters: [["exam_id", "e1"], ["organization_id", "org_a"]] },
        ]);
    });

    it("skips the question upsert when there are no questions", async () => {
        const { client, log } = mockClient({});
        await saveExamRowWithQuestions(client, "org_a", examRow, []);
        expect(log.upserts.map(u => u.table)).toEqual(["omr_exams"]);
    });

    it("surfaces a write error from the exam upsert", async () => {
        const { client } = mockClient({}, "omr_exams");
        await expect(saveExamRowWithQuestions(client, "org_a", examRow, [questionRow])).rejects.toThrow(/omr_exams upsert failed/);
    });

    it("cascade-deletes an exam scoped to the organization in dependency order", async () => {
        const { client, log } = mockClient({});
        await deleteExamCascadeForOrg(client, "org_a", "e1");
        expect(log.deletes).toEqual([
            { table: "omr_question_results", filters: [["exam_id", "e1"], ["organization_id", "org_a"]] },
            { table: "omr_exam_questions", filters: [["exam_id", "e1"], ["organization_id", "org_a"]] },
            { table: "omr_attempts", filters: [["exam_id", "e1"], ["organization_id", "org_a"]] },
            { table: "omr_exams", filters: [["id", "e1"], ["organization_id", "org_a"]] },
        ]);
    });

    it("saves an attempt then its question results", async () => {
        const { client, log } = mockClient({});
        const attemptRow = { id: "a1", organization_id: "org_a" } as unknown as SupabaseAttemptRow;
        await saveAttemptRowWithResults(client, attemptRow, [{ id: "a1:1" } as unknown as never]);
        expect(log.upserts.map(u => u.table)).toEqual(["omr_attempts", "omr_question_results"]);
    });
});
