import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSectionAfterAdvancedToggle } from "@/lib/settingsDisclosureState";
import { isLiveCheckoutUiEnabled, LIVE_CHECKOUT_IMPLEMENTED } from "@/lib/billingCheckoutGate";

const settingsSource = readFileSync(join(process.cwd(), "src/app/teacher/settings/page.tsx"), "utf8");
const billingSource = readFileSync(join(process.cwd(), "src/app/teacher/billing/page.tsx"), "utf8");
const globalCssSource = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

describe("settings and billing simplification", () => {
    it("prioritizes editable settings and keeps operational diagnostics in an accessible disclosure", () => {
        expect(settingsSource).toContain('useState<Section>("exam-defaults")');
        expect(settingsSource).toContain("PRIMARY_SECTIONS");
        expect(settingsSource).toContain("ADVANCED_SECTIONS");
        expect(settingsSource).toContain('className="settings-advanced-disclosure"');
        expect(settingsSource).toContain("open={advancedOpen}");
        expect(settingsSource).toContain("고급 · 운영");
        expect(settingsSource).toContain("window.location.hash");
        expect(settingsSource).toContain('minHeight: 44');
    });

    it("moves an active advanced section to the editable default when its disclosure closes", () => {
        expect(resolveSectionAfterAdvancedToggle("api", false)).toBe("exam-defaults");
        expect(resolveSectionAfterAdvancedToggle("security", false)).toBe("exam-defaults");
        expect(resolveSectionAfterAdvancedToggle("api", true)).toBe("api");
        expect(resolveSectionAfterAdvancedToggle("theme", false)).toBe("theme");
        expect(settingsSource).toContain("resolveSectionAfterAdvancedToggle(section, event.currentTarget.open)");
    });

    it("summarizes profile readiness before exposing all retained status details", () => {
        expect(settingsSource).toContain('className="settings-profile-summary"');
        expect(settingsSource).toContain("PROFILE_STATUS_ITEMS");
        expect(settingsSource).toContain("PROFILE_STATUS_ITEMS.length");
        expect(settingsSource).toContain('<CapabilityStatusList items={PROFILE_STATUS_ITEMS} />');
    });

    it("keeps plan changes transactional only when live checkout is ready", () => {
        expect(LIVE_CHECKOUT_IMPLEMENTED).toBe(false);
        expect(isLiveCheckoutUiEnabled(true)).toBe(false);
        expect(isLiveCheckoutUiEnabled(false)).toBe(false);
        expect(billingSource).toContain("isLiveCheckoutUiEnabled(paymentProviderReadiness.canStartLiveCheckout)");
        expect(billingSource).toContain("liveCheckoutEnabled ? (");
        expect(billingSource).toContain("기능 미리보기");
        expect(billingSource).toContain("실결제 연동 전");
        expect(billingSource).toContain("allInvoices.length > 0 &&");
    });

    it("keeps billing cycle and record download targets at least 44px tall", () => {
        expect(billingSource).toContain('className="billing-cycle-option"');
        expect(billingSource).toContain('className="billing-history-download-all"');
        expect(billingSource).toContain('className="billing-history-download-item"');
        expect(globalCssSource).toContain(".billing-cycle-option,");
        expect(globalCssSource).toContain(".billing-history-download-all,");
        expect(globalCssSource).toContain(".billing-history-download-item {");
        expect(globalCssSource).toContain("min-height: 44px;");
    });
});
