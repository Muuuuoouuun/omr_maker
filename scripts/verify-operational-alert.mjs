#!/usr/bin/env node

import { runOperationalAlertCli } from "./operational-alert-core.mjs";

process.exitCode = await runOperationalAlertCli({
    argv: process.argv.slice(2),
    env: process.env,
});
