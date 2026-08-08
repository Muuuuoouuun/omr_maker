#!/usr/bin/env node

import { runOperatorProvisioningCli } from "./operator-provisioning-cli-core.mjs";

process.exitCode = await runOperatorProvisioningCli({
    argv: process.argv.slice(2),
    env: process.env,
});
