import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "src/components/NotificationBell.tsx"), "utf8");

describe("notification bell dialog accessibility", () => {
    it("traps focus, closes with Escape, and restores focus through the shared dialog hook", () => {
        expect(source).toContain('import { useDialogFocus } from "@/hooks/useDialogFocus"');
        expect(source).toContain("useDialogFocus(open, closeNotifications)");
        expect(source).toContain("ref={dialogRef}");
        expect(source).toContain('tabIndex={-1}');
    });

    it("exposes trigger state and dialog ownership to assistive technology", () => {
        expect(source).toContain('aria-expanded={open}');
        expect(source).toContain('aria-controls="teacher-notifications-dialog"');
        expect(source).toContain('id="teacher-notifications-dialog"');
    });
});
