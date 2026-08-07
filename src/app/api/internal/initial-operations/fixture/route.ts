import { handleInitialOperationsRoute } from "@/lib/initialOperationsRoute.server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export function POST(request: Request): Promise<Response> {
    return handleInitialOperationsRoute(request, { kind: "fixture" });
}
