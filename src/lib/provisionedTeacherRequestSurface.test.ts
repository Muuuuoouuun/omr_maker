import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("provisioned teacher request surfaces", () => {
    it("branches login on the server-only identity mode and skips account bootstrap", () => {
        const auth = source("src/app/actions/auth.ts");
        expect(auth).toContain("resolveTeacherIdentityMode");
        expect(auth).toContain("lookupProvisionedTeacherLogin");
        expect(auth).toContain('identityMode === "provisioned_only"');
        expect(auth).toContain('sessionAuthority: "account"');
        expect(auth).toContain("organizationId: account.organizationId");
        expect(auth).toContain("accountSessionGeneration: account.sessionGeneration");
        expect(auth).toContain('if (result.sessionAuthority !== "account")');
        expect(auth).toContain("session: createTeacherSession");
        expect(source("src/app/page.tsx")).toContain("saveTeacherSessionSnapshot(res.session)");
    });

    it("never bootstraps provisioned account layouts", () => {
        for (const path of ["src/app/teacher/layout.tsx", "src/app/create/layout.tsx"]) {
            const layout = source(path);
            expect(layout).toContain('serverSession.sessionAuthority !== "account"');
            expect(layout).toContain("bootstrapWorkspaceWithServiceRole");
        }
    });

    it("routes all current TypeScript entitlement reads through one effective-plan gateway", () => {
        const files = [
            "src/lib/serverPlan.ts",
            "src/app/actions/studentAttemptSession.ts",
            "src/app/actions/remoteAssets.ts",
            "src/app/actions/studentExam.ts",
        ].map(source);
        for (const file of files) expect(file).toContain("readEffectiveWorkspacePlan");
        expect(files.join("\n")).not.toContain('.select("plan")');
    });

    it("allows only the exact lowercase pilot organization shape for student session issuance", () => {
        const action = source("src/app/actions/studentSession.ts");
        expect(action).toContain("pilot_org_[a-f0-9]{24}");
        expect(action).toContain("WORKSPACE_ID_PATTERN.test(workspaceId)");
    });
});
