import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isTeacherMutationAuthorized } from "./teacherMutationAuthorization";
import { MOCKUP_TEACHER_IDENTITY } from "./mockupAccount";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("production showcase session contract", () => {
    it("mints and persists one explicit client-safe mockup session snapshot", () => {
        const auth = source("src/app/actions/auth.ts");
        const page = source("src/app/page.tsx");
        expect(auth).toContain('sessionAuthority: "mockup"');
        expect(auth).toMatch(/startMockupTeacherSession[\s\S]*session:\s*createTeacherSession/);
        expect(page).toMatch(/handleMockupLogin[\s\S]*saveTeacherSessionSnapshot\(res\.session\)/);
        expect(page).not.toMatch(/handleMockupLogin[\s\S]*saveTeacherSessionWithIdentity\(res\.token, res\.teacher\)/);
    });

    it("does not expose an interactive showcase login button before hydration", () => {
        const page = source("src/app/page.tsx");

        expect(page).toContain("const [isHydrated, setIsHydrated] = useState(false)");
        expect(page).toMatch(/useEffect\(\(\) => \{[\s\S]*?setIsHydrated\(true\)/);
        expect(page).toContain("disabled={!isHydrated || mockupLoginPending}");
    });

    it("keeps both server-rendered role entry cards inert until hydration", () => {
        const page = source("src/app/page.tsx");
        const roleSelection = page.slice(
            page.indexOf("{/* ── Role Selection"),
            page.indexOf('{role === "none" && recentStudentSession'),
        );

        expect(roleSelection.match(/disabled=\{!isHydrated\}/g)).toHaveLength(2);
    });

    it("keeps showcase out of workspace bootstrap and the direct create surface", () => {
        const teacherLayout = source("src/app/teacher/layout.tsx");
        const createLayout = source("src/app/create/layout.tsx");
        expect(teacherLayout).toContain("allowMockup: true");
        expect(createLayout).toContain("allowMockup: true");
        expect(teacherLayout).toContain('serverSession.sessionAuthority !== "mockup"');
        expect(createLayout).toContain('serverSession.sessionAuthority === "mockup"');
        expect(createLayout).toContain('redirect("/teacher/dashboard?showcase=1")');
        expect(createLayout.indexOf('serverSession.sessionAuthority === "mockup"'))
            .toBeLessThan(createLayout.indexOf("const bootstrapResult"));
        expect(isTeacherMutationAuthorized(MOCKUP_TEACHER_IDENTITY)).toBe(false);
        const analyze = source("src/app/actions/analyzeKey.ts");
        const aiGuard = analyze.split("async function requireTeacherAiAccess")[1]
            ?.split("function buildAnswerImageParts")[0] || "";
        expect(aiGuard.indexOf("isTeacherMutationAuthorized(serverSession)"))
            .toBeLessThan(aiGuard.indexOf("applyDurableRateLimit"));
        const notifications = source("src/app/actions/teacherNotifications.ts");
        expect(notifications).toContain("notificationActionContext(true)");
        for (const name of readdirSync(resolve(process.cwd(), "src/app/actions"))) {
            if (!name.endsWith(".ts")) continue;
            if (name === "premiumAccess.ts") continue;
            expect(source(`src/app/actions/${name}`), name).not.toContain("allowMockup: true");
        }
        const premiumAccess = source("src/app/actions/premiumAccess.ts");
        expect(premiumAccess).toMatch(/getServerPlanSnapshot[\s\S]*accessAndStore\(\{ allowMockup: true \}\)/);
        expect(premiumAccess.match(/allowMockup: true/g)).toHaveLength(1);
    });
});
