import { handleInitialOperationsRoute } from "@/lib/initialOperationsRoute.server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(
    request: Request,
    context: { params: Promise<{ operation: string }> },
): Promise<Response> {
    const { operation } = await context.params;
    return handleInitialOperationsRoute(request, { kind: "operation", operation });
}

export async function POST(
    request: Request,
    context: { params: Promise<{ operation: string }> },
): Promise<Response> {
    const { operation } = await context.params;
    return handleInitialOperationsRoute(request, { kind: "operation", operation });
}
