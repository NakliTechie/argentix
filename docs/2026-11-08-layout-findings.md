# Layout findings, 2026-11-08

Status: Batch A closed; Batch B checked in Chrome. Run on the author's Mac with spektrafilm commit `3bb2c2d` (version 0.34). This replaces the Velvia rows and the exposure default in `2026-11-05-bake-findings.md`.

## Decisions
- **Layout:** the `4lut` chain, plus two extra tables per negative stock that hold the rate of change of print exposure with the yellow and magenta filters. Sliders then need no rebake.
- **Film exposure:** an offset on the film log-E wire, between tables L1 and L2. The printer's correction is a stored curve, added on the print log-E wire.
- **Print exposure:** an offset on the print log-E wire, between L3 and L4.
- **Filters:** L3 + y × dL3/dy + m × dL3/dm. One offset per channel gave up to 0.06 worst-pixel error on saturated colours, so the first-order tables replaced it.
- **Slide film:** Velvia is viewed directly (`scan_film`), with tables L1, L2 and one scan table. Printing it on negative paper inverts the image, so the 5 November Velvia tables were numerically close to the pipeline and wrong as pictures. Print exposure and filters do not apply and the page hides them.
- **Input gain:** `stops_above_midgray=None`. The baker's "auto" value overexposes sRGB photos by about 1.5 stops, which washed out Velvia.
- **Wires:** the film log-E wire is floored at -3 before the 0.7 headroom, because the baker's probe reaches -10 at pure black and leaves 33 samples across 11 log units. Density range is measured at both ends of the exposure slider.

## Results: tables against the per-pixel pipeline
`scripts/inject_test.py`, 12 images (`docs/slider-results.json`), 33³ tables, 55 settings, 0 to 1 scale. Worst figure for each row across its settings:

| Setting | Portra 400 mean / max | Ektar 100 mean / max | Velvia 100 mean / max |
|---|---|---|---|
| No slider moved | 0.0013 / 0.0132 | 0.0015 / 0.0134 | 0.0022 / 0.0175 |
| Film exposure ±2 stops | 0.0014 / 0.0131 | 0.0017 / 0.0138 | 0.0025 / 0.0225 |
| Film exposure ±2, printer corrected | 0.0023 / 0.0184 | 0.0023 / 0.0220 | does not apply |
| Print exposure ±1 stop | 0.0020 / 0.0187 | 0.0021 / 0.0162 | does not apply |
| Y and M filters ±20 CC, first-order tables | 0.0019 / 0.0178 | 0.0020 / 0.0152 | does not apply |

Test images are 9 photographs, a colour chart, a saturated ramp and a Hubble field, all from local packages. The set has few real saturated highlights beyond the ramp.

## Results: the page against the pipeline
Chrome through the agent tools, `scripts/compare_browser.py` and `scripts/compare_effects.py`:

- Tables in WebGL2 on the sample photo: mean 0.0015 to 0.0027, max 0.0160, across 7 stock and setting combinations.
- Grain on flat grey, 6 levels, Portra 400 and Velvia 100: page and pipeline noise agree per channel within 0.0005 in most bands. The worst bands are the darkest and lightest, where 8-bit rounding is the same size as the noise.
- Grain scales with the long edge: measured sigma doubles from 2048 to 4096 pixels, so the page scales one calibration curve.
- Halation at a white disc on dark, red excess just outside the edge: pipeline 0.0343, page 0.0358. Worst pixel error fell from 0.2685 without halation to 0.0275 with it.
- A 6000×4000 photo rendered in 1.6 s on this Mac with no GL errors, while other sessions used the machine. This is an observation, not a benchmark.

## Results: the live site
Headless Chrome against `https://argentix.naklitechie.com/` with the cache disabled, from this Mac: first render 2,166 ms, no console errors, so the content security policy allows every path used. All three stocks loaded, a photo loaded through `load_photo`, and `render_photo` returned a JPEG. `README.md`, `scripts/`, `plan/`, `wrangler.jsonc` and `.git/` return 404.

A cold Codex review found 13 issues in the page code. I fixed 13 of them: races between photo, stock and export work (one serial queue), start-up failures, unchecked decoding, GPU allocation failure (retry at a smaller size, 48 MP cap), bitmap release, table length check, command history bound and the GPL notice. Only the ordering fixes were tested; the allocation retry never ran, because this Mac did not run out of GPU memory.

## Limits
- The pipeline's grain step also softens film density by 0.65 pixels. The page adds noise only, so a grainy render is slightly sharper than the pipeline's.
- Three spatial effects are not modelled: DIR coupler diffusion, lens blur, scanner unsharp mask. On the sample, turning coupler diffusion on moves the pipeline by up to 0.08 at edges.
- Highlight boost and auto exposure are image-global and off.
- Only sRGB in and out. Wide-gamut photos convert to sRGB in the browser.
- Checked in one Chrome on one Mac. The built-in browser pane reported no WebGL during this session, so that pane cannot run the page. No phone GPU was tested; the phone layout was checked at 390 px width.

## Reproduce
```bash
python -I scripts/inject_test.py out.json kodak_portra_400:kodak_portra_endura -- photos/*.png
python -I scripts/bake_tables.py tables portra400:kodak_portra_400:kodak_portra_endura
```
Use the spektrafilm virtual environment from `2026-11-05-bake-findings.md`.
