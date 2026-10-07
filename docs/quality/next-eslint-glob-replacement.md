# Next ESLint glob dependency replacement

`eslint-config-next` 16.3.8 loads `@next/eslint-plugin-next`, whose root-directory
utility imports `fast-glob`. The only call is `globSync(pattern,
{ onlyDirectories: true })`. The repository otherwise has no fast-glob consumer.
Its micromatch dependency brings in braces 3.0.3 and
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).

The scoped override resolves this single consumer to the private local
`scripts/next-eslint-glob-adapter` package. A root dev dependency makes the
local package path reproducible across clean npm installs. The adapter uses
[tinyglobby](https://github.com/SuperchupuDev/tinyglobby) 0.2.17, which was already
present in the tooling tree and depends on fdir/picomatch instead of braces.
It restores fast-glob's non-expanding directory matching, absolute-pattern
outputs and absence of a trailing separator. An unexpected caller contract
throws an error rather than silently suppressing lint checks.

The adapter is ESM and can be loaded synchronously by the Next plugin's CommonJS
import on the project's supported Node >=22.13.0 runtime. It has no asynchronous
module initialization. This is a narrow adapter, not a general fast-glob API.
Reassess it when upgrading the pinned Next ESLint plugin.

`scripts/next-eslint-glob-compatibility.test.ts` exercises the actual plugin's
root-directory utility: default root, directory-only wildcard, brace/extglob
patterns, arrays and unmatched roots. It also runs the real Next rules to prove
that invalid internal HTML links still produce errors and image elements still
produce warnings. Changed API options are rejected explicitly.

The lock no longer includes micromatch or braces. Production and desktop/build
dependency audits pass with their existing severity thresholds and policy.
No waiver, allowlist, audit skip or lint-rule disable was added.
