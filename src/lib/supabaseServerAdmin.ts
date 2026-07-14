import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { workspaceBootstrapRows, type WorkspaceContext } from "@/lib/workspaceContext";

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

    const organizationResult = await client.from("omr_organizations").upsert(rows.organization);
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

function cleanScope(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

/**
 * Read a single exam by id. When `organizationId` is supplied the query is also
 * scoped to that organization, so a roster-verified student in org A can never
 * read org B's exam by guessing/replaying its id (cross-org isolation). Public-
 * link guests pass no org and are gated downstream by evaluateExamAccess.
 */
export async function fetchExamRowById(
    client: SupabaseAdminReadClientLike,
    examId: string,
    options: { organizationId?: string } = {},
): Promise<unknown | null> {
    const org = cleanScope(options.organizationId);
    let query = client.from("omr_exams").select("*").eq("id", examId);
    if (org) query = query.eq("organization_id", org);
    const { data, error } = await query.maybeSingle();
    if (error) throw new Error(error.message || "Failed to read exam");
    return data ?? null;
}

/**
 * Read a student's own attempts. Scoped by student_id AND — when present —
 * organization_id. The org filter is what isolates two organizations that both
 * happen to have the same deterministic student_id (e.g. "grp1::김철수"): without
 * it, one org's attempts would leak into the other's dashboard/review. Guest ids
 * are globally-unique UUIDs, so guest reads can safely omit the org filter.
 */
export async function fetchAttemptRowsByOwner(
    client: SupabaseAdminReadClientLike,
    owner: { studentId?: string; organizationId?: string },
): Promise<unknown[]> {
    // Callers pass the canonical student_id (guests are already normalized to "guest:<id>").
    const key = cleanScope(owner.studentId);
    if (!key) return [];
    const org = cleanScope(owner.organizationId);
    let query = client.from("omr_attempts").select("*").eq("student_id", key);
    if (org) query = query.eq("organization_id", org);
    const { data, error } = await query.order("finished_at", { ascending: false });
    if (error) throw new Error(error.message || "Failed to read attempts");
    return data ?? [];
}
