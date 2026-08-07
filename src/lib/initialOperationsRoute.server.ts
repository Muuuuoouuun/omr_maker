import "next/dist/compiled/server-only";
import {
    handleInitialOperationsControlRequest,
    type InitialOperationsOperation,
} from "./initialOperationsControlHandler.server";
import { resolveInitialOperationsServerConfig } from "./initialOperationsControlPlane.server";
import {
    createInitialOperationsLoadGateway,
    type InitialOperationsLoadClient,
} from "./initialOperationsLoadGateway.server";
import { createSupabaseAdminClient, getSupabaseServerConfigFromEnv } from "./supabaseServerAdmin";

const OPERATIONS = new Set<InitialOperationsOperation>([
    "student-read",
    "teacher-live-read",
    "teacher-upload-read",
    "checkpoint",
    "heartbeat",
    "student-submit",
    "student-submit-replay",
    "teacher-max-pdf-upload-prepare",
    "teacher-max-pdf-upload-finalize",
    "instance-rss-read",
]);

function dependencies() {
    const config = resolveInitialOperationsServerConfig();
    const database = config ? getSupabaseServerConfigFromEnv() : null;
    const client = database
        ? createSupabaseAdminClient(database) as unknown as InitialOperationsLoadClient
        : null;
    return {
        config: client ? config : null,
        gateway: client
            ? createInitialOperationsLoadGateway(client)
            : {
                async mutateFixture() { return { status: "service_unavailable" }; },
                async executeOperation() { return { status: "service_unavailable" }; },
                async collectDatabase() { return { status: "service_unavailable" }; },
            },
    };
}

export function handleInitialOperationsRoute(
    request: Request,
    route:
        | { kind: "contract" | "fixture" | "rss" | "database" }
        | { kind: "operation"; operation: string },
): Promise<Response> {
    if (route.kind === "operation" && !OPERATIONS.has(route.operation as InitialOperationsOperation)) {
        return Promise.resolve(Response.json({ status: "not_found" }, {
            status: 404,
            headers: { "cache-control": "no-store" },
        }));
    }
    return handleInitialOperationsControlRequest(
        request,
        route.kind === "operation"
            ? { kind: "operation", operation: route.operation as InitialOperationsOperation }
            : route,
        dependencies(),
    );
}
