import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as getHealth } from "@/app/api/healthz/route";
import { GET as getReadiness } from "@/app/api/readyz/route";

describe("health route contracts", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("serves public liveness without caching or backend details", async () => {
        vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "must-not-leak");
        const response = await getHealth();
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        const body = await response.json();
        expect(body).toMatchObject({ status: "alive", build: expect.any(String), timestamp: expect.any(String) });
        expect(JSON.stringify(body)).not.toContain("must-not-leak");
        expect(Object.keys(body).sort()).toEqual(["build", "status", "timestamp"]);
    });

    it("returns 401 without the readiness bearer token and never caches it", async () => {
        vi.stubEnv("OMR_READINESS_TOKEN", "ops-readiness-token");
        const response = await getReadiness(new Request("http://localhost/api/readyz"));
        expect(response.status).toBe(401);
        expect(response.headers.get("cache-control")).toBe("no-store");
        await expect(response.json()).resolves.toEqual({ status: "unauthorized" });
    });

    it("returns a redacted 503 when authorized but backend configuration is absent", async () => {
        vi.stubEnv("OMR_READINESS_TOKEN", "ops-readiness-token");
        vi.stubEnv("SUPABASE_URL", "");
        vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
        vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
        vi.stubEnv("OMR_SUPABASE_SERVICE_ROLE_KEY", "");
        const response = await getReadiness(new Request("http://localhost/api/readyz", {
            headers: { authorization: "Bearer ops-readiness-token" },
        }));
        expect(response.status).toBe(503);
        expect(response.headers.get("cache-control")).toBe("no-store");
        await expect(response.json()).resolves.toEqual({
            status: "not_ready",
            database: "not_configured",
            observability: "not_configured",
        });
    });
});
