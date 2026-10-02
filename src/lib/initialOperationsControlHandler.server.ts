import "next/dist/compiled/server-only";
import { createHash } from "node:crypto";
import {
    authorizeInitialOperationsRequest,
    initialOperationsResponseHeaders,
    parseInitialOperationsRequestContext,
    type InitialOperationsRequestContext,
    type InitialOperationsServerConfig,
} from "./initialOperationsControlPlane.server";
import { INITIAL_OPERATIONS_PRODUCTION_WORKLOAD_PATHS } from "./initialOperationsLoadGateway.server";

export type InitialOperationsOperation =
    | "student-read"
    | "teacher-live-read"
    | "teacher-upload-read"
    | "checkpoint"
    | "heartbeat"
    | "student-submit"
    | "student-submit-replay"
    | "teacher-max-pdf-upload-prepare"
    | "teacher-max-pdf-upload-finalize"
    | "instance-rss-read";

export interface InitialOperationsFixtureScope {
    organizationId: string;
    examId: string;
}

export interface InitialOperationsControlGateway {
    mutateFixture(
        action: "create" | "cleanup",
        context: InitialOperationsRequestContext,
        fixture: InitialOperationsFixtureScope,
    ): Promise<Record<string, unknown>>;
    executeOperation(
        operation: InitialOperationsOperation,
        context: InitialOperationsRequestContext,
        input: Record<string, unknown>,
    ): Promise<Record<string, unknown>>;
    collectDatabase(
        phase: "before" | "after",
        context: InitialOperationsRequestContext,
    ): Promise<Record<string, unknown>>;
}

type RequestKind =
    | { kind: "contract" | "fixture" | "rss" | "database" }
    | { kind: "operation"; operation: InitialOperationsOperation };

interface Dependencies {
    config: InitialOperationsServerConfig | null;
    gateway: InitialOperationsControlGateway;
    memoryUsage?: () => NodeJS.MemoryUsage;
    now?: () => number;
}

const MAX_BODY_BYTES = 64 * 1024;

function fixtureScope(runId: string): InitialOperationsFixtureScope {
    const suffix = createHash("sha256").update(runId).digest("hex").slice(0, 16);
    return { organizationId: `teacher_${suffix}`, examId: `initial_ops_exam_${suffix}` };
}

async function boundedJson(request: Request): Promise<Record<string, unknown> | null | "too_large"> {
    const declared = request.headers.get("content-length");
    if (declared !== null && (!/^(?:0|[1-9]\d*)$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
        return "too_large";
    }
    const reader = request.body?.getReader();
    if (!reader) return {};
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
        while (true) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > MAX_BODY_BYTES) return "too_large";
            chunks.push(part.value);
        }
    } finally {
        reader.releaseLock();
    }
    try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(
            chunks.map(chunk => Buffer.from(chunk)),
            bytes,
        ));
        const parsed: unknown = text ? JSON.parse(text) : {};
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

function response(
    config: InitialOperationsServerConfig | null,
    startedAt: number,
    status: number,
    payload: Record<string, unknown>,
    memoryUsage: () => NodeJS.MemoryUsage = process.memoryUsage,
    now: () => number = Date.now,
): Response {
    const rssBytes = memoryUsage().rss;
    const capturedAtMs = now();
    const headers = config
        ? initialOperationsResponseHeaders(config, performance.now() - startedAt, { rssBytes, capturedAtMs })
        : new Headers({ "cache-control": "no-store" });
    return Response.json(payload, { status, headers });
}

function outcomeStatus(result: Record<string, unknown>): number {
    const status = result.status;
    if (status === "invalid" || status === "invalid_request") return 400;
    if (["ok", "created", "cleaned", "submitted", "prepared", "finalized"].includes(String(status))) return 200;
    return 503;
}

export async function handleInitialOperationsControlRequest(
    request: Request,
    route: RequestKind,
    dependencies: Dependencies,
): Promise<Response> {
    const startedAt = performance.now();
    const { config } = dependencies;
    const respond = (status: number, payload: Record<string, unknown>) => response(
        config,
        startedAt,
        status,
        payload,
        dependencies.memoryUsage ?? process.memoryUsage,
        dependencies.now ?? Date.now,
    );
    if (!config) return respond(404, { status: "not_found" });
    if (!authorizeInitialOperationsRequest(request.headers, config)) {
        return respond(401, { status: "unauthorized" });
    }
    const context = parseInitialOperationsRequestContext(request.headers, config);
    if (!context) return respond(401, { status: "unauthorized" });
    const expectedFixture = fixtureScope(context.runId);

    try {
        if (route.kind === "contract") {
            if (request.method !== "GET") return respond(405, { status: "invalid_request" });
            return respond(200, {
                environment: "staging",
                appOrigin: `https://${config.stagingHost}`,
                storageOrigin: config.stagingSupabaseUrl,
                databaseProjectRefHash: config.databaseProjectRefHash,
                controlPlaneVersion: 2,
                productionWorkloadPaths: INITIAL_OPERATIONS_PRODUCTION_WORKLOAD_PATHS,
            });
        }
        if (route.kind === "rss") {
            if (request.method !== "GET") return respond(405, { status: "invalid_request" });
            const capturedAtMs = dependencies.now?.() ?? Date.now();
            const rssBytes = (dependencies.memoryUsage ?? process.memoryUsage)().rss;
            if (!Number.isSafeInteger(rssBytes) || rssBytes < 1) {
                return respond(503, { status: "unavailable" });
            }
            return respond(200, {
                kind: "rss",
                source: "server",
                runId: context.runId,
                serverInstanceId: config.serverInstanceId,
                build: config.build,
                capturedAtMs,
                rssBytes,
            });
        }
        if (route.kind === "database") {
            if (request.method !== "GET") return respond(405, { status: "invalid_request" });
            const phase = new URL(request.url).searchParams.get("phase");
            if (phase !== "before" && phase !== "after") {
                return respond(400, { status: "invalid_request" });
            }
            const result = await dependencies.gateway.collectDatabase(phase, context);
            return respond(outcomeStatus(result), result);
        }
        if (route.kind === "fixture") {
            if (request.method !== "POST") return respond(405, { status: "invalid_request" });
            const body = await boundedJson(request);
            if (body === "too_large") return respond(413, { status: "invalid_request" });
            const fixture = body && typeof body.fixture === "object" && body.fixture !== null
                ? body.fixture as Record<string, unknown>
                : null;
            if (!body || (body.action !== "create" && body.action !== "cleanup")
                || fixture?.organizationId !== expectedFixture.organizationId
                || fixture?.examId !== expectedFixture.examId) {
                return respond(400, { status: "invalid_request" });
            }
            const result = await dependencies.gateway.mutateFixture(body.action, context, expectedFixture);
            return respond(outcomeStatus(result), result);
        }
        if (route.kind !== "operation") {
            return respond(404, { status: "not_found" });
        }
        const operation = route.operation;
        const readOperation = operation.includes("read");
        if (request.method !== (readOperation ? "GET" : "POST")) {
            return respond(405, { status: "invalid_request" });
        }
        const body = readOperation
            ? { examUpdatedAt: new URL(request.url).searchParams.get("examUpdatedAt") ?? "" }
            : await boundedJson(request);
        if (body === "too_large") return respond(413, { status: "invalid_request" });
        if (!body) return respond(400, { status: "invalid_request" });
        const suppliedFixture = body.fixture;
        if (suppliedFixture && (typeof suppliedFixture !== "object" || suppliedFixture === null
            || (suppliedFixture as Record<string, unknown>).organizationId !== expectedFixture.organizationId
            || (suppliedFixture as Record<string, unknown>).examId !== expectedFixture.examId)) {
            return respond(400, { status: "invalid_request" });
        }
        if (operation === "instance-rss-read") {
            const capturedAtMs = dependencies.now?.() ?? Date.now();
            const rssBytes = (dependencies.memoryUsage ?? process.memoryUsage)().rss;
            return Number.isSafeInteger(rssBytes) && rssBytes > 0
                ? respond(200, {
                    status: "ok", kind: "rss", source: "server", runId: context.runId,
                    serverInstanceId: config.serverInstanceId, build: config.build, capturedAtMs, rssBytes,
                })
                : respond(503, { status: "unavailable" });
        }
        const result = await dependencies.gateway.executeOperation(operation, context, {
            ...body,
            fixture: expectedFixture,
        });
        return respond(outcomeStatus(result), result);
    } catch {
        return respond(503, { status: "unavailable" });
    }
}
