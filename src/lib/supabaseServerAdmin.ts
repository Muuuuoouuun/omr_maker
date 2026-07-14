import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { workspaceBootstrapRows, type WorkspaceContext } from "@/lib/workspaceContext";
import { SUPABASE_ATTEMPT_READ_COLUMNS, SUPABASE_EXAM_READ_COLUMNS } from "@/lib/supabaseReadColumns";
import { normalizePlan } from "@/utils/plans";

type Env = Record<string, string | undefined>;

export interface SupabaseServerConfig {
    url: string;
    serviceRoleKey: string;
}

export interface SupabaseMutationResult {
    error: { message?: string } | null;
}

type SupabaseMutationCall = PromiseLike<SupabaseMutationResult>;

export interface SupabaseAdminReadFilter {
    eq(column: string, value: string): SupabaseAdminReadFilter;
    maybeSingle(): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
    order(column: string, options?: { ascending?: boolean }): PromiseLike<{ data: unknown[] | null; error: { message?: string } | null }>;
}

export interface SupabaseAdminClientLike {
    from(table: string): {
        upsert(row: unknown): SupabaseMutationCall;
        insert?(row: unknown): SupabaseMutationCall;
        select?(columns?: string): { eq(column: string, value: string): SupabaseAdminReadFilter };
    };
}

export interface SupabaseAdminReadClientLike {
    from(table: string): { select(columns?: string): { eq(column: string, value: string): SupabaseAdminReadFilter } };
}

export interface WorkspaceBootstrapResult {
    ok: boolean;
    skipped?: boolean;
    error?: string;
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

export function getSupabaseServerConfigFromEnv(env: Env = process.env): SupabaseServerConfig | null {
    const url = clean(env.SUPABASE_URL) || clean(env.NEXT_PUBLIC_SUPABASE_URL);
    const serviceRoleKey = clean(env.SUPABASE_SERVICE_ROLE_KEY) || clean(env.OMR_SUPABASE_SERVICE_ROLE_KEY);
    if (!url || !serviceRoleKey) return null;
    return { url, serviceRoleKey };
}

export function createSupabaseAdminClient(config: SupabaseServerConfig): SupabaseAdminClientLike {
    return createClient(config.url, config.serviceRoleKey, {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
        },
    }) as unknown as SupabaseAdminClientLike;
}

function errorMessage(error: { message?: string } | null, fallback: string): string {
    return error?.message || fallback;
}

export async function bootstrapWorkspaceWithAdminClient(
    client: SupabaseAdminClientLike,
    context: WorkspaceContext,
    now = new Date().toISOString(),
): Promise<WorkspaceBootstrapResult> {
    const rows = workspaceBootstrapRows(context, now);

    const organizationTable = client.from("omr_organizations");
    let organizationRow = rows.organization;
    // Login bootstrap must never downgrade a paid organization back to the
    // workspace default (`free`). Preserve the server-owned plan when the row
    // already exists; local/browser plan state is intentionally irrelevant.
    if (organizationTable.select) {
        const existing = await organizationTable.select("plan").eq("id", rows.organization.id).maybeSingle();
        if (!existing.error && existing.data) {
            const existingPlan = normalizePlan((existing.data as { plan?: unknown }).plan);
            if (existingPlan) organizationRow = { ...organizationRow, plan: existingPlan };
        }
    }
    const organizationResult = await organizationTable.upsert(organizationRow);
    if (organizationResult.error) {
        return { ok: false, error: errorMessage(organizationResult.error, "Failed to bootstrap organization") };
    }

    if (rows.userProfile) {
        const userResult = await client.from("omr_user_profiles").upsert(rows.userProfile);
        if (userResult.error) {
            return { ok: false, error: errorMessage(userResult.error, "Failed to bootstrap user profile") };
        }
    }

    if (rows.member) {
        const memberResult = await client.from("omr_organization_members").upsert(rows.member);
        if (memberResult.error) {
            return { ok: false, error: errorMessage(memberResult.error, "Failed to bootstrap organization member") };
        }
    }

    if (rows.teacherProfile) {
        const teacherResult = await client.from("omr_teacher_profiles").upsert(rows.teacherProfile);
        if (teacherResult.error) {
            return { ok: false, error: errorMessage(teacherResult.error, "Failed to bootstrap teacher profile") };
        }
    }

    const auditTable = client.from("omr_audit_logs");
    if (auditTable.insert && context.actorUserId) {
        const auditResult = await auditTable.insert({
            id: `audit_${randomUUID()}`,
            organization_id: context.organizationId,
            actor_user_id: context.actorUserId,
            action: "workspace.bootstrap",
            entity_type: "organization",
            entity_id: context.organizationId,
            metadata: {
                source: "server_action",
                actorLabel: context.actorLabel || null,
            },
            created_at: now,
        });
        if (auditResult.error) {
            return { ok: false, error: errorMessage(auditResult.error, "Failed to write workspace bootstrap audit log") };
        }
    }

    return { ok: true };
}

export async function bootstrapWorkspaceWithServiceRole(
    context: WorkspaceContext,
    env: Env = process.env,
): Promise<WorkspaceBootstrapResult> {
    const config = getSupabaseServerConfigFromEnv(env);
    if (!config) return { ok: false, skipped: true, error: "Supabase service role is not configured" };

    const client = createSupabaseAdminClient(config);
    return bootstrapWorkspaceWithAdminClient(client, context);
}

export async function fetchExamRowById(
    client: SupabaseAdminReadClientLike,
    examId: string,
): Promise<unknown | null> {
    const { data, error } = await client.from("omr_exams").select(SUPABASE_EXAM_READ_COLUMNS).eq("id", examId).maybeSingle();
    if (error) throw new Error(error.message || "Failed to read exam");
    return data ?? null;
}

export async function fetchAttemptRowsByOwner(
    client: SupabaseAdminReadClientLike,
    owner: { studentId?: string },
): Promise<unknown[]> {
    // Callers pass the canonical student_id (guests are already normalized to "guest:<id>").
    const key = owner.studentId || "";
    if (!key) return [];
    const { data, error } = await client.from("omr_attempts").select(SUPABASE_ATTEMPT_READ_COLUMNS).eq("student_id", key).order("finished_at", { ascending: false });
    if (error) throw new Error(error.message || "Failed to read attempts");
    return data ?? [];
}

export async function fetchAttemptRowByOwnerAndId(
    client: SupabaseAdminReadClientLike,
    owner: { studentId?: string },
    attemptId: string,
): Promise<unknown | null> {
    const key = owner.studentId || "";
    if (!key || !attemptId.trim()) return null;
    const { data, error } = await client.from("omr_attempts")
        .select(SUPABASE_ATTEMPT_READ_COLUMNS)
        .eq("id", attemptId)
        .eq("student_id", key)
        .maybeSingle();
    if (error) throw new Error(error.message || "Failed to read attempt");
    return data ?? null;
}

export async function fetchExamRowsByOrganization(
    client: SupabaseAdminReadClientLike,
    organizationId: string,
): Promise<unknown[]> {
    if (!organizationId.trim()) return [];
    const { data, error } = await client.from("omr_exams")
        .select(SUPABASE_EXAM_READ_COLUMNS)
        .eq("organization_id", organizationId)
        .order("created_at", { ascending: false });
    if (error) throw new Error(error.message || "Failed to read organization exams");
    return data ?? [];
}
