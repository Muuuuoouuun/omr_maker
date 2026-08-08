import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Attempt, Exam } from "@/types/omr";

const mocks = vi.hoisted(() => ({
    cookie: "",
    cookieSets: [] as Array<{ name: string; value: string }>,
    validateSession: vi.fn(),
    openStudentExamWithGateway: vi.fn(),
    submitStudentAttemptWithGateway: vi.fn(),
    fetchExamRowById: vi.fn(),
    openSession: vi.fn(),
    checkpointSession: vi.fn(),
    prepareSubmit: vi.fn(),
    commitSubmit: vi.fn(),
}));

vi.mock("next/headers", () => ({
    headers: vi.fn(async () => new Headers({
        host: "localhost:3003",
        origin: "http://localhost:3003",
    })),
    cookies: vi.fn(async () => ({
        get: vi.fn((name: string) => name === "omr_student_server_session" && mocks.cookie
            ? { value: mocks.cookie }
            : undefined),
        set: vi.fn((name: string, value: string) => {
            mocks.cookie = value;
            mocks.cookieSets.push({ name, value });
        }),
        delete: vi.fn(),
    })),
}));

vi.mock("@/lib/supabaseServerAdmin", async importOriginal => {
    const actual = await importOriginal<typeof import("@/lib/supabaseServerAdmin")>();
    return {
        ...actual,
        getSupabaseServerConfigFromEnv: vi.fn(() => ({
            url: "https://example.supabase.co",
            serviceRoleKey: "service-role",
        })),
        createSupabaseAdminClient: vi.fn(() => {
            const query = {
                select() { return query; },
                eq() { return query; },
                async maybeSingle() { return { data: { plan: "free" }, error: null }; },
            };
            return { from: () => query, rpc: mocks.validateSession };
        }),
        fetchExamRowById: mocks.fetchExamRowById,
    };
});

vi.mock("@/lib/studentExamServerGateway", async importOriginal => {
    const actual = await importOriginal<typeof import("@/lib/studentExamServerGateway")>();
    return {
        ...actual,
        openStudentExamWithGateway: mocks.openStudentExamWithGateway,
        submitStudentAttemptWithGateway: mocks.submitStudentAttemptWithGateway,
    };
});

vi.mock("@/lib/studentAttemptSessionGateway.server", async importOriginal => {
    const actual = await importOriginal<typeof import("@/lib/studentAttemptSessionGateway.server")>();
    return {
        ...actual,
        openStudentAttemptSessionWithGateway: mocks.openSession,
        checkpointStudentAttemptSessionWithGateway: mocks.checkpointSession,
        prepareStudentAttemptSessionSubmitWithGateway: mocks.prepareSubmit,
        commitStudentAttemptSessionSubmitWithGateway: mocks.commitSubmit,
    };
});

import { issueGuestSession } from "@/app/actions/studentSession";
import { openStudentExam, submitStudentAttempt } from "@/app/actions/studentAttempt";
import {
    checkpointDurableStudentAttemptSession,
    openDurableStudentAttemptSession,
    submitDurableStudentAttemptSession,
} from "@/app/actions/studentAttemptSession";
import { examToSupabaseRow } from "@/lib/omrPersistence";
import { createStudentAttemptTicket } from "@/lib/studentAttemptTicket";
import { studentSolveExamFromExam } from "@/lib/studentExamContract";
import {
    createSignedStudentSessionCookie,
    parseSignedStudentSessionCookie,
} from "@/lib/studentServerSession";

const exam: Exam = {
    id: "exam-public-1",
    organizationId: "org-ticket-owner",
    title: "공개 시험",
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    durationMin: 30,
    questions: [{ id: 1, number: 1, answer: 2, score: 5 }],
    accessConfig: { type: "public" },
};
const GUEST_TICKET_ID = "11111111-1111-4111-8111-111111111111";

function sessionState(revision: number, answers: Record<number, number> = {}) {
    return {
        sessionId: "session-guest-1",
        status: "in_progress" as const,
        revision,
        leaseEpoch: 1,
        startedAt: "2026-08-07T00:00:00.000Z",
        deadlineAt: "2026-08-07T00:30:00.000Z",
        serverNow: "2026-08-07T00:01:00.000Z",
        answers,
        subQuestionAnswers: {},
        progressPayload: {},
        allowedQuestionIds: [1],
    };
}

describe("public guest durable action flow", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-08-07T00:00:00.000Z"));
        vi.stubEnv("STUDENT_SESSION_SECRET", "guest-durable-session-secret");
        vi.stubEnv("STUDENT_ATTEMPT_SECRET", "guest-durable-attempt-secret");
        mocks.cookie = "";
        mocks.cookieSets.length = 0;
        mocks.validateSession.mockReset();
        mocks.validateSession.mockResolvedValue({ data: true, error: null });
        mocks.openStudentExamWithGateway.mockReset();
        mocks.submitStudentAttemptWithGateway.mockReset();
        mocks.fetchExamRowById.mockReset();
        mocks.openSession.mockReset();
        mocks.checkpointSession.mockReset();
        mocks.prepareSubmit.mockReset();
        mocks.commitSubmit.mockReset();
        mocks.fetchExamRowById.mockResolvedValue(examToSupabaseRow(exam));
        mocks.openStudentExamWithGateway.mockImplementation(async (
            _client: unknown,
            _input: unknown,
            _env: unknown,
            now: number,
            verifiedGuest: { guestId?: string; studentId: string; studentName: string } | null,
        ) => ({
            status: "allowed" as const,
            exam: studentSolveExamFromExam(exam),
            ticket: createStudentAttemptTicket({
                examId: exam.id,
                organizationId: exam.organizationId!,
                studentId: verifiedGuest!.studentId,
                studentName: verifiedGuest!.studentName,
                identityType: "guest",
                guestId: verifiedGuest!.guestId,
                allowedQuestionIds: [1],
            }, process.env, now, GUEST_TICKET_ID)!,
        }));
        mocks.openSession.mockResolvedValue({
            status: "active",
            leaseTokenRotated: true,
            session: sessionState(1),
            gradingSnapshot: exam,
        });
        mocks.checkpointSession.mockResolvedValue({
            status: "active",
            session: sessionState(2, { 1: 2 }),
        });
        mocks.prepareSubmit.mockResolvedValue({
            status: "prepared",
            session: {
                ...sessionState(2, { 1: 2 }),
                gradingSnapshot: exam,
                submissionId: GUEST_TICKET_ID,
                attemptId: `attempt_${GUEST_TICKET_ID}`,
            },
        });
        mocks.commitSubmit.mockImplementation(async (_client: unknown, { attempt }: { attempt: Attempt }) => ({
            status: "submitted" as const,
            attempt,
        }));
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
    });

    it("binds the signed guest to the ticket organization before open, checkpoint, and submit", async () => {
        await expect(issueGuestSession("게스트 학생")).resolves.toMatchObject({ ok: true });
        const issuedGuest = parseSignedStudentSessionCookie(mocks.cookie);
        expect(issuedGuest).toMatchObject({
            kind: "guest",
            organizationId: "",
            identityType: "guest",
        });
        vi.setSystemTime(new Date("2026-08-07T01:00:00.000Z"));

        const openedExam = await openStudentExam({
            examId: exam.id,
            student: {
                studentId: issuedGuest!.studentId,
                studentName: issuedGuest!.studentName,
                identityType: "guest",
                guestId: issuedGuest!.guestId,
            },
        });
        expect(openedExam.status).toBe("allowed");

        const boundGuest = parseSignedStudentSessionCookie(mocks.cookie);
        expect(boundGuest).toMatchObject({
            kind: "guest",
            guestId: issuedGuest!.guestId,
            studentId: issuedGuest!.studentId,
            organizationId: exam.organizationId,
            identityType: "guest",
            issuedAt: issuedGuest!.issuedAt,
            expiresAt: issuedGuest!.expiresAt,
        });
        if (openedExam.status !== "allowed") throw new Error("expected allowed exam");

        const durable = await openDurableStudentAttemptSession({
            examId: exam.id,
            attemptTicket: openedExam.ticket,
        });
        expect(durable.status).toBe("active");
        if (durable.status !== "active") throw new Error("expected active session");

        const checkpoint = await checkpointDurableStudentAttemptSession({
            sessionId: durable.session.sessionId,
            expectedRevision: durable.session.revision,
            expectedLeaseEpoch: durable.session.leaseEpoch,
            leaseToken: durable.leaseToken,
            answers: { 1: 2 },
            subQuestionAnswers: {},
        });
        expect(checkpoint.status).toBe("active");
        if (checkpoint.status !== "active") throw new Error("expected active checkpoint");

        const submitted = await submitDurableStudentAttemptSession({
            sessionId: checkpoint.session.sessionId,
            expectedRevision: checkpoint.session.revision,
            expectedLeaseEpoch: checkpoint.session.leaseEpoch,
            leaseToken: durable.leaseToken,
            finishedAt: "2026-08-07T00:10:00.000Z",
        });
        expect(submitted).toMatchObject({
            status: "submitted",
            receipt: { examId: exam.id, score: 5, totalScore: 5 },
        });

        for (const gateway of [mocks.openSession, mocks.checkpointSession, mocks.prepareSubmit, mocks.commitSubmit]) {
            expect(gateway).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
                organizationId: exam.organizationId,
                ownerStudentId: issuedGuest!.studentId,
            }));
        }
    });

    it("never downgrades a signed registered session to a guest on validation success or outage", async () => {
        mocks.cookie = createSignedStudentSessionCookie({
            kind: "student",
            accountId: `student_credential_${"a".repeat(32)}`,
            organizationId: "pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa",
            studentId: "student-registered-1",
            name: "등록 학생",
            identityType: "registered",
            credentialGeneration: 4,
        })!;
        const registeredCookie = mocks.cookie;

        await expect(issueGuestSession("게스트로 변경")).resolves.toEqual({ ok: false });
        expect(mocks.cookie).toBe(registeredCookie);
        expect(mocks.cookieSets).toHaveLength(0);

        mocks.validateSession.mockRejectedValueOnce(new Error("student session dependency timeout"));
        await expect(issueGuestSession("게스트로 변경")).resolves.toEqual({ ok: false });
        expect(mocks.cookie).toBe(registeredCookie);
        expect(mocks.cookieSets).toHaveLength(0);
    });

    it("fails registered open and submit closed before either gateway on stale or unavailable validation", async () => {
        mocks.cookie = createSignedStudentSessionCookie({
            kind: "student",
            accountId: `student_credential_${"b".repeat(32)}`,
            organizationId: "pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa",
            studentId: "student-registered-2",
            name: "등록 학생 2",
            identityType: "registered",
            credentialGeneration: 8,
        })!;
        mocks.validateSession.mockRejectedValueOnce(new Error("student validation timeout"));
        await expect(openStudentExam({
            examId: exam.id,
            student: {
                studentId: "student-registered-2",
                studentName: "등록 학생 2",
                identityType: "registered",
            },
        })).resolves.toEqual({ status: "service_unavailable" });
        expect(mocks.openStudentExamWithGateway).not.toHaveBeenCalled();

        const ticket = createStudentAttemptTicket({
            examId: exam.id,
            organizationId: "pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa",
            studentId: "student-registered-2",
            studentName: "등록 학생 2",
            identityType: "registered",
            allowedQuestionIds: [1],
        }, process.env, Date.now(), "44444444-4444-4444-8444-444444444444")!;
        mocks.validateSession.mockResolvedValueOnce({ data: false, error: null });
        await expect(submitStudentAttempt({ ticket, answers: { 1: 2 } }))
            .resolves.toEqual({ status: "invalid_ticket" });
        expect(mocks.submitStudentAttemptWithGateway).not.toHaveBeenCalled();
    });

    it("rejects an active ticket/session identity mismatch but preserves guest direct submit", async () => {
        mocks.cookie = createSignedStudentSessionCookie({
            kind: "student",
            accountId: `student_credential_${"c".repeat(32)}`,
            organizationId: "pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa",
            studentId: "student-registered-3",
            name: "등록 학생 3",
            identityType: "registered",
            credentialGeneration: 9,
        })!;
        const mismatched = createStudentAttemptTicket({
            examId: exam.id,
            organizationId: "pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa",
            studentId: "different-student",
            studentName: "다른 학생",
            identityType: "registered",
            allowedQuestionIds: [1],
        }, process.env, Date.now(), "55555555-5555-4555-8555-555555555555")!;
        await expect(submitStudentAttempt({ ticket: mismatched, answers: {} }))
            .resolves.toEqual({ status: "invalid_ticket" });
        expect(mocks.submitStudentAttemptWithGateway).not.toHaveBeenCalled();

        mocks.cookie = createSignedStudentSessionCookie({
            kind: "guest",
            guestId: "guest-direct-submit",
            organizationId: exam.organizationId,
            name: "게스트 학생",
            identityType: "guest",
        })!;
        const guest = parseSignedStudentSessionCookie(mocks.cookie)!;
        const guestTicket = createStudentAttemptTicket({
            examId: exam.id,
            organizationId: guest.organizationId,
            studentId: guest.studentId,
            studentName: guest.studentName,
            identityType: "guest",
            guestId: guest.guestId,
            allowedQuestionIds: [1],
        }, process.env, Date.now(), "66666666-6666-4666-8666-666666666666")!;
        mocks.submitStudentAttemptWithGateway.mockResolvedValueOnce({ status: "invalid_ticket" });
        await expect(submitStudentAttempt({ ticket: guestTicket, answers: {} }))
            .resolves.toEqual({ status: "invalid_ticket" });
        expect(mocks.submitStudentAttemptWithGateway).toHaveBeenCalledTimes(1);
    });

    it("refuses to bind a guest when an impossible group-exam grant crosses the gateway boundary", async () => {
        await expect(issueGuestSession("게스트 학생")).resolves.toMatchObject({ ok: true });
        const issuedGuest = parseSignedStudentSessionCookie(mocks.cookie)!;
        const groupExam: Exam = {
            ...exam,
            id: "exam-group-1",
            accessConfig: { type: "group", groupIds: ["class-1"] },
        };
        mocks.openStudentExamWithGateway.mockResolvedValueOnce({
            status: "allowed",
            exam: studentSolveExamFromExam(groupExam),
            ticket: createStudentAttemptTicket({
                examId: groupExam.id,
                organizationId: groupExam.organizationId!,
                studentId: issuedGuest.studentId,
                studentName: issuedGuest.studentName,
                identityType: "guest",
                guestId: issuedGuest.guestId,
                allowedQuestionIds: [1],
            }, process.env, Date.now(), "22222222-2222-4222-8222-222222222222")!,
        });

        await expect(openStudentExam({
            examId: groupExam.id,
            student: {
                studentId: issuedGuest.studentId,
                studentName: issuedGuest.studentName,
                identityType: "guest",
                guestId: issuedGuest.guestId,
            },
        })).resolves.toEqual({ status: "service_unavailable" });

        expect(parseSignedStudentSessionCookie(mocks.cookie)).toMatchObject({
            kind: "guest",
            organizationId: "",
        });
        expect(mocks.cookieSets).toHaveLength(1);
    });

    it("does not accept a client-tampered organization in the attempt ticket", async () => {
        await expect(issueGuestSession("게스트 학생")).resolves.toMatchObject({ ok: true });
        const issuedGuest = parseSignedStudentSessionCookie(mocks.cookie)!;
        const signed = createStudentAttemptTicket({
            examId: exam.id,
            organizationId: exam.organizationId!,
            studentId: issuedGuest.studentId,
            studentName: issuedGuest.studentName,
            identityType: "guest",
            guestId: issuedGuest.guestId,
            allowedQuestionIds: [1],
        }, process.env, Date.now(), "33333333-3333-4333-8333-333333333333")!;
        const [payload, signature] = signed.split(".");
        const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        claims.organizationId = "org-client-forged";
        const tamperedTicket = `${Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")}.${signature}`;
        mocks.openStudentExamWithGateway.mockResolvedValueOnce({
            status: "allowed",
            exam: studentSolveExamFromExam(exam),
            ticket: tamperedTicket,
        });

        await expect(openStudentExam({
            examId: exam.id,
            student: {
                studentId: issuedGuest.studentId,
                studentName: issuedGuest.studentName,
                identityType: "guest",
                guestId: issuedGuest.guestId,
            },
        })).resolves.toEqual({ status: "service_unavailable" });
        expect(parseSignedStudentSessionCookie(mocks.cookie)).toMatchObject({ organizationId: "" });
        expect(mocks.cookieSets).toHaveLength(1);
    });
});
