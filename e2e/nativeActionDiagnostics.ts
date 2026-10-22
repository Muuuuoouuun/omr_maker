import { test, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { observeShowcaseRuntimeFailures, startShowcaseEntryDiagnostics } from "./showcaseEntryDiagnostics";

const INPUT_TYPES = ["pointerdown", "pointerup", "pointercancel", "touchstart", "touchend", "touchcancel", "click", "submit"] as const;
type Action = "metrics-next-action" | "teacher-empty-submit" | "student-alternate-entry";
type Delivery = { type: typeof INPUT_TYPES[number]; phase: "capture" | "bubble"; isTrusted: boolean; targetBelongs: boolean; defaultPrevented: boolean };

export function sanitizedNativeDelivery(value: unknown): Delivery | null {
    if (!value || typeof value !== "object") return null;
    const item = value as Record<string, unknown>;
    if (!INPUT_TYPES.includes(item.type as Delivery["type"])
        || (item.phase !== "capture" && item.phase !== "bubble")
        || typeof item.isTrusted !== "boolean" || typeof item.targetBelongs !== "boolean"
        || typeof item.defaultPrevented !== "boolean") return null;
    return { type: item.type as Delivery["type"], phase: item.phase, isTrusted: item.isTrusted,
        targetBelongs: item.targetBelongs, defaultPrevented: item.defaultPrevented };
}

export function sanitizedNativeState(value: unknown) {
    if (!value || typeof value !== "object") return null;
    const item = value as Record<string, unknown>;
    return {
        urlTab: item.urlTab === "exam" || item.urlTab === "student" || item.urlTab === "overview" ? item.urlTab : "other",
        examActive: item.examActive === true, overviewVisible: item.overviewVisible === true,
        disclosureOpen: item.disclosureOpen === true, loginAlertPresent: item.loginAlertPresent === true,
        maxHeartbeatLagMs: typeof item.maxHeartbeatLagMs === "number" && Number.isFinite(item.maxHeartbeatLagMs)
            ? Math.round(Math.max(0, Math.min(1_000_000, item.maxHeartbeatLagMs))) : null,
    };
}

const bindings = new WeakMap<Page, { sink: (value: unknown) => void }>();
let sequence = 0;

/** Observe one real activation and its existing assertions; never replay input or change waits. */
export async function observeNativeAction(page: Page, control: Locator, action: Action, run: () => Promise<void>): Promise<void> {
    if (process.env.OMR_SHOWCASE_ENTRY_DIAGNOSTICS !== "1") return run();
    observeShowcaseRuntimeFailures(page);
    const recorder = startShowcaseEntryDiagnostics(page);
    const native: Delivery[] = [];
    let droppedInputs = 0;
    let observerUnavailable = false;
    let outcome: "passed" | "failed" = "failed";
    let binding = bindings.get(page);
    try {
        if (!binding) {
            binding = { sink: () => {} };
            const bridge = binding;
            await page.exposeBinding("__omrNativeActionDiagnostic", ({ frame }, value: unknown) => {
                if (frame === page.mainFrame()) bridge.sink(value);
            });
            bindings.set(page, binding);
        }
        binding.sink = value => {
            const delivery = sanitizedNativeDelivery(value);
            if (!delivery) return;
            if (native.length < 32) native.push(delivery);
            else droppedInputs += 1;
        };
        await control.evaluate((element, eventTypes) => {
            const targetWindow = window as typeof window & {
                __omrNativeActionDiagnostic?: (value: unknown) => Promise<void>;
                __omrNativeActionCleanup?: () => number;
            };
            targetWindow.__omrNativeActionCleanup?.();
            const observe = (event: Event) => {
                const type = event.type;
                const isTrusted = event.isTrusted;
                const targetBelongs = event.target instanceof Node && (event.target === element || element.contains(event.target));
                // Keep capture/bubble observations separate: React may prevent
                // the default or stop propagation between these two points.
                void targetWindow.__omrNativeActionDiagnostic?.({ type, isTrusted, targetBelongs,
                    phase: event.eventPhase === Event.CAPTURING_PHASE ? "capture" : "bubble",
                    defaultPrevented: event.defaultPrevented }).catch(() => undefined);
            };
            for (const type of eventTypes) {
                document.addEventListener(type, observe, { capture: true, passive: true });
                document.addEventListener(type, observe, { capture: false, passive: true });
            }
            let previous = performance.now();
            let maxLag = 0;
            const heartbeat = setInterval(() => {
                const now = performance.now();
                maxLag = Math.max(maxLag, now - previous - 100);
                previous = now;
            }, 100);
            targetWindow.__omrNativeActionCleanup = () => {
                clearInterval(heartbeat);
                for (const type of eventTypes) document.removeEventListener(type, observe, true);
                for (const type of eventTypes) document.removeEventListener(type, observe, false);
                delete targetWindow.__omrNativeActionCleanup;
                return Math.round(maxLag);
            };
        }, [...INPUT_TYPES]);
    } catch { observerUnavailable = true; }
    try {
        await run();
        outcome = "passed";
    } finally {
        if (binding) binding.sink = () => {};
        try {
            const report = await recorder.finish(outcome);
            let timer: ReturnType<typeof setTimeout> | undefined;
            let state: unknown = null;
            try {
                state = await Promise.race([
                    page.evaluate(() => {
                        const targetWindow = window as typeof window & { __omrNativeActionCleanup?: () => number };
                        const maxHeartbeatLagMs = targetWindow.__omrNativeActionCleanup?.() ?? null;
                        const visible = (element: Element | null) => {
                            if (!element) return false;
                            const rect = element.getBoundingClientRect();
                            const style = getComputedStyle(element);
                            return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
                        };
                        const tab = new URLSearchParams(location.search).get("tab");
                        const tabs = document.querySelectorAll(".mockup-dashboard-tabs button");
                        return {
                            urlTab: tab === "exam" || tab === "student" || tab === "overview" ? tab : "other",
                            examActive: tabs[1]?.getAttribute("aria-pressed") === "true",
                            overviewVisible: visible(document.querySelector('[aria-label="데모 계정 대시보드 개요"]')),
                            disclosureOpen: document.querySelector<HTMLDetailsElement>(".student-alternate-entry")?.open === true,
                            loginAlertPresent: document.querySelector('form[aria-label="교사 로그인"] [role="alert"]') !== null,
                            maxHeartbeatLagMs,
                        };
                    }),
                    new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 750); }),
                ]);
            } finally { if (timer !== undefined) clearTimeout(timer); }
            const info = test.info();
            const testKey = createHash("sha256").update(info.testId).digest("hex").slice(0, 16);
            const output = JSON.stringify({
                phase: "interaction", action, testKey, repeatEachIndex: info.repeatEachIndex, retry: info.retry,
                native, droppedInputs, observerUnavailable, state: sanitizedNativeState(state), report,
            });
            console.log("OMR_NATIVE_ACTION_DIAGNOSTIC " + output);
            await info.attach(`native-action-${action}-${sequence++}`, { body: Buffer.from(output), contentType: "application/json" });
        } catch {
            console.warn("Native action diagnostics could not be saved.");
        }
    }
}
