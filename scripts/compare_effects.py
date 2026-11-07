# Grain on flat grey bands and halation around bright shapes: page render against the spektrafilm pipeline.
# Usage: python -I compare_effects.py <browser2.json>   (needs the spektrafilm venv)
import base64, io, json, os, sys, numpy as np, imageio.v3 as iio
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'compare_browser.py')).read().split('shots = json.load')[0]
exec(src)
fmt = lambda r: f"mean {r['mean']:.4f} p99 {r['p99']:.4f} max {r['max']:.4f}"

s = json.load(open(sys.argv[1]))
lin = lambda k: decode_cctf(png(s[k]), 'sRGB').astype(np.float32)
flat = lin('flat_src')
for stock in ('portra400', 'velvia100'):
    ref = out(spatial(FILMS[stock], True, False), flat)
    page = png(s[f'{stock}_flatgrain'])
    for b in range(6):
        sl = (slice(30, -30), slice(b * 200 + 30, b * 200 + 170))
        print(f'{stock} band {b}: level page {page[sl].mean():.3f} pipeline {ref[sl].mean():.3f} | rms page',
              np.round(page[sl].std(axis=(0, 1)), 4), 'pipeline', np.round(ref[sl].std(axis=(0, 1)), 4))
spot = lin('spot_src')
film = FILMS['portra400']
real, clean = out(spatial(film, False, True), spot), out(spatial(film, False, False), spot)
page, pclean = png(s['portra400_spothal']), png(s['portra400_spotclean'])
print('halation effect size: pipeline', fmt(stats(real, clean)), '| page', fmt(stats(page, pclean)))
print('page halation vs pipeline', fmt(stats(page, real)), '| without halation', fmt(stats(pclean, real)))
yy, xx = np.mgrid[0:800, 0:1200]
r = np.hypot(xx - 400, yy - 400)
for lo in (61, 63, 66, 70, 76, 84):
    ring = (r >= lo) & (r < lo + 2)
    print(f'radius {lo}: excess red/green pipeline', np.round((real - clean)[ring].mean(axis=0)[:2], 4), 'page', np.round((page - pclean)[ring].mean(axis=0)[:2], 4))
