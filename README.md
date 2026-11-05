# Argentix

A browser film lab: pick a film stock and print paper, drop in a photo, and see it as that film would have rendered it. Nothing leaves your tab.

Film modeling powered by [spektrafilm](https://github.com/andreavolpato/spektrafilm) by Andrea Volpato.

## Install

TODO: not built yet. Target: open `https://argentix.naklitechie.com` (static site, no account, no upload). Local run steps go here once the first slice exists.

## What it is

Argentix bakes the slow physical film simulation of spektrafilm offline into 33³ colour lookup tables, one per film and paper pair. The browser applies a table with WebGL2, and runs grain and halation as separate shader passes. The ComfyUI pack [ComfyUI-Spektrafilm](https://github.com/jtydhr88/ComfyUI-Spektrafilm) uses the same table-for-colour idea for its live preview.

First slice: Portra 400, Ektar 100 and Velvia 100 on one paper; upload, switch stock, grain on or off, download.

## Credits and licences

- Code: GPL-3.0 (see `LICENSE`), because it builds on spektrafilm, which is GPL-3.0.
- Film profiles: CC BY-SA 4.0, from spektrafilm. Baked tables follow spektrafilm's LUT licence (commercial use and free sharing allowed, no resale); read in full before shipping tables.
- Datasheet-derived look checks draw on [Redlamp](https://github.com/pdcgomes/redlamp) (MPL-2.0), as a reference only.

## Context

Tier: Tool. Standalone site at `argentix.naklitechie.com`, repo `NakliTechie/argentix`, hosted as a static Cloudflare Workers assets project. Muse (a separate NakliTechie photo-filter site) may borrow from it later. Handoff, 2026-11-05: "Bakes spektrafilm film+paper pairs offline into 33^3 LUTs; browser applies them with WebGL2, grain/halation as shader passes; static Cloudflare Workers assets, no server/account. Also draws on Redlamp datasheet looks. Licence GPL-3.0 with credit line 'film modeling powered by spektrafilm'."

First steps: confirm what `spektrafilm-lut` can do (list film and print, table layouts for exposure and filter shifts); read `SPEKTRAFILM_LICENSE.txt` in full; run a bake-and-compare test against the full simulation on real photos.

## Contributor notes: verification budget

- No tests, evals or diagnostics between implementation steps; build the whole batch, then check once at the batch boundary. A batch is one capability family, about a day of work.
- Run only the checks that cover the changed batch; never repeat an unchanged suite.
- Generated test data goes to one temp directory (default cap 5,000 files, 500 MB), preferably one aggregate file, deleted on success, failure and interrupt.
- One diagnostic batch per failure; no new diagnostic script without a written hypothesis.
- No new process tooling until a feature it gates exists.
- Log anything over 50 MB or 1,000 files when it is created.
