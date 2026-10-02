import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StudentServerIdentity } from "@/lib/studentServerSession";
import type { StudentExamGatewayClient } from "@/lib/studentExamServerGateway";

const controls = vi.hoisted(() => ({ list: vi.fn(), plan: vi.fn(), open: vi.fn() }));
vi.mock("@/lib/studentTargetedAssignmentGateway.server", () => ({ listStudentAssignmentsWithGateway: controls.list }));
vi.mock("@/lib/effectiveWorkspacePlanGateway", () => ({ readEffectiveWorkspacePlan: controls.plan }));
vi.mock("@/lib/studentExamServerGateway", () => ({ openStudentExamWithGateway: controls.open }));
import { resolveRemediationRetakeWithGateway } from "./remediationRetake.server";

const identity: StudentServerIdentity = { kind: "student", organizationId: "default", studentId: "student-1", name: "학생",
    identityType: "registered", issuedAt: 1, expiresAt: 2 };
const item = { sourceAttemptId: "source-1", examId: "exam/1", examTitle: "수학", state: "assigned", dueAt: "2026-09-20T14:59:00Z",
    correctedCount: 0, targetCount: 2 };
const assignment = { id: "exam/1", assignmentId: "assignment:1", assignmentRevision: 8, assignmentMode: "retake",
    retakeSourceAttemptId: "source-1", retakeQuestionIds: [2, 1], lifecycle: "open", access: { type: "targeted" } };
const rpc = vi.fn();
const admin = { rpc, from: vi.fn() } as unknown as StudentExamGatewayClient;
const run = () => resolveRemediationRetakeWithGateway(admin, identity, "source-1");

describe("remediation retake handoff", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        rpc.mockResolvedValue({ data: [item], error: null });
        controls.list.mockResolvedValue({ status: "loaded", assignments: [assignment] });
        controls.plan.mockResolvedValue({ authoritative: true, plan: "pro" });
        controls.open.mockResolvedValue({ status: "allowed", ticket: "secret-ticket", exam: { answer: "secret-answer" } });
    });
    it("uses only signed ownership and returns a generation-bound, URL-encoded retake link", async () => {
        const result = await run();
        expect(result).toEqual({ status: "ready", href: "/solve/exam%2F1?retakeFrom=source-1&questions=1%2C2&mode=wrong&assignment=assignment%3A1&assignmentRevision=8" });
        expect(rpc).toHaveBeenCalledExactlyOnceWith("omr_student_remediation_v1", { p_org: "default", p_student: "student-1" });
        expect(controls.open).toHaveBeenCalledWith(admin, {
            examId: "exam/1", assignmentId: "assignment:1", assignmentRevision: 8,
            retake: { sourceAttemptId: "source-1", mode: "wrong", questionIds: [2, 1] },
            student: { studentId: "student-1", studentName: "학생", identityType: "registered" },
        }, process.env, expect.any(Number), expect.objectContaining({ organizationId: "default", studentId: "student-1", identityType: "registered" }));
        expect(JSON.stringify(result)).not.toMatch(/secret|student-1|학생/);
    });
    it.each(["guest", "temporary"])("denies %s identities before any reads", async identityType => {
        expect(await resolveRemediationRetakeWithGateway(admin, { ...identity, identityType: identityType as "guest" | "temporary" }, "source-1"))
            .toEqual({ status: "blocked", code: "unauthorized" });
        expect(rpc).not.toHaveBeenCalled();
    });
    it("does not enumerate assignments for an absent or other student's case", async () => {
        rpc.mockResolvedValue({ data: [], error: null });
        expect(await run()).toEqual({ status: "blocked", code: "unavailable" });
        expect(controls.list).not.toHaveBeenCalled();
    });
    it.each([["paused", "paused"], ["handoff", "handoff"], ["confirmed", "completed"], ["awaiting_review", "review"]])
        ("rechecks current %s state before offering a retake", async (state, code) => {
            rpc.mockResolvedValue({ data: [{ ...item, state }], error: null });
            expect(await run()).toEqual({ status: "blocked", code });
            expect(controls.open).not.toHaveBeenCalled();
        });
    it.each([{ assignments: [] }, { assignments: [{ ...assignment, access: { type: "public" } }] }, { assignments: [{ ...assignment, assignmentMode: "base" }] }])
        ("does not grant or replace a missing targeted retake: $assignments", async ({ assignments }) => {
            controls.list.mockResolvedValue({ status: "loaded", assignments });
            expect(await run()).toEqual({ status: "blocked", code: "assignment_required" });
            expect(controls.open).not.toHaveBeenCalled();
        });
    it("never sends the student into a different original attempt's retake", async () => {
        controls.list.mockResolvedValue({ status: "loaded", assignments: [{ ...assignment, retakeSourceAttemptId: "other-source" }] });
        expect(await run()).toEqual({ status: "blocked", code: "different_source" });
        expect(controls.open).not.toHaveBeenCalled();
    });
    it.each([["scheduled", "not_started"], ["closed", "ended"], ["invalid", "service_unavailable"]])("reports %s lifecycle", async (lifecycle, code) => {
        controls.list.mockResolvedValue({ status: "loaded", assignments: [{ ...assignment, lifecycle }] });
        expect(await run()).toEqual({ status: "blocked", code });
    });
    it.each(["overdue", "recheck"])("does not confuse %s management state with the exam window", async state => {
        rpc.mockResolvedValue({ data: [{ ...item, state }], error: null });
        expect((await run()).status).toBe("ready");
    });
    it("distinguishes expired entitlement from a plan service failure", async () => {
        controls.plan.mockResolvedValue({ authoritative: true, plan: "free" });
        expect(await run()).toEqual({ status: "blocked", code: "plan_denied" });
        controls.plan.mockResolvedValue({ authoritative: false, plan: "free" });
        expect(await run()).toEqual({ status: "blocked", code: "service_unavailable" });
        expect(controls.open).not.toHaveBeenCalled();
    });
    it.each([["group_denied", "changed"], ["invalid_questions", "questions_changed"], ["archived", "ended"],
        ["not_started", "not_started"], ["service_unavailable", "service_unavailable"], ["misconfigured", "service_unavailable"]])
        ("maps fresh solve-boundary %s without leaking diagnostic data", async (status, code) => {
            controls.open.mockResolvedValue({ status, error: "private database info" });
            expect(await run()).toEqual({ status: "blocked", code });
        });
    it("fails closed on capacity, duplicate assignment rows, malformed cases, and transport failures", async () => {
        controls.list.mockResolvedValueOnce({ status: "capacity_exceeded" });
        expect(await run()).toEqual({ status: "blocked", code: "service_unavailable" });
        controls.list.mockResolvedValueOnce({ status: "loaded", assignments: [assignment, assignment] });
        expect(await run()).toEqual({ status: "blocked", code: "service_unavailable" });
        rpc.mockResolvedValueOnce({ data: [{}], error: null });
        expect(await run()).toEqual({ status: "blocked", code: "service_unavailable" });
        controls.open.mockRejectedValueOnce(new Error("private database info"));
        expect(await run()).toEqual({ status: "blocked", code: "service_unavailable" });
    });
});
