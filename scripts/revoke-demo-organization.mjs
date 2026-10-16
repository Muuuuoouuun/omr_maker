#!/usr/bin/env node
import { runDemoRevocationCli } from "./operator-provisioning-cli-core.mjs";
process.exitCode = await runDemoRevocationCli({ argv:process.argv.slice(2), env:process.env });
