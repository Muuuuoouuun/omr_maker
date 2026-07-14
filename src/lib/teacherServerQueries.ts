import type { SupabaseAdminReadFilter } from "@/lib/supabaseServerAdmin";
import type {
    SupabaseAttemptRow,
    SupabaseExamQuestionRow,
    SupabaseExamRow,
    SupabaseQuestionResultRow,
} from "@/lib/omrPersistence";

/**
 * Org-scoped teacher query helpers for the service-role server client.
 *
 * Every read and write here is bound to a single `organizationId`, so once
 * production RLS is enabled no teacher query can reach another organization's
 * rows (설계 §5.3 데이터 소유권). These are the write-side counterparts to the
 * read helpers in `supabaseServerAdmin.ts`, kept in their own module so the
 * teacher server actions do not have to re-declare a write-capable client type.
 */

export interface SupabaseAdminMutationResult {
    error: { message?: string } | null;
}

export interface SupabaseAdminDeleteFilter extends PromiseLike<SupabaseAdminMutationResult> {
    eq(column: string, value: string): SupabaseAdminDeleteFilter;
}

export interface TeacherAdminClientLike {
    from(table: string): {
        select(columns?: string): { eq(column: string, value: string): SupabaseAdminReadFilter };
        upsert(rows: unknown): PromiseLike<SupabaseAdminMutationResult>;
        delete(): SupabaseAdminDeleteFilter;
    };
}

function fail(error: { message?: string } | null, fallback: string): void {
    if (error) throw new Error(error.message || fallback);
}

/* ------------------------------------------------------------------ exams -- */

export async function fetchExamRowsForOrg(
    client: TeacherAdminClientLike,
    organizationId: string,
): Promise<SupabaseExamRow[]> {
    const { data, error } = await client
        .from("omr_exams")
        .select("*")
        .eq("organization_id", organizationId)
        .order("updated_at", { ascending: false });
    fail(error, "Failed to read exams");
    return (data ?? []) as SupabaseExamRow[];
}

export async function saveExamRowWithQuestions(
    client: TeacherAdminClientLike,
    organizationId: string,
    examRow: SupabaseExamRow,
    questionRows: SupabaseExamQuestionRow[],
): Promise<void> {
    const examResult = await client.from("omr_exams").upsert(examRow);
    fail(examResult.error, "Failed to save exam");

    const deleteResult = await client
        .from("omr_exam_questions")
        .delete()
        .eq("exam_id", examRow.id)
        .eq("organization_id", organizationId);
    fail(deleteResult.error, "Failed to replace exam questions");

    if (questionRows.length > 0) {
        const upsertResult = await client.from("omr_exam_questions").upsert(questionRows);
        fail(upsertResult.error, "Failed to save exam questions");
    }
}

/**
 * Cascade-delete an exam and everything hanging off it, scoped to the teacher's
 * organization so a crafted id can never delete another org's rows.
 */
export async function deleteExamCascadeForOrg(
    client: TeacherAdminClientLike,
    organizationId: string,
    examId: string,
): Promise<void> {
    const questionResults = await client
        .from("omr_question_results")
        .delete()
        .eq("exam_id", examId)
        .eq("organization_id", organizationId);
    fail(questionResults.error, "Failed to delete exam question results");

    const examQuestions = await client
        .from("omr_exam_questions")
        .delete()
        .eq("exam_id", examId)
        .eq("organization_id", organizationId);
    fail(examQuestions.error, "Failed to delete exam questions");

    const attempts = await client
        .from("omr_attempts")
        .delete()
        .eq("exam_id", examId)
        .eq("organization_id", organizationId);
    fail(attempts.error, "Failed to delete exam attempts");

    const exams = await client
        .from("omr_exams")
        .delete()
        .eq("id", examId)
        .eq("organization_id", organizationId);
    fail(exams.error, "Failed to delete exam");
}

/* --------------------------------------------------------------- attempts -- */

export async function fetchAttemptRowsForOrg(
    client: TeacherAdminClientLike,
    organizationId: string,
): Promise<SupabaseAttemptRow[]> {
    const { data, error } = await client
        .from("omr_attempts")
        .select("*")
        .eq("organization_id", organizationId)
        .order("finished_at", { ascending: false });
    fail(error, "Failed to read attempts");
    return (data ?? []) as SupabaseAttemptRow[];
}

export async function fetchAttemptRowByIdForOrg(
    client: TeacherAdminClientLike,
    organizationId: string,
    attemptId: string,
): Promise<SupabaseAttemptRow | null> {
    const { data, error } = await client
        .from("omr_attempts")
        .select("*")
        .eq("id", attemptId)
        .eq("organization_id", organizationId)
        .maybeSingle();
    fail(error, "Failed to read attempt");
    return (data ?? null) as SupabaseAttemptRow | null;
}

/**
 * Read only the organization_id of an attempt by id, ignoring org scope. Used
 * as a cross-tenant clobber guard before a teacher upsert: an id that already
 * belongs to another organization must never be overwritten (upsert is keyed by
 * id, so without this a crafted id could hijack another org's row).
 */
export async function fetchAttemptOrganizationId(
    client: TeacherAdminClientLike,
    attemptId: string,
): Promise<string | null> {
    const { data, error } = await client
        .from("omr_attempts")
        .select("organization_id")
        .eq("id", attemptId)
        .maybeSingle();
    fail(error, "Failed to read attempt owner");
    const org = (data as { organization_id?: string | null } | null)?.organization_id;
    return typeof org === "string" && org.trim() ? org.trim() : null;
}

export async function saveAttemptRowWithResults(
    client: TeacherAdminClientLike,
    attemptRow: SupabaseAttemptRow,
    questionResultRows: SupabaseQuestionResultRow[],
): Promise<void> {
    const attemptResult = await client.from("omr_attempts").upsert(attemptRow);
    fail(attemptResult.error, "Failed to save attempt");

    if (questionResultRows.length > 0) {
        const resultsResult = await client.from("omr_question_results").upsert(questionResultRows);
        fail(resultsResult.error, "Failed to save attempt question results");
    }
}
