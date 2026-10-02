# CLAUDE.md

Project-level guidance for working in this repo. Kept short on purpose — add sections as real
conventions emerge, don't front-load speculative process docs.

## Design system

Before writing new inline styles or CSS — colors, font sizes, letter-spacing, motion timing,
status pills/badges — read **[docs/design-system.md](docs/design-system.md)** and use its tokens
(`src/app/globals.css` `:root`) instead of picking a new value by eye. That file exists because
`globals.css` grew 7x over the project's history almost entirely from one-off inline values;
reusing the scale is what keeps it from happening again.

Three rules worth internalizing even without opening the doc:
- Korean text (nearly all visible copy) renders in Pretendard automatically via inheritance from
  `body` — you don't need to set font-family yourself. Numbers/scores use Geist via the
  `.numeric-emphasis` class. Don't apply Latin-style heavy negative letter-spacing to Korean
  headings.
- Never compose `--font-pretendard` / `--font-geist-sans` into a new intermediate custom property
  in `:root` (e.g. a `--font-sans`-style alias). Next.js scopes those two variables to `<body>`'s
  className; referencing them through a `:root`-level alias resolves to invalid above `<body>` and
  silently drops the whole `font-family` declaration (the entire page falls back to browser-default
  serif — this actually happened once). Reference them directly at the point of use instead.
- `--error` is for system/sync failures; `--grade-red` is for exam correctness (wrong-answer
  counts, marking). They read as different things to a user — don't merge them.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
