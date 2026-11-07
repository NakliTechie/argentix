# Bake one stock file per film for the browser: gzip of a JSON header line plus delta-coded uint16 tables.
# Header carries the attribution CC BY-SA 4.0 requires, the wires, the exposure curve, grain and halation data.
# Usage: python -I bake_tables.py <out_dir> <id:film:print> [...]   (needs the spektrafilm venv)
# Layout decision: docs/2026-11-08-layout-findings.md
import gzip, json, os, sys, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from inject_test import Chain, init_params, digest_params, SimulationPipeline, is_slide, N, pipeline
from spektrafilm_lut_creator.color_spaces import decode_cctf

NOTICE = dict(
    work='Film and paper tables baked from spektrafilm profiles',
    author='Andrea Volpato', source='https://github.com/andreavolpato/spektrafilm', source_commit='3bb2c2d',
    licence='CC BY-SA 4.0', licence_url='https://creativecommons.org/licenses/by-sa/4.0/',
    modified='Baked to 33-point tables and re-encoded as delta-coded uint16 by Argentix, https://argentix.naklitechie.com')

GRAIN_BANDS = 16
GRAIN_EDGE = 2048  # long edge of the calibration frame; the page scales sigma by edge / GRAIN_EDGE

def pack(table):
    # per-channel range to uint16, then deltas along the fastest axis so gzip finds the smooth surface
    lo, hi = table.min(axis=(0, 1, 2)), table.max(axis=(0, 1, 2))
    span = np.where(hi > lo, hi - lo, 1.0)
    q = np.round((table - lo) / span * 65535).astype(np.uint16)
    d = q.copy(); d[:, :, 1:, :] = q[:, :, 1:, :] - q[:, :, :-1, :]
    return d.tobytes(), dict(lo=lo.tolist(), hi=(lo + span).tolist())

def film_params(film, printp, grain):
    p = init_params(film_profile=film, print_profile=printp)
    p.io.scan_film = is_slide(film)
    p.io.input_color_space = 'sRGB'; p.io.output_color_space = 'sRGB'
    p.io.input_cctf_decoding = False; p.io.output_cctf_encoding = False
    p.camera.auto_exposure = False
    p.film_render.halation.active = False
    p.film_render.grain.active = grain
    p.scanner.unsharp_mask = (0.0, 0.0)
    return digest_params(p)

def grain_curve(film, printp, edge=GRAIN_EDGE):
    # flat grey bands through the real grain model: density noise per channel against mean density
    w = edge // GRAIN_BANDS
    levels = np.geomspace(0.004, 4.0, GRAIN_BANDS)
    frame = np.repeat(np.repeat(levels, w)[None, :, None], 256, axis=0).repeat(3, axis=2).astype(np.float32)
    pipe = SimulationPipeline(film_params(film, printp, True))
    cmy = np.asarray(pipe.process(frame, collect='cmy_film'), float)
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
    out = sys.argv[1]; os.makedirs(out, exist_ok=True)
    index = []
    for arg in sys.argv[2:]:
        sid, film, printp = arg.split(':')
        ch = Chain(film, printp)
        names = ('l1', 'l2', 'scan') if ch.slide else ('l1', 'l2', 'l3', 'l4', 'dy', 'dm')
        blobs, ranges = [], {}
        for n in names:
            b, r = pack(getattr(ch, n)); blobs.append(b); ranges[n] = r
        wires = dict(log_e_film=[ch.w.log_e_film.min, ch.w.log_e_film.max],
                     cmy_film=dict(min=list(ch.w.cmy_film.d_min), max=list(ch.w.cmy_film.d_max)))
        if not ch.slide:
            wires['log_e_print'] = [ch.w.log_e_print.min, ch.w.log_e_print.max]
        evs = [round(-2 + 0.25 * i, 2) for i in range(17)]
        head = dict(notice=NOTICE, id=sid, film=film, paper=None if ch.slide else printp, slide=ch.slide, size=N,
                    tables=list(names), ranges=ranges, wires=wires,
                    print_compensation=None if ch.slide else dict(ev=evs, offset=[ch.ev_comp(e) if e else 0.0 for e in evs]),
                    grain=dict(edge=GRAIN_EDGE, bands=grain_curve(film, printp), check=grain_curve(film, printp, 4096)),
                    halation=halation(film, printp))
        with gzip.open(f'{out}/{sid}.bin.gz', 'wb', compresslevel=9) as f:
            f.write(json.dumps(head).encode() + b'\n' + b''.join(blobs))
        size = os.path.getsize(f'{out}/{sid}.bin.gz')
        print(sid, film, printp, f'{size / 1024:.0f} KB', flush=True)
        index.append(dict(id=sid, film=film, paper=head['paper'], slide=ch.slide, bytes=size))
    json.dump(index, open(f'{out}/index.json', 'w'), indent=1)

if __name__ == '__main__':
    main()
