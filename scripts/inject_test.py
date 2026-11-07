# Can exposure, print exposure and Y/M filter sliders run on baked tables, or does each setting need a rebake?
# Chains the four 4lut tables with offsets injected on the log-E wires and compares with the per-pixel
# pipeline at the same settings. Also tests first-order filter tables (L3 plus dL3/dy, dL3/dm).
# Usage: python -I inject_test.py <out.json> <film:print> [...] -- <image.png> [...]   (needs the spektrafilm venv)
# Findings: docs/2026-11-08-layout-findings.md
import json, sys, time, numpy as np
from scipy.ndimage import map_coordinates
from spektrafilm.utils.io import load_image_oiio
from spektrafilm.runtime.params_builder import digest_params, init_params
from spektrafilm.runtime.pipeline import SimulationPipeline
from spektrafilm_lut_creator.bundles import BundleSpec
from spektrafilm_lut_creator.builders import BundleBuilder
from spektrafilm_lut_creator.color_spaces import decode_cctf, encode_cctf, input_exposure_gain, get as get_cs
from spektrafilm_lut_creator.wires import BoundaryWires, DensityWire, LogEWire
from spektrafilm_lut_creator.shapers import log_e_to_code, density_to_code

N = 33
HEADROOM = 0.7  # log10 units added to each log-E wire, so +/-2 EV of injected offset stays in range
FILM_FLOOR = -3.0  # the baker's probe reaches log10(1e-10) at pure black, which spreads 33 samples over 11 log units
L2 = np.log10(2.0)

def pipeline(film, printp, **kw):
    p = init_params(film_profile=film, print_profile=printp)
    p.debug.lut_mode = True
    p.io.scan_film = is_slide(film)  # slide film is viewed directly; printing it on paper inverts the image
    p.io.input_color_space = 'sRGB'; p.io.output_color_space = 'sRGB'
    p.io.input_cctf_decoding = False; p.io.output_cctf_encoding = False
    spec = spec_for(film, printp)
    p.io.input_gamut_compress = spec.input_gamut_compress
    p.io.output_gamut_compress = spec.output_gamut_compress
    p.enlarger.y_filter_shift = kw.get('y', 0.0)
    p.enlarger.m_filter_shift = kw.get('m', 0.0)
    p = digest_params(p)
    # lut_mode zeroes exposure and print compensation inside digest_params, so these go on afterwards
    p.camera.exposure_compensation_ev = kw.get('ev', 0.0)
    p.enlarger.print_exposure = kw.get('pe', 1.0)
    p.enlarger.print_exposure_compensation = kw.get('compensate', False)
    return SimulationPipeline(p)

def is_slide(film):
    return init_params(film_profile=film).film.info.type == 'positive'

def spec_for(film, printp):
    # stops_above_midgray=None keeps sRGB mid-grey at film mid-grey; "auto" overexposes by about 1.5 stops
    return BundleSpec(film_profile=film, print_profiles=(printp,), input_color_space='sRGB', output_color_space='sRGB',
                      topology='4lut', resolution=N, stops_above_midgray=None)

def sample(lut, code):
    c = np.clip(code, 0, 1) * (lut.shape[0] - 1)
    return np.stack([map_coordinates(lut[..., k], [c[..., 2], c[..., 1], c[..., 0]], order=1, mode='nearest')
                     for k in range(3)], axis=-1)

def bake(bld, pipe, spec, wires, inject, collect):
    n = spec.resolution
    img = bld._make_inject_image(n, inject, wires, spec)
    out = pipe.process(img, inject=inject, collect=collect)
    # physical values at the collect tap, indexed [b, g, r]; log-E wires clamp as the baker's encoder does
    out = np.asarray(out, dtype=np.float64).reshape(n, n, n, 3)
    wire = {'log_e_film': wires.log_e_film, 'log_e_print': wires.log_e_print}.get(collect)
    return np.clip(out, wire.min, wire.max) if wire else out

class Chain:
    def __init__(self, film, printp):
        self.spec = spec_for(film, printp); self.film, self.printp = film, printp
        self.bld = BundleBuilder(self.spec)
        pipe = pipeline(film, printp)
        self.slide = is_slide(film)
        w_film = self.bld._compute_log_e_wire(pipe, self.spec, tap='log_e_film')
        # density range measured at both ends of the exposure slider, so +/-2 EV does not clip on the density wire
        ends = [self.bld._compute_density_wire(pipeline(film, printp, ev=e), self.spec) for e in (-2.0, 2.0)]
        dens = DensityWire(tuple(np.maximum(ends[0].d_max, ends[1].d_max)), tuple(np.minimum(ends[0].d_min, ends[1].d_min)))
        w_print = None if self.slide else self.bld._compute_log_e_wire(pipe, self.spec, tap='log_e_print')
        self.w = BoundaryWires(log_e_film=LogEWire(max(w_film.min, FILM_FLOOR) - HEADROOM, w_film.max + HEADROOM), cmy_film=dens,
                               log_e_print=None if self.slide else LogEWire(w_print.min - HEADROOM, w_print.max + HEADROOM))
        b = lambda a, c, p=pipe: bake(self.bld, p, self.spec, self.w, a, c)
        self.l1 = b('rgb_in', 'log_e_film'); self.l2 = b('log_e_film', 'cmy_film')
        if self.slide:
            self.scan = np.clip(encode_cctf(b('cmy_film', 'rgb_out'), 'sRGB'), 0, 1)
            return
        self.l3 = b('cmy_film', 'log_e_print')
        self.l4 = np.clip(encode_cctf(b('log_e_print', 'rgb_out'), 'sRGB'), 0, 1)
        step = 10.0
        self.dy = (b('cmy_film', 'log_e_print', pipeline(film, printp, y=step)) -
                   b('cmy_film', 'log_e_print', pipeline(film, printp, y=-step))) / (2 * step)
        self.dm = (b('cmy_film', 'log_e_print', pipeline(film, printp, m=step)) -
                   b('cmy_film', 'log_e_print', pipeline(film, printp, m=-step))) / (2 * step)
        # one offset per channel per CC unit: the same derivative read at the film's mid-grey density
        grey = density_to_code(np.asarray(pipe.process(np.full((1, 1, 3), 0.184, np.float32) * self.gain, inject='rgb_in', collect='cmy_film'), float), dens)
        self.off_y = sample(self.dy, grey)[0, 0]; self.off_m = sample(self.dm, grey)[0, 0]

    @property
    def gain(self):
        return input_exposure_gain('sRGB', self.spec.stops_above_midgray)

    def run(self, enc, ev=0.0, comp=0.0, pe=1.0, y=0.0, m=0.0, filt='offset'):
        le = sample(self.l1, enc) + ev * L2
        cmy = sample(self.l2, log_e_to_code(le, self.w.log_e_film))
        code = density_to_code(cmy, self.w.cmy_film)
        if self.slide:
            return sample(self.scan, code)
        lp = sample(self.l3, code) + np.log10(pe) + comp
        if filt == 'offset':
            lp = lp + y * self.off_y + m * self.off_m
        else:
            lp = lp + y * sample(self.dy, code) + m * sample(self.dm, code)
        return sample(self.l4, log_e_to_code(lp, self.w.log_e_print))

    def reference(self, enc, **kw):
        lin = (decode_cctf(enc, 'sRGB') * self.gain).astype(np.float32)
        return np.clip(encode_cctf(np.asarray(pipeline(self.film, self.printp, **kw).process(lin), float), 'sRGB'), 0, 1)

    def ev_comp(self, ev):
        # the runtime's print compensation for camera EV is one scalar; read it from the two pipelines at mid-grey
        g = np.full((1, 1, 3), 0.184, np.float32) * self.gain
        a = np.asarray(pipeline(self.film, self.printp, ev=ev, compensate=True).process(g, inject='rgb_in', collect='log_e_print'), float)
        b = np.asarray(pipeline(self.film, self.printp, ev=ev).process(g, inject='rgb_in', collect='log_e_print'), float)
        return float((a - b).mean())

def load(path):
    im = np.asarray(load_image_oiio(path), dtype=np.float64)[..., :3]
    return np.clip(im[::max(1, im.shape[0] // 400)][:, ::max(1, im.shape[1] // 400)], 0, 1)

def stats(a, b):
    d = np.abs(a - b)
    return dict(mean=float(d.mean()), p99=float(np.percentile(d, 99)), max=float(d.max()))

CASES = [('base', {}, {}),
         ('print_exposure 0.5', dict(pe=0.5), dict(pe=0.5)), ('print_exposure 2', dict(pe=2.0), dict(pe=2.0)),
         ('ev -2', dict(ev=-2.0), dict(ev=-2.0)), ('ev -1', dict(ev=-1.0), dict(ev=-1.0)),
         ('ev +1', dict(ev=1.0), dict(ev=1.0)), ('ev +2', dict(ev=2.0), dict(ev=2.0)),
         ('ev -2 compensated', dict(ev=-2.0, compensate=True), None), ('ev +2 compensated', dict(ev=2.0, compensate=True), None)]
for ax in 'ym':
    for v in (-20.0, -10.0, 10.0, 20.0):
        CASES.append((f'{ax} {v:+.0f} offset', {ax: v}, {ax: v, 'filt': 'offset'}))
        CASES.append((f'{ax} {v:+.0f} first-order', {ax: v}, {ax: v, 'filt': 'table'}))

def main():
    split = sys.argv.index('--')
    out, pairs, images = sys.argv[1], sys.argv[2:split], sys.argv[split + 1:]
    imgs = {p.rsplit('/', 1)[-1]: load(p) for p in images}
    results = []
    for pair in pairs:
        film, printp = pair.split(':')
        t = time.time(); ch = Chain(film, printp); print(pair, f'baked in {time.time() - t:.1f}s', flush=True)
        for name, ref_kw, run_kw in CASES:
            if ch.slide and not (name == 'base' or (name.startswith('ev') and 'compensated' not in name)):
                continue
            if run_kw is None:
                run_kw = dict(ev=ref_kw['ev'], comp=ch.ev_comp(ref_kw['ev']))
            per = {k: stats(ch.reference(im, **ref_kw), ch.run(im, **run_kw)) for k, im in imgs.items()}
            worst = max(per, key=lambda k: per[k]['p99'])
            row = dict(pair=pair, case=name, mean=float(np.mean([v['mean'] for v in per.values()])),
                       p99=max(v['p99'] for v in per.values()), max=max(v['max'] for v in per.values()), worst=worst, per=per)
            results.append(row)
            print(f"{pair} {name:24s} mean {row['mean']:.4f} p99 {row['p99']:.4f} max {row['max']:.4f} ({worst})", flush=True)
        json.dump(results, open(out, 'w'), indent=1)

if __name__ == '__main__':
    main()
