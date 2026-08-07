import { describe, expect, it } from "vitest";
import type { Exam } from "@/types/omr";
import * as gateway from "./teacherAttemptGateway";
import type { TeacherAttemptGatewayClient } from "./teacherAttemptGateway";

const teacherContext = {
    organizationId: "org-a",
    organizationName: "조직 A",
    actorUserId: "teacher-a",
    actorLabel: "김 교사",
    memberRole: "teacher" as const,
};

const exam: Exam = {
    id: "exam-a",
    organizationId: "org-a",
    classId: "class-a",
    title: "중간고사",
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:01:00.000Z",
    questions: [
        { id: 1, number: 1, answer: 2, choices: 5, score: 4 },
        { id: 2, number: 2, answer: 3, choices: 5, score: 6 },
    ],
};

describe("teacher durable live session gateway", () => {
    it("returns a bounded answer-free active-session projection", async () => {
        const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
        const client = {
            async rpc(name: string, args: Record<string, unknown>) {
                calls.push({ name, args });
                return {
                    data: [{
                        session_id: "session-a",
                        attempt_id: "attempt-ticket-a",
                        exam_id: "exam-a",
                        class_id: "class-a",
                        assignment_id: "assignment-a",
                        owner_student_id: "student-a",
                        student_profile_id: "student-a",
                        student_name: "학생 A",
                        identity_type: "registered",
                        started_at: "2026-08-07T00:02:00.000Z",
                        deadline_at: "2026-08-07T01:02:00.000Z",
                        last_heartbeat_at: "2026-08-07T00:03:00.000Z",
                        revision: 7,
                        answered_count: 1,
                        total_question_count: 2,
                        current_question_id: 2,
                        grading_snapshot: { questions: [{ answer: 2 }] },
                        answers: { 1: 2 },
                    }],
                    error: null,
                };
            },
        } as unknown as TeacherAttemptGatewayClient;
        const scoped = gateway as unknown as {
            listTeacherActiveAttemptSessionsWithGateway?: (
                client: TeacherAttemptGatewayClient,
                context: typeof teacherContext,
                examId: string,
            ) => Promise<{ status: string; sessions?: Array<Record<string, unknown>> }>;
        };

        expect(scoped.listTeacherActiveAttemptSessionsWithGateway).toBeTypeOf("function");
        if (!scoped.listTeacherActiveAttemptSessionsWithGateway) return;
        const result = await scoped.listTeacherActiveAttemptSessionsWithGateway(client, teacherContext, " exam-a ");

        expect(result).toEqual({
            status: "loaded",
            sessions: [{
                sessionId: "session-a",
                attemptId: "attempt-ticket-a",
                examId: "exam-a",
                classId: "class-a",
                assignmentId: "assignment-a",
                ownerStudentId: "student-a",
                studentProfileId: "student-a",
                studentName: "학생 A",
                identityType: "registered",
                startedAt: "2026-08-07T00:02:00.000Z",
                deadlineAt: "2026-08-07T01:02:00.000Z",
                lastHeartbeatAt: "2026-08-07T00:03:00.000Z",
                revision: 7,
                answeredCount: 1,
                totalQuestionCount: 2,
                currentQuestionId: 2,
            }],
        });
        expect(JSON.stringify(result)).not.toContain("grading_snapshot");
        expect(JSON.stringify(result)).not.toContain('"answers"');
        expect(calls).toEqual([{
            name: "omr_list_active_attempt_sessions_v1",
            args: {
                p_organization_id: "org-a",
                p_exam_id: "exam-a",
                p_actor_user_id: "teacher-a",
                p_member_role: "teacher",
                p_limit: 101,
            },
        }]);
    });

    it("commits only revision fingerprints while the database grades its locked snapshots", async () => {
        const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
        const client = {
            async rpc(name: string, args: Record<string, unknown>) {
                calls.push({ name, args });
                if (name === "omr_prepare_teacher_force_finish_sessions_compact_v1") {
                    return {
                        data: [{
                            session_id: "session-a",
                            organization_id: "org-a",
                            revision: 7,
                            grading_fingerprint: "f".repeat(64),
                            status: "in_progress",
                        }],
                        error: null,
                    };
                }
                return {
                    data: [{ payload: {
                        id: "attempt-ticket-a",
                        examId: "exam-a",
                        examTitle: "중간고사",
                        organizationId: "org-a",
                        classId: "class-a",
                        assignmentId: "assignment-a",
                        studentProfileId: "student-a",
                        studentId: "student-a",
                        studentName: "학생 A",
                        identityType: "registered",
                        startedAt: "2026-08-07T00:02:00.000Z",
                        finishedAt: "2026-08-07T00:10:00.000Z",
                        answers: { 1: 2 },
                        score: 4,
                        totalScore: 10,
                        status: "completed",
                        autoSubmitted: true,
                        questionResults: [],
                    } }],
                    error: null,
                };
            },
        } as unknown as TeacherAttemptGatewayClient;
        const scoped = gateway as unknown as {
            forceFinishTeacherAttemptSessionsWithGateway?: (
                client: TeacherAttemptGatewayClient,
                input: { sessionIds: string[]; finishedAt: string },
                context: typeof teacherContext,
            ) => Promise<{ status: string; attempts?: unknown[] }>;
        };

        expect(scoped.forceFinishTeacherAttemptSessionsWithGateway).toBeTypeOf("function");
        if (!scoped.forceFinishTeacherAttemptSessionsWithGateway) return;
        await expect(scoped.forceFinishTeacherAttemptSessionsWithGateway(client, {
            sessionIds: ["session-a", "session-a"],
            finishedAt: "2026-08-07T00:10:00.000Z",
        }, teacherContext)).resolves.toMatchObject({ status: "saved", attempts: [{ id: "attempt-ticket-a" }] });

        expect(calls.map(call => call.name)).toEqual([
            "omr_prepare_teacher_force_finish_sessions_compact_v1",
            "omr_force_finish_attempt_sessions_compact_v1",
        ]);
        expect(calls[0].args).toMatchObject({
            p_organization_id: "org-a",
            p_session_ids: ["session-a"],
            p_actor_user_id: "teacher-a",
            p_member_role: "teacher",
        });
        const expectations = calls[1].args.p_expectations as Array<Record<string, unknown>>;
        expect(expectations).toHaveLength(1);
        expect(expectations[0]).toEqual({
            session_id: "session-a",
            expected_revision: 7,
            expected_fingerprint: "f".repeat(64),
        });
        expect(calls[1].args).not.toHaveProperty("p_gradings");

        const compactBatch = Array.from({ length: 100 }, (_, index) => ({
            ...expectations[0],
            session_id: `session-${index}`,
        }));
        const compactBatchBytes = Buffer.byteLength(JSON.stringify(compactBatch), "utf8");
        expect(compactBatchBytes).toBeLessThan(256 * 1024);
    });

    it("fails closed before commit when the database has not supplied a CAS fingerprint", async () => {
        const calls: string[] = [];
        const client = {
            async rpc(name: string) {
                calls.push(name);
                return {
                    data: [{
                        session_id: "session-a",
                        submission_id: "ticket-a",
                        attempt_id: "attempt-ticket-a",
                        exam_id: "exam-a",
                        class_id: "class-a",
                        assignment_id: "assignment-a",
                        owner_student_id: "student-a",
                        student_name: "학생 A",
                        identity_type: "registered",
                        started_at: "2026-08-07T00:02:00.000Z",
                        revision: 7,
                        answers: { 1: 2 },
                        sub_question_answers: {},
                        allowed_question_ids: [1, 2],
                        grading_snapshot: exam,
                        retake_source_attempt_id: null,
                        retake_mode: null,
                        progress_payload: { currentQuestionId: 2 },
                        status: "in_progress",
                        submitted_attempt_id: null,
                    }],
                    error: null,
                };
            },
        } as unknown as TeacherAttemptGatewayClient;

        await expect(gateway.forceFinishTeacherAttemptSessionsWithGateway(client, {
            sessionIds: ["session-a"],
            finishedAt: "2026-08-07T00:10:00.000Z",
        }, teacherContext)).resolves.toEqual({ status: "not_found" });
        expect(calls).toEqual(["omr_prepare_teacher_force_finish_sessions_compact_v1"]);
    });
});
