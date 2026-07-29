export const DESKTOP_AUDIT_WAIVER_EXPIRES_AT = "2026-09-01T00:00:00.000Z";

const WAIVED_PACKAGE = "brace-expansion";
const WAIVED_ADVISORY_URL = "https://github.com/advisories/GHSA-mh99-v99m-4gvg";
const BLOCKED_SEVERITIES = new Set(["high", "critical"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function malformed(message) {
  return `Malformed npm audit JSON: ${message}`;
}

export function evaluateDesktopDependencyAudit(payload, now = new Date()) {
  const errors = [];
  const waivedNodes = new Set();
  let waiverUsed = false;

  if (
    !isRecord(payload)
    || payload.auditReportVersion !== 2
    || !isRecord(payload.vulnerabilities)
    || !isRecord(payload.metadata)
    || !isRecord(payload.metadata.vulnerabilities)
  ) {
    return {
      errors: [malformed("expected npm audit report version 2")],
      ok: false,
      waivedNodes: [],
      waiverUsed: false,
    };
  }

  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    return {
      errors: ["Desktop dependency audit policy received an invalid evaluation time"],
      ok: false,
      waivedNodes: [],
      waiverUsed: false,
    };
  }

  const vulnerabilities = payload.vulnerabilities;

  function resolveAdvisories(packageName, ancestry = []) {
    if (ancestry.includes(packageName)) {
      return [];
    }

    const vulnerability = vulnerabilities[packageName];
    if (!isRecord(vulnerability) || !Array.isArray(vulnerability.via)) {
      errors.push(malformed(`missing vulnerability details for ${packageName}`));
      return [];
    }

    if (vulnerability.severity === "critical") {
      errors.push(`Critical dependency finding is never waived: ${packageName}`);
    }

    const findings = [];
    for (const source of vulnerability.via) {
      if (typeof source === "string") {
        findings.push(...resolveAdvisories(source, [...ancestry, packageName]));
      } else if (isRecord(source)) {
        findings.push({ advisory: source, packageName });
      } else {
        errors.push(malformed(`invalid advisory source for ${packageName}`));
      }
    }

    return findings;
  }

  for (const [packageName, vulnerability] of Object.entries(vulnerabilities)) {
    if (!isRecord(vulnerability)) {
      errors.push(malformed(`invalid vulnerability entry for ${packageName}`));
      continue;
    }
    if (!BLOCKED_SEVERITIES.has(vulnerability.severity)) continue;

    const findings = resolveAdvisories(packageName);
    if (findings.length === 0) {
      errors.push(malformed(`no advisory identity for ${packageName}`));
      continue;
    }
    for (const finding of findings) {
      const advisory = finding.advisory;
      const exactWaiver = (
        finding.packageName === WAIVED_PACKAGE
        && advisory.name === WAIVED_PACKAGE
        && advisory.dependency === WAIVED_PACKAGE
        && advisory.url === WAIVED_ADVISORY_URL
        && advisory.severity === "high"
        && vulnerability.severity !== "critical"
      );

      if (!exactWaiver) {
        errors.push(
          `Unwaived ${String(advisory.severity || vulnerability.severity)} dependency finding: `
          + `${finding.packageName} ${String(advisory.url || "missing-advisory-url")}`,
        );
        continue;
      }

      waiverUsed = true;
      const waivedVulnerability = vulnerabilities[WAIVED_PACKAGE];
      if (isRecord(waivedVulnerability) && Array.isArray(waivedVulnerability.nodes)) {
        for (const node of waivedVulnerability.nodes) {
          if (typeof node === "string") waivedNodes.add(node);
        }
      }
    }
  }

  if (
    waiverUsed
    && now.getTime() >= new Date(DESKTOP_AUDIT_WAIVER_EXPIRES_AT).getTime()
  ) {
    errors.push(`Temporary dependency audit waiver expired at ${DESKTOP_AUDIT_WAIVER_EXPIRES_AT}`);
  }

  return {
    errors: [...new Set(errors)],
    ok: errors.length === 0,
    waivedNodes: [...waivedNodes].sort(),
    waiverUsed,
  };
}
