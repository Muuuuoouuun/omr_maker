import { handleInitialOperationsRoute } from "@/lib/initialOperationsRoute.server";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

export function GET(request: Request): Promise<Response> {
    return handleInitialOperationsRoute(request, { kind: "contract" });
}
