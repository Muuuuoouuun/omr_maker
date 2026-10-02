import { handleInitialOperationsRoute } from "@/lib/initialOperationsRoute.server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export function GET(request: Request): Promise<Response> {
    return handleInitialOperationsRoute(request, { kind: "database" });
}
