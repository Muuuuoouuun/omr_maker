import "next/dist/compiled/server-only";

import { parseStudentRemediation } from "@/lib/remediation";
import type { RemediationRetakeBlock, RemediationRetakeResult } from "@/lib/remediationRetake";
import type { StudentServerIdentity } from "@/lib/studentServerSession";
import { listStudentAssignmentsWithGateway } from "@/lib/studentTargetedAssignmentGateway.server";
import { openStudentExamWithGateway, type StudentExamGatewayClient } from "@/lib/studentExamServerGateway";
import { readEffectiveWorkspacePlan } from "@/lib/effectiveWorkspacePlanGateway";
import { hasPlanEntitlement } from "@/utils/plans";
import { buildRetakeHref } from "@/lib/retakeLinks";

const blocked = (code: RemediationRetakeBlock): RemediationRetakeResult => ({ status: "blocked", code });

/** Read-only handoff. A link is not a capability; solve/session entry revalidates everything. */
export async function resolveRemediationRetakeWithGateway(
    admin: StudentExamGatewayClient,
    identity: StudentServerIdentity,
    sourceAttemptId: string,
): Promise<RemediationRetakeResult> {
    if (identity.kind !== "student" || identity.identityType !== "registered"
        || !identity.organizationId || !identity.studentId) return blocked("unauthorized");
    try {
        const response = await admin.rpc("omr_student_remediation_v1", {
            p_org: identity.organizationId, p_student: identity.studentId,
        });
        const cases = response.error ? null : parseStudentRemediation(response.data);
        if (!cases) return blocked("service_unavailable");
        const item = cases.find(candidate => candidate.sourceAttemptId === sourceAttemptId);
        if (!item) return blocked("unavailable");
        if (item.state === "paused" || item.state === "handoff") return blocked(item.state);
        if (item.state === "confirmed") return blocked("completed");
        if (item.state === "awaiting_review") return blocked("review");

        const [listed, plan] = await Promise.all([
            listStudentAssignmentsWithGateway(admin, identity),
            readEffectiveWorkspacePlan(admin, identity.organizationId),
        ]);
        if (listed.status !== "loaded" || !plan.authoritative) return blocked("service_unavailable");
        if (!hasPlanEntitlement(plan.plan, "retakeAssignments")) return blocked("plan_denied");
        const matches = listed.assignments.filter(assignment => assignment.id === item.examId);
        if (matches.length > 1) return blocked("service_unavailable");
        const assignment = matches[0];
        if (!assignment || assignment.access.type !== "targeted" || assignment.assignmentMode !== "retake"
            || !assignment.assignmentId || !assignment.assignmentRevision) return blocked("assignment_required");
        if (assignment.retakeSourceAttemptId !== item.sourceAttemptId) return blocked("different_source");
        if (assignment.lifecycle === "scheduled") return blocked("not_started");
        if (assignment.lifecycle === "closed") return blocked("ended");
        if (assignment.lifecycle !== "open") return blocked("service_unavailable");

        // Reuse the canonical solve boundary: exact generation, owner, source,
        // full definition manifest, wrong-question set, and current exam window.
        // Targeted entry has no PIN side effects. The returned ticket/exam stay
        // on the server and no durable session or assignment is created here.
        const result = await openStudentExamWithGateway(admin, {
            examId: item.examId,
            assignmentId: assignment.assignmentId,
            assignmentRevision: assignment.assignmentRevision,
            retake: { sourceAttemptId: item.sourceAttemptId, mode: "wrong", questionIds: assignment.retakeQuestionIds || [] },
            student: { studentId: identity.studentId, studentName: identity.name, identityType: "registered" },
        }, process.env, Date.now(), {
            organizationId: identity.organizationId, studentId: identity.studentId,
            studentName: identity.name, identityType: "registered",
            groupId: identity.groupId, groupName: identity.groupName,
        });
        if (result.status === "not_started") return blocked("not_started");
        if (result.status === "ended" || result.status === "archived") return blocked("ended");
        if (result.status === "invalid_questions" || result.status === "unsupported_retake") return blocked("questions_changed");
        if (result.status === "group_denied" || result.status === "login_required" || result.status === "not_found") return blocked("changed");
        if (result.status !== "allowed") return blocked("service_unavailable");

        // Scope hints support solve's retake UI/draft key, not authorization.
        // No student identifiers, answers, or raw tickets in the URL.
        const href = buildRetakeHref(encodeURIComponent(item.examId), item.sourceAttemptId, assignment.retakeQuestionIds || []);
        const params = new URLSearchParams({ assignment: assignment.assignmentId, assignmentRevision: String(assignment.assignmentRevision) });
        return { status: "ready", href: `${href}&${params.toString()}` };
    } catch { return blocked("service_unavailable"); }
}
