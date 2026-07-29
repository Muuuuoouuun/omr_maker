import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DESKTOP_AUDIT_WAIVER_EXPIRES_AT,
  evaluateDesktopDependencyAudit,
} from "./desktop-dependency-audit-policy.mjs";

const root = resolve(import.meta.dirname, "..");
const audit = spawnSync(
  "npm",
  ["audit", "--package-lock-only", "--json"],
  { cwd: root, encoding: "utf8" },
);

if (audit.error || (audit.status !== 0 && audit.status !== 1)) {
  const detail = [audit.error?.message, audit.stderr, audit.stdout].filter(Boolean).join("\n");
  throw new Error(`npm audit execution failed independently of dependency findings${detail ? `\n${detail}` : ""}`);
}

let payload;
try {
  payload = JSON.parse(audit.stdout);
} catch (error) {
  throw new Error(`npm audit returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
}

const result = evaluateDesktopDependencyAudit(payload, new Date());
if (!result.ok) {
  throw new Error(`Desktop/build dependency audit policy failed:\n- ${result.errors.join("\n- ")}`);
}

if (result.waiverUsed) {
  const packageLock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
  const affectedVersions = result.waivedNodes.map((node) => {
    const version = packageLock.packages?.[node]?.version;
    if (typeof version !== "string") {
      throw new Error(`Cannot resolve waived dependency version for ${node}`);
    }
    return version;
  });
  const versions = [...new Set(affectedVersions)].sort().join(", ");

  console.warn(
    `::warning title=TEMPORARY desktop dependency audit waiver::`
    + `brace-expansion GHSA-mh99-v99m-4gvg remains in legacy build-only trees `
    + `(installed affected versions: ${versions}); waiver expires ${DESKTOP_AUDIT_WAIVER_EXPIRES_AT}.`,
  );
  console.warn(
    "SECURITY WAIVER ACTIVE: upstream remediation is required. "
    + "Upgrade or replace every legacy minimatch consumer, remove this waiver, "
    + "and restore an unqualified full-lock npm audit before expiry.",
  );
}

console.log("DESKTOP_DEPENDENCY_AUDIT_POLICY_OK");
