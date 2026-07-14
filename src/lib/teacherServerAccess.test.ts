import { describe, expect, it } from "vitest";
import { allowsPublishableTeacherFallback, resolveTeacherServerMode } from "./teacherServerAccess";

const SERVICE_ROLE_ENV = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
};

describe("teacherServerAccess fail-closed policy", () => {
    it("uses the service role whenever it is configured", () => {
        expect(resolveTeacherServerMode({ ...SERVICE_ROLE_ENV, NODE_ENV: "production" })).toBe("service_role");
        expect(resolveTeacherServerMode({ ...SERVICE_ROLE_ENV, NODE_ENV: "development" })).toBe("service_role");
    });

    it("permits the publishable-key fallback only outside production when the service role is missing", () => {
        expect(resolveTeacherServerMode({ NODE_ENV: "development" })).toBe("degraded_local");
        expect(resolveTeacherServerMode({ NODE_ENV: "test" })).toBe("degraded_local");
    });

    it("fails closed in production when the service role is missing (no publishable-key content path)", () => {
        expect(resolveTeacherServerMode({ NODE_ENV: "production" })).toBe("denied");
    });

    it("only degraded_local may keep using the publishable-key path", () => {
        expect(allowsPublishableTeacherFallback("degraded_local")).toBe(true);
        expect(allowsPublishableTeacherFallback("service_role")).toBe(false);
        expect(allowsPublishableTeacherFallback("denied")).toBe(false);
    });
});
