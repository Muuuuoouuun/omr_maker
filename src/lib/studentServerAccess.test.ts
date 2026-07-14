import { describe, expect, it } from "vitest";
import { allowsAnswerBearingLocalFallback, resolveStudentServerMode } from "./studentServerAccess";

const SERVICE_ROLE_ENV = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
};

describe("studentServerAccess fail-closed policy", () => {
    it("uses the service role whenever it is configured", () => {
        expect(resolveStudentServerMode({ ...SERVICE_ROLE_ENV, NODE_ENV: "production" })).toBe("service_role");
        expect(resolveStudentServerMode({ ...SERVICE_ROLE_ENV, NODE_ENV: "development" })).toBe("service_role");
    });

    it("permits a local fallback only outside production when the service role is missing", () => {
        expect(resolveStudentServerMode({ NODE_ENV: "development" })).toBe("degraded_local");
        expect(resolveStudentServerMode({ NODE_ENV: "test" })).toBe("degraded_local");
    });

    it("fails closed in production when the service role is missing (no answer leak)", () => {
        expect(resolveStudentServerMode({ NODE_ENV: "production" })).toBe("denied");
    });

    it("only degraded_local may read the answer-bearing local copy", () => {
        expect(allowsAnswerBearingLocalFallback("degraded_local")).toBe(true);
        expect(allowsAnswerBearingLocalFallback("service_role")).toBe(false);
        expect(allowsAnswerBearingLocalFallback("denied")).toBe(false);
    });
});
