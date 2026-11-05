# Bake findings, 2026-11-05

Status: first check done, one photo. Picks up at "Next steps". Everything here was run on the author's Mac (CPU only) with spektrafilm commit `3bb2c2d` (package version 0.34).

## What the tool offers
- `spektrafilm-lut list film|print|input|output|target`: 20 films, 8 papers, 26 input and 10 output colour spaces, one delivery target (Lumix real-time V-Log).
- Layouts (`--topology`):
  - `1lut`: one table, scene RGB to output RGB.
  - `3lut`: film exposure, film development, then print and scan combined (2 + N tables for N papers). Grain can be injected on the film-density step.
  - `4lut`: as 3lut but the enlarger step is exposed, so diffusion filters, dodge and burn can be injected.
- Defaults that change the result: stops-above-midgray "auto" (4 stops for encoded sRGB, so output leans brighter than the source), and ACES-style input gamut compression plus `cam16ucs` output compression.

## Results
- Bake time: about 4 to 6 s wall per table, including start-up. Table size: about 1.4 MB as `.cube` text.
- Accuracy of a 33³ `1lut` (sRGB in, sRGB out) against the same pipeline run per pixel (`lut_mode`: grain, halation and blur off), on one 667x500 photo (`img/test/portrait_leaves_32bit_linear_prophoto_rgb.tif` in the spektrafilm repo), values on a 0 to 1 scale:

| Film | Paper | Mean diff | p99 | Max |
|---|---|---|---|---|
| Portra 400 | Portra Endura | 0.0014 | 0.0059 | 0.0072 |
| Ektar 100 | Portra Endura | 0.0015 | 0.0058 | 0.0080 |
| Ektar 100 | Kodak 2383 | 0.0024 | 0.0100 | 0.0139 |
| Velvia 100 | Portra Endura | 0.0010 | 0.0105 | 0.0161 |
| Velvia 100 | Kodak 2383 | 0.0011 | 0.0099 | 0.0141 |

- The first attempt gave a mean difference of 0.077. The cause was the reference: it left out the baker's exposure gain and gamut compression. `scripts/compare_lut.py` now calls the baker's own helpers.
- Per-pixel run: 0.7 to 1.1 s for 0.33 MP. Applying the table in numpy: 0.03 s.

## Why not bake on the GPU
A 33³ table is 35,937 points, so a bake takes seconds on the CPU. spektrafilm has no GPU code; a port (the Vulkan port in vkdt is the reference) would save seconds on a step run a few hundred times. WebNN runs neural networks, so it does not fit. WebGPU compute is the right tool for a later "exact mode" (see Next steps).

## Licence (read 2026-11-05)
`SPEKTRAFILM_LICENSE.txt` (preamble v1.1, 2026-05-28) puts profiles, LUTs and direct derivatives under CC BY-SA 4.0, although the README calls the LUT licence "no resale". Required in every table and in the UI: Andrea Volpato as author, the repo link, the licence notice, and a modified-by note if changed. Requests, not terms: no paid LUT packs, no commercial AI training on tables or outputs, no "spektrafilm" in product branding ("uses spektrafilm LUTs" is fine). I read the preamble in full and the CC BY-SA text only as standard.

## Limits of this check
One photo; no grain or halation comparison; `3lut` and `4lut` not tested for accuracy; only sRGB in and out; paper choice for slide film (Velvia) untested for meaning.

## Next steps
1. Test whether Y/M filter shifts and print exposure can be injected on `3lut` or `4lut`, or need a rebake.
2. Repeat the compare on several photos, including saturated highlights (Velvia's worst pixels).
3. Convert tables to a compact binary form with the attribution carried inside.
4. Build the first-slice page: Portra 400, Ektar 100, Velvia 100, one paper; upload, switch stock, grain on or off, download.
5. Later: WebGPU "exact mode" of the full pipeline.

## Reproduce
```bash
git clone https://github.com/andreavolpato/spektrafilm && cd spektrafilm
uv venv --python 3.13 .venv && VIRTUAL_ENV=.venv uv pip install -e .
.venv/bin/spektrafilm-lut build --film kodak_portra_400 --print kodak_portra_endura \
  --input srgb --output srgb --topology 1lut --resolution 33 --out out
.venv/bin/python -I /path/to/argentix/scripts/compare_lut.py kodak_portra_400 kodak_portra_endura \
  out/*/lut_*.cube img/test/portrait_leaves_32bit_linear_prophoto_rgb.tif
```
