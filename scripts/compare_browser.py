# Compare PNGs rendered by the page (window.argentix.tools.render_photo) with the spektrafilm pipeline on the same photo.
# Usage: python -I compare_browser.py <browser.json> <photo.png>   (needs the spektrafilm venv)
# browser.json maps '<stock>_<label>' to a PNG data URL. Findings: docs/2026-11-08-layout-findings.md
import base64, io, json, os, sys, numpy as np, imageio.v3 as iio
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from inject_test import pipeline, is_slide, stats, init_params, digest_params, SimulationPipeline
from spektrafilm_lut_creator.color_spaces import decode_cctf, encode_cctf

PAPER = 'kodak_portra_endura'
FILMS = dict(portra400='kodak_portra_400', ektar100='kodak_ektar_100', velvia100='fujifilm_velvia_100')
SETTINGS = dict(base={}, ev15=dict(ev=1.5, compensate=True), evm1=dict(ev=-1.0), p05=dict(pe=2 ** 0.5), ym=dict(y=15.0, m=-10.0))

def png(url):
    return iio.imread(io.BytesIO(base64.b64decode(url.split(',', 1)[1])))[..., :3] / 255.0

def spatial(film, grain, halation, couplers=False):
    # the real pipeline with only the named spatial effects on
    p = init_params(film_profile=film, print_profile=PAPER)
    p.io.scan_film = is_slide(film)
    p.io.input_color_space = 'sRGB'; p.io.output_color_space = 'sRGB'
    p.io.input_cctf_decoding = False; p.io.output_cctf_encoding = False
    p.camera.auto_exposure = False
    p.enlarger.print_exposure_compensation = False
    p.film_render.grain.active = grain
    p.film_render.halation.active = halation
    p.film_render.halation.boost_ev = 0.0
    if not couplers:
        p.film_render.dir_couplers.diffusion_size_um = 0
    p.scanner.white_correction = False; p.scanner.black_correction = False; p.scanner.unsharp_mask = (0.0, 0.0)
    return SimulationPipeline(digest_params(p))

def out(pipe, lin):
    return np.clip(encode_cctf(np.asarray(pipe.process(lin), float), 'sRGB'), 0, 1)

shots = json.load(open(sys.argv[1]))
img = iio.imread(sys.argv[2])[..., :3] / 255.0
lin = decode_cctf(img, 'sRGB').astype(np.float32)
fmt = lambda s: f"mean {s['mean']:.4f} p99 {s['p99']:.4f} max {s['max']:.4f}"
for name, url in shots.items():
    stock, label = name.split('_')
    if label in SETTINGS:
        print(f'{name:22s} tables vs pipeline  ', fmt(stats(png(url), out(pipeline(FILMS[stock], PAPER, **SETTINGS[label]), lin))), flush=True)
film = FILMS['portra400']
print('halation vs real halation    ', fmt(stats(png(shots['portra400_halation']), out(spatial(film, False, True), lin))))
print('no halation vs real halation ', fmt(stats(png(shots['portra400_base']), out(spatial(film, False, True), lin))), '(size of the effect)')
print('halation vs real + couplers  ', fmt(stats(png(shots['portra400_halation']), out(spatial(film, False, True, True), lin))))
