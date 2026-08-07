import "next/dist/compiled/server-only";
import { createHash } from "node:crypto";
import {
    REMOTE_ASSET_BUCKET,
    buildTeacherRemoteAssetUploadIdentity,
    validateTeacherRemoteAssetUploadDeclaration,
    type TeacherRemoteAssetUploadDeclaration,
} from "./remoteAssetContract.server";
import {
    finalizeTeacherRemoteAssetUploadWithGateway,
    prepareTeacherRemoteAssetUploadWithGateway,
} from "./remoteAssetGateway.server";
import type { RemoteAssetSupabaseGatewayClient } from "./remoteAssetGateway.server";
import {
    checkpointStudentAttemptSessionWithGateway,
    commitStudentAttemptSessionSubmitWithGateway,
    heartbeatStudentAttemptSessionWithGateway,
    openStudentAttemptSessionWithGateway,
    prepareStudentAttemptSessionSubmitWithGateway,
} from "./studentAttemptSessionGateway.server";
import { buildServerAttempt } from "./studentExamCore";
import { leaseTokenHash } from "./studentAttemptSessionCrypto.server";
import { serverGradedAttemptReceiptFromAttempt } from "./serverAttemptGrading";
import { listTeacherActiveAttemptSessionsWithGateway } from "./teacherAttemptGateway";
import type { TeacherAttemptGatewayClient } from "./teacherAttemptGateway";
import type { StudentServerIdentity } from "./studentServerSession";
import type { Exam } from "@/types/omr";
import type {
    InitialOperationsControlGateway,
    InitialOperationsFixtureScope,
} from "./initialOperationsControlHandler.server";
import type { InitialOperationsRequestContext } from "./initialOperationsControlPlane.server";

interface GatewayResult {
    data: unknown;
    error: { message?: string } | null;
}

interface StorageBucket {
    createSignedUploadUrl?(path: string, options: { upsert: false }): Promise<GatewayResult>;
    createSignedUrl?(path: string, expiresIn: number): Promise<GatewayResult>;
    info?(path: string): Promise<GatewayResult>;
    exists?(path: string): Promise<GatewayResult>;
    remove(paths: string[]): Promise<GatewayResult>;
}

interface LoadSelectQuery extends PromiseLike<GatewayResult> {
    eq(column: string, value: string): LoadSelectQuery;
    limit(value: number): PromiseLike<GatewayResult>;
}

export interface InitialOperationsLoadClient {
    rpc(name: string, args: Record<string, unknown>): Promise<GatewayResult>;
    storage: { from(bucket: string): StorageBucket };
    from(table: "omr_remote_assets"): { select(columns: string): LoadSelectQuery };
}

export const INITIAL_OPERATIONS_PRODUCTION_WORKLOAD_PATHS = Object.freeze({
    "student-read": Object.freeze(["rpc:omr_open_attempt_session_v1"]),
    checkpoint: Object.freeze(["rpc:omr_checkpoint_attempt_session_v1"]),
    heartbeat: Object.freeze(["rpc:omr_heartbeat_attempt_session_v1"]),
    "teacher-live-read": Object.freeze(["rpc:omr_list_active_attempt_sessions_v1"]),
    "teacher-upload-read": Object.freeze(["table:omr_remote_assets"]),
    "student-submit": Object.freeze([
        "rpc:omr_prepare_attempt_session_submit_v1",
        "rpc:omr_commit_attempt_session_submit_v1",
    ]),
    "student-submit-replay": Object.freeze([
        "rpc:omr_prepare_attempt_session_submit_v1",
        "rpc:omr_commit_attempt_session_submit_v1",
    ]),
    "teacher-max-pdf-upload-prepare": Object.freeze(["rpc:omr_prepare_teacher_asset_upload_v1"]),
    "teacher-max-pdf-upload-finalize": Object.freeze([
        "rpc:omr_authorize_teacher_asset_finalize_v1",
        "rpc:omr_finalize_teacher_asset_upload_v1",
    ]),
});

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") {
        const object = value as Record<string, unknown>;
        return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

function fixtureForRun(runId: string): InitialOperationsFixtureScope {
    const suffix = createHash("sha256").update(runId).digest("hex").slice(0, 16);
    return { organizationId: `teacher_${suffix}`, examId: `initial_ops_exam_${suffix}` };
}

function actorMatchesOperation(operation: string, runId: string, actorId: string): boolean {
    const suffix = createHash("sha256").update(runId).digest("hex").slice(0, 16);
    const role = operation === "teacher-live-read"
        ? "poller"
        : operation === "teacher-upload-read" || operation.startsWith("teacher-max-pdf-upload-")
            ? "uploader"
            : "student";
    const width = role === "student" ? 3 : 2;
    return new RegExp(`^${role}_${suffix}_\\d{${width}}$`).test(actorId);
}

function fixtureExam(fixture: InitialOperationsFixtureScope): Exam {
    const createdAt = "2026-08-07T00:00:00.000Z";
    return {
        id: fixture.examId,
        title: "Initial Operations 100-user exam",
        organizationId: fixture.organizationId,
        createdByUserId: `initial_ops_${fixture.organizationId.slice("teacher_".length)}`,
        createdAt,
        durationMin: 60,
        archived: false,
        accessConfig: { type: "public" },
        questions: Array.from({ length: 45 }, (_, index) => ({
            id: index + 1,
            number: index + 1,
            label: `Q${index + 1}`,
            score: 1,
            answer: (index % 5) + 1,
            choices: 5,
        })),
    };
}

function studentIdentity(context: InitialOperationsRequestContext, fixture: InitialOperationsFixtureScope): StudentServerIdentity {
    return {
        kind: "student",
        studentId: context.actorId,
        organizationId: fixture.organizationId,
        name: `Load Student ${context.actorId.slice(-3)}`,
        identityType: "temporary",
        issuedAt: 0,
        expiresAt: 4_102_444_800_000,
    };
}

function studentSessionInput(context: InitialOperationsRequestContext) {
    return {
        sessionId: `${context.runId}:session:${context.actorId}`,
        attemptId: `${context.runId}:attempt:${context.actorId}`,
        submissionId: `${context.runId}:submission:${context.actorId.slice(-3)}`,
        leaseToken: `${context.runId}:lease:${context.actorId}`,
        leaseSecret: context.runChallenge,
    };
}

function answersAtRevision(revision: number): Record<number, number> {
    const answers: Record<number, number> = {};
    for (let questionId = 1; questionId <= Math.min(45, revision); questionId += 1) {
        answers[questionId] = ((questionId - 1) % 5) + 1;
    }
    return answers;
}

function rpcArgs(
    context: InitialOperationsRequestContext,
    fixture: InitialOperationsFixtureScope,
): Record<string, unknown> {
    return {
        p_run_id: context.runId,
        p_run_challenge_hash: createHash("sha256").update(context.runChallenge).digest("hex"),
        p_organization_id: fixture.organizationId,
        p_exam_id: fixture.examId,
    };
}

function signedUrl(data: unknown): string {
    return clean(record(data)?.signedUrl ?? record(data)?.signed_url);
}

function declaration(
    context: InitialOperationsRequestContext,
    input: Record<string, unknown>,
): TeacherRemoteAssetUploadDeclaration | null {
    const fixture = record(input.fixture);
    const candidate: TeacherRemoteAssetUploadDeclaration = {
        organizationId: clean(fixture?.organizationId),
        examId: clean(fixture?.examId),
        kind: "problem_pdf",
        byteSize: Number(input.byteSize ?? input.expectedBytes),
        mimeType: "application/pdf",
        sha256Hex: clean(input.sha256Hex ?? input.expectedSha256).toLowerCase(),
        idempotencyKey: clean(input.idempotencyKey),
        createdByUserId: context.actorId,
        originalName: `${context.actorId}.pdf`,
    };
    const validated = validateTeacherRemoteAssetUploadDeclaration(candidate);
    return validated.ok ? validated : null;
}

function withCoverage(operation: keyof typeof INITIAL_OPERATIONS_PRODUCTION_WORKLOAD_PATHS, payload: Record<string, unknown>) {
    return { ...payload, workloadPaths: INITIAL_OPERATIONS_PRODUCTION_WORKLOAD_PATHS[operation] };
}

export function createInitialOperationsLoadGateway(
    client: InitialOperationsLoadClient,
    options: { fetchImpl?: typeof fetch } = {},
): InitialOperationsControlGateway {
    const mutateFixture: InitialOperationsControlGateway["mutateFixture"] = async (action, context, fixture) => {
        const result = await client.rpc("omr_initial_ops_fixture_v1", {
            p_action: action,
            ...rpcArgs(context, fixture),
        });
        const payload = result.error ? null : record(result.data);
        if (!payload) return { status: "service_unavailable" };
        if (action === "create") return payload;
        if (payload.status !== "cleanup_pending") return { status: "service_unavailable" };
        const objectPaths = Array.isArray(payload.objectPaths) ? payload.objectPaths.map(clean) : [];
        const prefix = `organizations/${fixture.organizationId}/`;
        if (objectPaths.some(path => !path.startsWith(prefix) || path.includes("..") || path.includes("\\"))) {
            return { status: "service_unavailable" };
        }
        if (objectPaths.length > 0) {
            const bucket = client.storage.from(REMOTE_ASSET_BUCKET);
            const removed = await bucket.remove(objectPaths);
            if (removed.error || !bucket.exists) {
                return { status: "service_unavailable" };
            }
            const existence = await Promise.all(objectPaths.map(path => bucket.exists!(path)));
            if (existence.some(result => result.error || result.data !== false)) {
                return { status: "service_unavailable" };
            }
        }
        const remaining = record(payload.remaining);
        if (!remaining || remaining.sessions !== 0 || remaining.attempts !== 0
            || remaining.assets !== 0 || remaining.uploadIntents !== 0
            || remaining.cleanupQueue !== 0 || remaining.members !== 0) {
            return { status: "service_unavailable" };
        }
        const finalized = await client.rpc("omr_initial_ops_fixture_v1", {
            p_action: "finalize_cleanup",
            ...rpcArgs(context, fixture),
        });
        const finalizedPayload = finalized.error ? null : record(finalized.data);
        const finalizedRemaining = record(finalizedPayload?.remaining);
        if (finalizedPayload?.status !== "cleaned" || !finalizedRemaining
            || finalizedRemaining.sessions !== 0 || finalizedRemaining.attempts !== 0
            || finalizedRemaining.assets !== 0 || finalizedRemaining.uploadIntents !== 0
            || finalizedRemaining.cleanupQueue !== 0 || finalizedRemaining.members !== 0
            || finalizedRemaining.objects !== 0) {
            return { status: "service_unavailable" };
        }
        return { status: "cleaned", remaining: { sessions: 0, attempts: 0, assets: 0, objects: 0 } };
    };

    const executeOperation: InitialOperationsControlGateway["executeOperation"] = async (operation, context, input) => {
        const suppliedFixture = record(input.fixture);
        const fixture = fixtureForRun(context.runId);
        if (!suppliedFixture || suppliedFixture.organizationId !== fixture.organizationId
            || suppliedFixture.examId !== fixture.examId
            || !actorMatchesOperation(operation, context.runId, context.actorId)) return { status: "invalid" };

        const session = studentSessionInput(context);
        const identity = studentIdentity(context, fixture);
        if (operation === "student-read") {
            if (!clean(input.examUpdatedAt)) return { status: "invalid" };
            const opened = await openStudentAttemptSessionWithGateway(client, {
                sessionId: session.sessionId,
                organizationId: fixture.organizationId,
                examId: fixture.examId,
                ownerStudentId: context.actorId,
                studentName: identity.name,
                identityType: "temporary",
                submissionId: session.submissionId,
                attemptId: session.attemptId,
                examQuestionIds: Array.from({ length: 45 }, (_, index) => index + 1),
                gradingSnapshot: fixtureExam(fixture),
                examUpdatedAt: clean(input.examUpdatedAt),
                durationSeconds: 3_600,
                newLeaseTokenHash: leaseTokenHash(session.leaseToken, session.leaseSecret),
            });
            return opened.status === "active"
                ? withCoverage(operation, {
                    status: "ok", examId: fixture.examId, questionCount: 45,
                    revision: opened.session.revision, leaseEpoch: opened.session.leaseEpoch,
                })
                : { status: "service_unavailable" };
        }
        if (operation === "checkpoint") {
            const expectedRevision = Number(input.expectedRevision ?? input.revision);
            const expectedLeaseEpoch = Number(input.expectedLeaseEpoch ?? 1);
            const checkpoint = await checkpointStudentAttemptSessionWithGateway(client, {
                sessionId: session.sessionId,
                organizationId: fixture.organizationId,
                ownerStudentId: context.actorId,
                expectedRevision,
                expectedLeaseEpoch,
                leaseTokenHash: leaseTokenHash(session.leaseToken, session.leaseSecret),
                answers: answersAtRevision(Number(input.revision)),
                subQuestionAnswers: {},
                progressPayload: { currentQuestionId: (Number(input.revision) % 45) + 1 },
            });
            return checkpoint.status === "active"
                ? withCoverage(operation, {
                    status: "ok", revision: checkpoint.session.revision, leaseEpoch: checkpoint.session.leaseEpoch,
                })
                : { status: "service_unavailable" };
        }
        if (operation === "heartbeat") {
            const heartbeat = await heartbeatStudentAttemptSessionWithGateway(client, {
                sessionId: session.sessionId,
                organizationId: fixture.organizationId,
                ownerStudentId: context.actorId,
                expectedLeaseEpoch: Number(input.expectedLeaseEpoch ?? 1),
                leaseTokenHash: leaseTokenHash(session.leaseToken, session.leaseSecret),
            });
            return heartbeat.status === "active"
                ? withCoverage(operation, {
                    status: "ok", revision: heartbeat.revision, leaseEpoch: heartbeat.leaseEpoch,
                })
                : { status: "service_unavailable" };
        }
        if (operation === "teacher-live-read") {
            const loaded = await listTeacherActiveAttemptSessionsWithGateway(
                client as unknown as TeacherAttemptGatewayClient,
                {
                    organizationId: fixture.organizationId,
                    organizationName: "Initial Operations",
                    actorUserId: `initial_ops_${fixture.organizationId.slice("teacher_".length)}`,
                    actorLabel: "Initial Operations",
                    memberRole: "owner",
                },
                fixture.examId,
            );
            if (loaded.status !== "loaded") return { status: "service_unavailable" };
            return withCoverage(operation, {
                status: "ok",
                observedRevisions: Object.fromEntries(loaded.sessions.map(item => [item.ownerStudentId, item.revision])),
            });
        }
        if (operation === "teacher-upload-read") {
            const result = await client.from("omr_remote_assets").select("id")
                .eq("organization_id", fixture.organizationId)
                .eq("exam_id", fixture.examId)
                .limit(11);
            if (result.error || !Array.isArray(result.data) || result.data.length > 10) {
                return { status: "service_unavailable" };
            }
            return withCoverage(operation, { status: "ok", examId: fixture.examId, assetCount: result.data.length });
        }
        if (operation === "student-submit" || operation === "student-submit-replay") {
            if (clean(input.idempotencyKey) !== session.submissionId) return { status: "invalid" };
            const prepared = await prepareStudentAttemptSessionSubmitWithGateway(client, {
                sessionId: session.sessionId,
                organizationId: fixture.organizationId,
                ownerStudentId: context.actorId,
                expectedRevision: Number(input.expectedRevision),
                expectedLeaseEpoch: Number(input.expectedLeaseEpoch),
                leaseTokenHash: leaseTokenHash(session.leaseToken, session.leaseSecret),
            });
            if (prepared.status !== "prepared") return { status: "service_unavailable" };
            const preparedSession = prepared.session;
            const finishedAt = preparedSession.serverNow;
            const attempt = buildServerAttempt({
                examId: fixture.examId,
                submissionId: preparedSession.submissionId,
                answers: preparedSession.answers,
                subQuestionAnswers: preparedSession.subQuestionAnswers,
                startedAt: preparedSession.startedAt,
            }, preparedSession.gradingSnapshot, identity, preparedSession.attemptId, finishedAt);
            const receipt = serverGradedAttemptReceiptFromAttempt(attempt);
            const receiptHash = createHash("sha256").update(stableJson(receipt)).digest("hex");
            (attempt as typeof attempt & { initialOperationsReceiptHash: string }).initialOperationsReceiptHash = receiptHash;
            const committed = await commitStudentAttemptSessionSubmitWithGateway(client, {
                sessionId: session.sessionId,
                organizationId: fixture.organizationId,
                ownerStudentId: context.actorId,
                expectedRevision: preparedSession.revision,
                expectedLeaseEpoch: preparedSession.leaseEpoch,
                leaseTokenHash: leaseTokenHash(session.leaseToken, session.leaseSecret),
                attempt,
            });
            if (committed.status !== "submitted") return { status: "service_unavailable" };
            const canonicalReceipt = serverGradedAttemptReceiptFromAttempt(committed.attempt);
            const canonicalHash = clean((committed.attempt as typeof committed.attempt & {
                initialOperationsReceiptHash?: string;
            }).initialOperationsReceiptHash) || createHash("sha256").update(stableJson(canonicalReceipt)).digest("hex");
            return withCoverage(operation, {
                status: "submitted",
                attemptId: committed.attempt.id,
                receiptHash: canonicalHash,
                receipt: canonicalReceipt,
                revision: preparedSession.revision,
                leaseEpoch: preparedSession.leaseEpoch,
            });
        }
        if (operation === "teacher-max-pdf-upload-prepare") {
            const upload = declaration(context, input);
            if (!upload) return { status: "invalid" };
            const prepared = await prepareTeacherRemoteAssetUploadWithGateway(
                client as unknown as RemoteAssetSupabaseGatewayClient,
                upload,
            );
            if (prepared.status !== "prepared") return { status: "service_unavailable" };
            return withCoverage(operation, {
                status: "prepared",
                uploadId: prepared.uploadId,
                objectPath: prepared.objectPath,
                uploadUrl: prepared.signedUrl,
                mode: prepared.mode,
                token: prepared.token,
                bucket: prepared.bucket,
                mimeType: prepared.mimeType,
            });
        }
        if (operation === "teacher-max-pdf-upload-finalize") {
            const upload = declaration(context, input);
            if (!upload) return { status: "invalid" };
            const identity = buildTeacherRemoteAssetUploadIdentity(upload);
            if (clean(input.objectPath) !== identity.objectPath) return { status: "invalid" };
            const finalized = await finalizeTeacherRemoteAssetUploadWithGateway(
                client as unknown as RemoteAssetSupabaseGatewayClient,
                {
                    uploadId: identity.uploadId,
                    organizationId: upload.organizationId,
                    examId: upload.examId,
                    kind: upload.kind,
                    objectPath: identity.objectPath,
                    byteSize: upload.byteSize,
                    mimeType: upload.mimeType,
                    sha256Hex: upload.sha256Hex,
                    originalName: upload.originalName,
                    createdByUserId: upload.createdByUserId,
                },
                { ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) },
            );
            if (finalized.status !== "finalized") return { status: "service_unavailable" };
            const bucket = client.storage.from(REMOTE_ASSET_BUCKET);
            if (!bucket.createSignedUrl) return { status: "service_unavailable" };
            const read = await bucket.createSignedUrl(identity.objectPath, 15 * 60);
            const readbackUrl = signedUrl(read.data);
            return read.error || !readbackUrl
                ? { status: "service_unavailable" }
                : withCoverage(operation, { status: "finalized", readbackUrl });
        }
        return { status: "invalid" };
    };

    const collectDatabase: InitialOperationsControlGateway["collectDatabase"] = async (phase, context) => {
        const fixture = fixtureForRun(context.runId);
        const result = await client.rpc("omr_initial_ops_database_snapshot_v1", {
            ...rpcArgs(context, fixture),
            p_phase: phase,
        });
        const payload = result.error ? null : record(result.data);
        return payload && payload.status === "ok" ? { ...payload, phase } : { status: "service_unavailable" };
    };
    return Object.freeze({ mutateFixture, executeOperation, collectDatabase });
}
