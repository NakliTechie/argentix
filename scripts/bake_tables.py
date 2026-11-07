# Bake the browser's film files: tables/film/<film>.bin.gz (exposure, density, grain, halation; slide films also scan)
# and tables/print/<film>.<paper>.bin.gz (print tables), plus tables/catalog.json. Each file is gzip of a JSON header
# line and delta-coded uint16 tables, and the header carries the attribution CC BY-SA 4.0 requires.
# Usage: python -I bake_tables.py <out_dir> [film ...]   (needs the spektrafilm venv; no films means all of them)
# Layout decision: docs/2026-11-08-layout-findings.md
import gzip, json, os, subprocess, sys, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from inject_test import Chain, init_params, digest_params, SimulationPipeline, is_slide, N

NOTICE = dict(
    work='Film and paper tables baked from spektrafilm profiles',
    author='Andrea Volpato', source='https://github.com/andreavolpato/spektrafilm', source_commit='3bb2c2d',
    licence='CC BY-SA 4.0', licence_url='https://creativecommons.org/licenses/by-sa/4.0/',
    modified='Baked to 33-point tables and re-encoded as delta-coded uint16 by Argentix, https://argentix.naklitechie.com')

GRAIN_BANDS = 16
GRAIN_EDGE = 2048  # long edge of the calibration frame; the page scales sigma by edge / GRAIN_EDGE
EVS = [round(-2 + 0.5 * i, 2) for i in range(9)]

def listing(kind):
    tool = os.path.join(os.path.dirname(sys.executable), 'spektrafilm-lut')
    return subprocess.run([tool, 'list', kind], capture_output=True, text=True, check=True).stdout.split()

def pack(table):
    # per-channel range to uint16, then deltas along the fastest axis so gzip finds the smooth surface
    lo, hi = table.min(axis=(0, 1, 2)), table.max(axis=(0, 1, 2))
    span = np.where(hi > lo, hi - lo, 1.0)
    q = np.round((table - lo) / span * 65535).astype(np.uint16)
    d = q.copy(); d[:, :, 1:, :] = q[:, :, 1:, :] - q[:, :, :-1, :]
    return d.tobytes(), dict(lo=lo.tolist(), hi=(lo + span).tolist())

def write(path, head, chain, names):
    blobs = []
    head.update(notice=NOTICE, size=N, tables=list(names), ranges={})
    for n in names:
        b, r = pack(getattr(chain, n)); blobs.append(b); head['ranges'][n] = r
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with gzip.open(path, 'wb', compresslevel=9) as f:
        f.write(json.dumps(head).encode() + b'\n' + b''.join(blobs))
    return os.path.getsize(path)

def film_params(film, printp):
    p = init_params(film_profile=film, print_profile=printp)
    p.io.scan_film = is_slide(film)
    p.io.input_color_space = 'sRGB'; p.io.output_color_space = 'sRGB'
    p.io.input_cctf_decoding = False; p.io.output_cctf_encoding = False
    p.camera.auto_exposure = False
    p.film_render.halation.active = False
    p.scanner.unsharp_mask = (0.0, 0.0)
    return digest_params(p)

def grain_curve(film, printp):
    # flat grey bands through the real grain model: density noise per channel against mean density
    w = GRAIN_EDGE // GRAIN_BANDS
    levels = np.geomspace(0.004, 4.0, GRAIN_BANDS)
    frame = np.repeat(np.repeat(levels, w)[None, :, None], 256, axis=0).repeat(3, axis=2).astype(np.float32)
    cmy = np.asarray(SimulationPipeline(film_params(film, printp)).process(frame, collect='cmy_film'), float)
    rows = []
    for i in range(GRAIN_BANDS):
        band = cmy[16:-16, i * w + 16:(i + 1) * w - 16]
        z = band - band.mean(axis=(0, 1))
        rho = (z[:, 1:] * z[:, :-1]).mean(axis=(0, 1)) / np.maximum(z.var(axis=(0, 1)), 1e-12)
        rows.append(dict(density=band.mean(axis=(0, 1)).tolist(), sigma=band.std(axis=(0, 1)).tolist(), rho=rho.tolist()))
    return rows

def halation(film, printp):
    # digest_params applies the stock's own halation strength, so read after it
    h = digest_params(init_params(film_profile=film, print_profile=printp)).film_render.halation
    keys = ('scatter_core_um', 'scatter_tail_um', 'scatter_tail_weight', 'halation_strength', 'halation_first_sigma_um',
            'halation_n_bounces', 'halation_bounce_decay', 'halation_renormalize', 'active')
    return {k: (list(v) if isinstance(v, tuple) else v) for k, v in ((k, getattr(h, k)) for k in keys)}

def main():
    out, chosen = sys.argv[1], sys.argv[2:]
    papers = listing('print')
    catalog_path = f'{out}/catalog.json'
    # a full bake starts clean, so films dropped upstream leave the catalog; a named bake updates it
    films = {f['id']: f for f in json.load(open(catalog_path))['films']} if chosen and os.path.exists(catalog_path) else {}
    for film in chosen or listing('film'):
        info = init_params(film_profile=film).film.info
        slide = info.type == 'positive'
        default = info.target_print if info.target_print in papers else 'kodak_portra_endura'
        base = Chain(film, default)
        head = dict(id=film, slide=slide, grain=dict(edge=GRAIN_EDGE, bands=grain_curve(film, default)), halation=halation(film, default),
                    wires=dict(log_e_film=[base.w.log_e_film.min, base.w.log_e_film.max],
                               cmy_film=dict(min=list(base.w.cmy_film.d_min), max=list(base.w.cmy_film.d_max))))
        size = write(f'{out}/film/{film}.bin.gz', head, base, ('l1', 'l2', 'scan') if slide else ('l1', 'l2'))
        for paper in [] if slide else papers:
            ch = base if paper == default else Chain(film, paper, base)
            head = dict(film=film, paper=paper, wires=dict(log_e_print=[ch.w.log_e_print.min, ch.w.log_e_print.max]),
                        print_compensation=dict(ev=EVS, offset=[ch.ev_comp(e) if e else 0.0 for e in EVS]))
            size += write(f'{out}/print/{film}.{paper}.bin.gz', head, ch, ('l3', 'l4', 'dy', 'dm'))
        films[film] = dict(id=film, name=info.name, group='Slide' if slide else 'Cinema negative' if info.use == 'cine' else 'Colour negative',
                           slide=slide, paper=None if slide else default, illuminant=info.reference_illuminant)
        print(film, default, f'{size / 1024 / 1024:.1f} MB', flush=True)
        names = [dict(id=p, name=init_params(print_profile=p).print.info.name) for p in papers]
        json.dump(dict(films=sorted(films.values(), key=lambda f: (f['group'], f['name'])), papers=names), open(catalog_path, 'w'), indent=1)

if __name__ == '__main__':
    main()
