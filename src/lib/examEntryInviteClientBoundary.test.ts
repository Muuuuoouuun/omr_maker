import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("exam invite client boundary", () => {
    it("keeps the tab handoff free of Node crypto and server token modules", () => {
        const handoff = readFileSync(join(process.cwd(), "src/lib/examEntryInviteHandoff.ts"), "utf8");
        const contract = readFileSync(join(process.cwd(), "src/lib/examEntryInviteTokenContract.ts"), "utf8");
        expect(handoff).toContain('from "@/lib/examEntryInviteTokenContract"');
        expect(handoff).not.toContain('from "@/lib/examEntryInvite"');
        expect(`${handoff}\n${contract}`).not.toContain("node:crypto");
    });
});
