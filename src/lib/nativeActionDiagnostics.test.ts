import { describe, expect, it } from "vitest";
import { sanitizedNativeDelivery, sanitizedNativeState } from "../../e2e/nativeActionDiagnostics";
import { sanitizedRuntimeError, staticRuntimeLocation } from "../../e2e/showcaseEntryDiagnostics";

const SECRET = "credential-private-bearer-secret@example.invalid";

describe("native action diagnostic secrecy", () => {
    it("retains native delivery flags without target text, form values, coordinates or arbitrary event names", () => {
        const safe = sanitizedNativeDelivery({ type: "click", phase: "bubble", isTrusted: true,
            targetBelongs: true, defaultPrevented: false, value: SECRET, target: SECRET, x: 77 });
        expect(safe).toEqual({ type: "click", phase: "bubble", isTrusted: true, targetBelongs: true, defaultPrevented: false });
        expect(sanitizedNativeDelivery({ ...safe, type: SECRET })).toBeNull();
        expect(sanitizedNativeDelivery({ ...safe, isTrusted: SECRET })).toBeNull();
        expect(sanitizedNativeDelivery({ ...safe, phase: SECRET })).toBeNull();
        expect(JSON.stringify(safe)).not.toContain(SECRET);
    });

    it("does not retain URL query values, text, input data or arbitrary truthy snapshot fields", () => {
        const state = sanitizedNativeState({ urlTab: SECRET, examActive: SECRET, overviewVisible: true,
            disclosureOpen: false, loginAlertPresent: true, url: SECRET, storage: SECRET });
        expect(state).toEqual({ urlTab: "other", examActive: false, overviewVisible: true,
            disclosureOpen: false, loginAlertPresent: true, maxHeartbeatLagMs: null });
        expect(JSON.stringify(state)).not.toContain(SECRET);
    });

    it("classifies failures and emits only known static source names and numeric locations", () => {
        const error = new TypeError(`Load failed ${SECRET}`);
        error.stack = `${SECRET}\n${SECRET}@http://localhost:3105/_next/static/chunks/${SECRET}.js:42:9`;
        const report = sanitizedRuntimeError(error);
        expect(report).toEqual({ name: "TypeError", category: "network",
            location: { file: "next-static-chunk", line: 42, column: 9 } });
        expect(JSON.stringify(report)).not.toContain(SECRET);
        expect(staticRuntimeLocation(`at ${SECRET} (/private/${SECRET}/MockupOverview.tsx:95:3)`))
            .toEqual({ file: "MockupOverview.tsx", line: 95, column: 3 });
        expect(staticRuntimeLocation(`at ${SECRET} (/private/${SECRET}.tsx:95:3)`)).toBeNull();
        Object.defineProperty(error, "stack", { get() { throw new Error(SECRET); } });
        expect(sanitizedRuntimeError(error).location).toBeNull();
    });
});
