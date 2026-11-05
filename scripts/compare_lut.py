# Compare a baked 1lut .cube (sRGB in/out) with the per-pixel spektrafilm pipeline on one image.
# Usage: python -I compare_lut.py <film> <print> <cube> <image.tif>   (needs the spektrafilm venv)
# Findings: docs/2026-11-05-bake-findings.md
import sys, time, numpy as np, colour
from scipy.ndimage import map_coordinates
from spektrafilm.utils.io import load_image_oiio
from spektrafilm.runtime.params_builder import digest_params, init_params
from spektrafilm.runtime.pipeline import SimulationPipeline

def read_cube(path):
    n=None; rows=[]
    for line in open(path):
        t=line.split()
        if not t or t[0].startswith('#') or t[0] in('TITLE','DOMAIN_MIN','DOMAIN_MAX'): continue
        if t[0]=='LUT_3D_SIZE': n=int(t[1]); continue
        rows.append([float(x) for x in t[:3]])
    a=np.array(rows).reshape(n,n,n,3)  # index [b,g,r]
    return a,n

def apply(lut,n,img):
    c=np.clip(img,0,1)*(n-1)
    out=np.empty_like(img)
    for k in range(3):
        out[...,k]=map_coordinates(lut[...,k],[c[...,2],c[...,1],c[...,0]],order=1,mode='nearest')
    return out

film,printp,cube,tif=sys.argv[1:5]
im=np.asarray(load_image_oiio(tif),dtype=np.float64)[...,:3]
im=im[::max(1,im.shape[0]//500)][:, ::max(1,im.shape[1]//500)]
lin=colour.RGB_to_RGB(im,'ProPhoto RGB','sRGB',apply_cctf_decoding=False,apply_cctf_encoding=False)
enc=np.clip(colour.cctf_encoding(np.clip(lin,0,1),function='sRGB'),0,1)
lin_in=colour.cctf_decoding(enc,function='sRGB')
from spektrafilm_lut_creator.bundles import BundleSpec
from spektrafilm_lut_creator.builders import BundleBuilder
from spektrafilm_lut_creator.color_spaces import decode_cctf, encode_cctf, output_midgray_gain, input_exposure_gain, get as get_cs
spec=BundleSpec(film_profile=film,print_profiles=(printp,),input_color_space='sRGB',output_color_space='sRGB',topology='1lut',resolution=33)
bld=BundleBuilder(spec)
pipe=bld._make_pipeline(spec,get_cs('sRGB'),get_cs('sRGB'),printp)
gain=input_exposure_gain('sRGB',spec.stops_above_midgray)
t=time.time()
lin_in=(decode_cctf(enc,'sRGB')*gain).astype(np.float32)
raw=pipe.process(lin_in)
ref=np.clip(encode_cctf(np.asarray(raw,dtype=float)*output_midgray_gain('sRGB'),'sRGB'),0,1); tref=time.time()-t
lut,n=read_cube(cube)
t=time.time(); got=apply(lut,n,enc); tl=time.time()-t
d=np.abs(ref-got)
print(f"{film}: img {enc.shape[1]}x{enc.shape[0]} per-pixel {tref:.1f}s lut-apply {tl:.2f}s | mean abs diff {d.mean():.5f} p99 {np.percentile(d,99):.5f} max {d.max():.5f} (0-1 scale, sRGB-encoded out)")
