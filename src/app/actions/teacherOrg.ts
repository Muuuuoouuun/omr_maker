"use server";

import { cookies } from "next/headers";
import {
    parseSignedTeacherSessionCookie,
    TEACHER_SERVER_SESSION_COOKIE,
} from "@/lib/teacherServerSession";
import {
    workspaceContextFromTeacherSession,
    type WorkspaceContext,
} from "@/lib/workspaceContext";
import {
    createSupabaseAdminClient,
    getSupabaseServerConfigFromEnv,
} from "@/lib/supabaseServerAdmin";
import { resolveTeacherServerMode, type TeacherDataStatus } from "@/lib/teacherServerAccess";
import { fetchOrganizationPlan, type RosterReadClientLike } from "@/lib/teacherServerQueries";
import { normalizePlan } from "@/utils/plans";
import type { PlanKey } from "@/types/omr";

interface TeacherCtx {
    context: WorkspaceContext;
    admin: RosterReadClientLike;
}

type CtxDenied = { status: "unauthenticated" | "degraded_local" | "denied" };

async function resolveTeacherCtx(): Promise<TeacherCtx | CtxDenied> {
    const cookieStore = await cookies();
    const session = parseSignedTeacherSessionCookie(cookieStore.get(TEACHER_SERVER_SESSION_COOKIE)?.value);
    if (!session) return { status: "unauthenticated" };

    const mode = resolveTeacherServerMode();
    if (mode === "denied") return { status: "denied" };
    if (mode === "degraded_local") return { status: "degraded_local" };

    const config = getSupabaseServerConfigFromEnv();
    if (!config) return { status: "degraded_local" };

    return {
        context: workspaceContextFromTeacherSession(session),
        admin: createSupabaseAdminClient(config) as unknown as RosterReadClientLike,
    };
}

function isCtx(value: TeacherCtx | CtxDenied): value is TeacherCtx {
    return "admin" in value;
}

export interface LoadTeacherPlanResult {
    status: TeacherDataStatus;
    plan?: PlanKey;
}

/**
 * Read the teacher's plan from the server source (omr_organizations.plan),
 * scoped to the org bound to the signed session. This is the read-side
 * counterpart of the account plan binding done at login: it makes the plan a
 * server-authoritative value rather than a client localStorage flag. Gating
 * enforcement itself is NOT added here (설계 §3 non-goal) — the client keeps its
 * existing entitlement checks; this only makes the source trustworthy so a later
 * billing milestone can enforce it. An absent org row falls through to the
 * client's local plan (not_found), and unspecified plans normalize to Free.
 */
export async function loadTeacherPlanAction(): Promise<LoadTeacherPlanResult> {
    const ctx = await resolveTeacherCtx();
    if (!isCtx(ctx)) return ctx;
    try {
        const raw = await fetchOrganizationPlan(ctx.admin, ctx.context.organizationId);
        if (raw === null) return { status: "not_found" };
        return { status: "ok", plan: normalizePlan(raw) ?? "free" };
    } catch (e) {
        console.error("loadTeacherPlanAction failed", e);
        return { status: "error" };
    }
}
