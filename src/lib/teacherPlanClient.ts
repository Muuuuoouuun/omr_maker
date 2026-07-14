import type { PlanKey } from "@/types/omr";
import type { TeacherDataStatus } from "@/lib/teacherServerAccess";
import { classifyTeacherServerStatus } from "@/lib/teacherExamClient";
import { getCurrentPlan, setCurrentPlan } from "@/utils/plans";
import { loadTeacherPlanAction } from "@/app/actions/teacherOrg";

/**
 * Client-side wrapper over the teacher plan server action (B4).
 *
 * Reads the authoritative plan from the org (server source of truth). Same
 * server-first policy as B1–B3, but adapted to the plan's synchronous
 * localStorage consumers: on a trusted `ok` the server plan is written back to
 * localStorage (via setCurrentPlan) so the existing synchronous getCurrentPlan()
 * gates read the authoritative value, and the caller gets it directly. Any
 * non-ok status (degraded_local / denied / not_found / error / offline) leaves
 * the current local plan untouched and returns it — the client keeps working
 * offline and the account plan bound at login is never overwritten with a guess.
 */

export type TeacherPlanSource = "server" | "local";

export interface TeacherPlanResult {
    plan: PlanKey;
    source: TeacherPlanSource;
}

export interface LoadTeacherPlanDeps {
    server: () => Promise<{ status: string; plan?: PlanKey }>;
    readLocalPlan: () => PlanKey;
    cachePlan: (plan: PlanKey) => void;
}

export async function loadTeacherPlanWithDeps(deps: LoadTeacherPlanDeps): Promise<TeacherPlanResult> {
    let status = "degraded_local";
    let serverPlan: PlanKey | undefined;
    try {
        const res = await deps.server();
        status = res.status;
        serverPlan = res.plan;
    } catch {
        status = "degraded_local";
    }

    if (classifyTeacherServerStatus(status) === "server" && serverPlan) {
        // Reconcile the local gate with the authoritative server plan.
        deps.cachePlan(serverPlan);
        return { plan: serverPlan, source: "server" };
    }
    // degraded_local / denied / not_found / error: keep the local (login-bound) plan.
    return { plan: deps.readLocalPlan(), source: "local" };
}

/* --------------------------------------------- bound wrapper for screens --- */

export function loadTeacherPlan(): Promise<TeacherPlanResult> {
    return loadTeacherPlanWithDeps({
        server: () => loadTeacherPlanAction() as Promise<{ status: TeacherDataStatus; plan?: PlanKey }>,
        readLocalPlan: () => getCurrentPlan(),
        cachePlan: setCurrentPlan,
    });
}
