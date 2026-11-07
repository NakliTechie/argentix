# Regenerate docs/results.png from docs/slider-results.json, and social.png from a page render.
# Usage: python -I make_images.py <browser.json>   (needs the spektrafilm venv; run from the repo root)
import base64, collections, io, json, sys
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
from PIL import Image, ImageDraw, ImageFont

rows = json.load(open('docs/slider-results.json'))
def family(c):
    if c == 'base': return 'No slider moved'
    if c.startswith('print'): return 'Print exposure, ±1 stop'
    if 'compensated' in c: return 'Film exposure ±2, printer corrected'
    if c.startswith('ev'): return 'Film exposure, ±2 stops'
    return 'Y and M filters, ±20 CC' if 'first-order' in c else None
worst = collections.defaultdict(float)
for r in rows:
    f = family(r['case'])
    if f: worst[f] = max(worst[f], r['mean'] * 255)
labels = sorted(worst, key=worst.get)
fig, ax = plt.subplots(figsize=(8, 2.8), dpi=160)
bars = ax.barh(labels, [worst[l] for l in labels], color='#222222', height=.55)
ax.bar_label(bars, fmt='%.2f', padding=4, fontsize=10, color='#222222')
ax.set_xlim(0, 1); ax.set_xlabel('Mean difference from the full simulation, in 8-bit levels (worst stock)', fontsize=9, color='#555555')
ax.tick_params(length=0, labelsize=10); ax.xaxis.set_ticks([0, .25, .5, .75, 1])
for s in ('top', 'right', 'left'): ax.spines[s].set_visible(False)
ax.spines['bottom'].set_color('#cccccc')
fig.tight_layout(); fig.savefig('docs/results.png'); print({k: round(v, 2) for k, v in worst.items()})

shots = json.load(open(sys.argv[1]))
photo = Image.open(io.BytesIO(base64.b64decode(shots['portra400_full'].split(',', 1)[1]))).convert('RGB')
card = Image.new('RGB', (1280, 640), 'white')
photo = photo.resize((960, 640), Image.LANCZOS).crop((180, 0, 820, 640))
card.paste(photo, (640, 0))
d = ImageDraw.Draw(card)
face = '/System/Library/Fonts/Avenir Next.ttc'
d.text((64, 200), 'Argentix', font=ImageFont.truetype(face, 96, index=0), fill='black')
d.text((68, 330), 'A browser film lab.', font=ImageFont.truetype(face, 40, index=0), fill=(0, 0, 0, 200))
d.text((68, 384), 'Nothing leaves your tab.', font=ImageFont.truetype(face, 40, index=0), fill=(0, 0, 0, 200))
card.save('social.png', optimize=True)
