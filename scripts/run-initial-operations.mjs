import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveInitialOperationsConfig } from "./initial-operations-core.mjs";
import {
    INITIAL_OPERATIONS_CONTROL_PRODUCTION_PATHS,
    runInitialOperationsStagingLoad,
} from "./initial-operations-driver.mjs";
import {
    evaluateInitialOperationsEvidenceBundle,
    initialOperationsRunSucceeded,
    serializeInitialOperationsEvidenceBundle,
} from "./initial-operations-evidence-bundle.mjs";
import { runInitialOperationsPreflight } from "./verify-initial-operations.mjs";

function clean(value) {
    return typeof value === "string" ? value.trim() : "";
}

async function main() {
    let resolved;
    try {
        resolved = resolveInitialOperationsConfig({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd() });
    } catch {
        process.stdout.write(`${JSON.stringify({ status: "unverified", code: "invalid_staging_config" })}\n`);
        process.exitCode = 2;
        return;
    }
    const runId = clean(process.env.OMR_INITIAL_OPS_RUN_ID).toLowerCase();
    const runChallenge = clean(process.env.OMR_INITIAL_OPS_RUN_CHALLENGE).toLowerCase();
    const collectorModulePath = clean(process.env.OMR_INITIAL_OPS_COLLECTOR_MODULE);
    if (!/^[a-z0-9][a-z0-9-]{7,63}$/.test(runId)
        || !/^[a-f0-9]{32,128}$/.test(runChallenge)
        || !isAbsolute(collectorModulePath)) {
        process.stdout.write(`${JSON.stringify({ status: "unverified", code: "missing_external_state" })}\n`);
        process.exitCode = 2;
        return;
    }
    let collectors;
    try {
        const provider = await import(pathToFileURL(collectorModulePath).href);
        collectors = await provider.createInitialOperationsCollectors?.({ runId, runChallenge });
    } catch {
        process.stdout.write(`${JSON.stringify({ status: "unverified", code: "missing_external_collectors" })}\n`);
        process.exitCode = 2;
        return;
    }
    await mkdir(resolved.outputDirectory, { recursive: false, mode: 0o700 });
    const config = {
        ...resolved,
        runId,
        runChallenge,
        loadToken: resolved.loadToken,
        readinessToken: resolved.readinessToken,
        externalState: {
            environment: "staging",
            appOrigin: resolved.baseUrl,
            storageOrigin: resolved.stagingSupabaseUrl,
            databaseProjectRefHash: resolved.stagingProjectRefHash,
            controlPlaneVersion: 2,
            productionWorkloadPaths: INITIAL_OPERATIONS_CONTROL_PRODUCTION_PATHS,
        },
    };
    const probes = await runInitialOperationsPreflight(config);
    await writeFile(
        join(resolved.outputDirectory, "preflight.json"),
        `${JSON.stringify({
            target: {
                environment: "staging",
                build: resolved.expectedBuild,
                fixture: resolved.fixture,
                databaseProjectRefHash: resolved.stagingProjectRefHash,
            },
            probes,
        })}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    const result = await runInitialOperationsStagingLoad(config, { collectors });
    let evaluation;
    if (result.status === "collected"
        && result.code === "evaluation_required"
        && result.cleanupVerified === true) {
        await serializeInitialOperationsEvidenceBundle(resolved.outputDirectory, {
            runId,
            runChallenge,
            databaseProjectRefHash: resolved.stagingProjectRefHash,
            databaseEvidence: result.databaseEvidence,
            rssEvidence: result.rssEvidence,
        });
        evaluation = await evaluateInitialOperationsEvidenceBundle(resolved.outputDirectory, {
            expectedBuild: resolved.expectedBuild,
            expectedDatabaseProjectRefHash: resolved.stagingProjectRefHash,
        });
    }
    const succeeded = initialOperationsRunSucceeded(result, evaluation);
    process.stdout.write(`${JSON.stringify({
        status: succeeded ? "passed" : evaluation?.status ?? "unverified",
        code: succeeded ? "initial_operations_verified" : result.code,
        cleanupVerified: result.cleanupVerified,
        evaluation,
    })}\n`);
    process.exitCode = succeeded ? 0 : 2;
}

main().catch(() => {
    process.stdout.write(`${JSON.stringify({ status: "unverified", code: "runner_failed" })}\n`);
    process.exitCode = 2;
});
