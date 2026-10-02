import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    result: { status: "ready", database: "ready", observability: "ready" } as Record<string, unknown>,
}));

vi.mock("@/lib/operationsHealth", () => ({
    authorizeReadinessRequest: () => true,
    probeOperationalReadiness: async () => mocks.result,
}));

import { GET } from "@/app/api/readyz/route";

describe("operational readiness route behavior", () => {
    beforeEach(() => {
        mocks.result = { status: "ready", database: "ready", observability: "ready" };
    });

    it.each([
        [{ status: "ready", database: "ready", observability: "ready" }, 200],
        [{ status: "degraded", database: "ready", observability: "probe_failed" }, 200],
        [{ status: "not_ready", database: "probe_failed", observability: "ready" }, 503],
    ])("maps %j to HTTP %i", async (result, expectedStatus) => {
        mocks.result = result;
        const response = await GET(new Request("https://app.example.test/api/readyz"));
        expect(response.status).toBe(expectedStatus);
        await expect(response.json()).resolves.toEqual(result);
    });
});
