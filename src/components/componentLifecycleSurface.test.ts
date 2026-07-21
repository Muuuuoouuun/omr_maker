import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readComponent(relativePath: string): string {
    return readFileSync(path.join(process.cwd(), "src/components", relativePath), "utf8");
}

describe("component lifecycle and keyboard contracts", () => {
    it("clears delayed UI timers when their hosts close or unmount", () => {
        const toast = readComponent("Toast.tsx");
        const installPrompt = readComponent("MobileInstallPrompt.tsx");
        const distributeModal = readComponent("DistributeModal.tsx");

        expect(toast).toContain("removalTimers.forEach(timer => clearTimeout(timer))");
        expect(toast).toContain("removalTimers.clear()");
        expect(installPrompt).toContain("clearVisibilityTimer();");
        expect(installPrompt).toContain('window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt)');
        expect(distributeModal).toContain("window.clearTimeout(copyResetTimerRef.current)");
        expect(distributeModal).toContain("copyResetTimerRef.current = undefined");
    });

    it("removes service-worker listeners and ignores late async registration reads", () => {
        const pwaRegister = readComponent("PWARegister.tsx");

        expect(pwaRegister).toContain("if (!isDisposed && registration) checkForUpdates(registration)");
        expect(pwaRegister).toContain('installingWorker.removeEventListener("statechange", handleStateChange)');
        expect(pwaRegister).toContain("cleanupInstallingWorkerListener?.();");
        expect(pwaRegister).not.toContain('installingWorker.addEventListener("statechange", () =>');
    });

    it("keeps the exam action menu operable and focus-safe from the keyboard", () => {
        const examActionsMenu = readComponent("dashboard/ExamActionsMenu.tsx");

        expect(examActionsMenu).toContain("aria-controls={open ? menuId : undefined}");
        expect(examActionsMenu).toContain('e.key === "ArrowDown"');
        expect(examActionsMenu).toContain('e.key === "ArrowUp"');
        expect(examActionsMenu).toContain('e.key === "Home"');
        expect(examActionsMenu).toContain('e.key === "End"');
        expect(examActionsMenu).toContain("triggerRef.current?.focus()");
    });
});
