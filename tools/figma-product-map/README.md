# OMR Maker — Product Map Builder

Builds the four-page Figma product map defined in
[the plan](../../docs/superpowers/plans/2026-07-24-figma-product-map.md) and
[the design spec](../../docs/superpowers/specs/2026-07-24-figma-product-map-design.md).

## Why a plugin instead of the Figma MCP

The plan assumes a Figma MCP connector (`whoami` / `create_new_file` / `use_figma`).
That connector is unauthenticated in this environment, so the plan cannot run as
written. This builder reaches the same Plugin API directly. It also has upsides
the MCP route does not: the output is reproducible, reviewable in a diff, and
re-runnable after the app changes.

## Run it

1. Open Figma desktop and **create a new design file**. The builder writes into
   whichever file is open — do not run it inside a file you care about. It only
   ever touches pages named `00 Overview`, `01 Screen Inventory`, `02 User Flows`,
   `03 Design System` and the `OMR Maker / Product Map` variable collection, but
   a fresh file keeps that guarantee trivial.
2. Menu → **Plugins → Development → Import plugin from manifest…**
3. Select `tools/figma-product-map/manifest.json` in this repo.
4. Menu → **Plugins → Development → OMR Maker — Product Map Builder**.

It takes a few seconds. On success it reports the page IDs, route coverage and
representative-frame checks in the closing message.

Re-running is safe and idempotent: it deletes the four pages it owns and rebuilds
them, leaving any other page in the file alone.

## Fonts

Pretendard is preferred and falls back through Noto Sans KR → Apple SD Gothic Neo
→ Spoqa Han Sans Neo → Inter. Install
[Pretendard](https://github.com/orioncactus/pretendard) locally for output that
matches the running app. The closing message names the family it resolved.

## Verify without opening Figma

```bash
node tools/figma-product-map/verify.mjs
```

Runs the builder against a mock of the Plugin API. The mock enforces the real
ordering constraints (`layoutWrap` needs `HORIZONTAL` plus a fixed primary axis,
`characters` needs a loaded font) and approximates Auto Layout closely enough to
assert that sibling frames tile without overlapping. It checks page count and
order, the single top-level wrapper per page, all 16 App Router routes, the 11
scoped colour variables, header stamps, and empty text nodes.

A green run means the builder is sound — not that the visual result is final.
That still needs one look in Figma.

## Keeping it honest

Every colour, radius, shadow, type step and motion value in `code.js` is copied
from `src/app/globals.css` `:root`; the routes come from the App Router tree.
Nothing is eyeballed. When the app's tokens or routes move, update the tables at
the top of `code.js` and re-run `verify.mjs` — the route assertion there reads
from its own independent list, so a drift shows up as a failure rather than a
quietly stale diagram.
