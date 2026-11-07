import { Engine, readStock } from './engine.js';
import { STOCKS, DEFAULTS, createCommands } from './commands.js';

const PREVIEW_EDGE = 1600;
const MAX_PIXELS = 48e6; // four half-float targets at this size take 1.5 GB
const $ = id => document.getElementById(id);
const status = text => { $('status').textContent = text; };

const state = { stock: STOCKS[0].id, ...DEFAULTS };
const pending = {};
let engine, photo, photoName = 'sample', queued = false, exporting = false, tail = Promise.resolve();

// photo, stock and export work runs one job at a time, so a slow job cannot land after a newer one
function serial(job) {
  const result = tail.then(job);
  tail = result.catch(() => {});
  return result;
}

function fetchStock(id) {
  if (engine.stocks.has(id)) return Promise.resolve();
  pending[id] ??= readStock(`tables/${id}.bin.gz`).then(s => engine.addStock(id, s)).finally(() => { delete pending[id]; });
  return pending[id];
}

function draw() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    if (photo && !exporting && engine.stocks.has(state.stock)) engine.render(state.stock, state);
  });
}

function fit(w, h, edge) {
  const k = Math.min(1, edge / Math.max(w, h));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

async function upload(full, w, h) {
  const bitmap = w === full.width ? full : await createImageBitmap(full, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
  try { engine.setImage(bitmap); } finally { if (bitmap !== full) bitmap.close(); }
}

async function showPreview(blob) {
  const full = await createImageBitmap(blob);
  try {
    await upload(full, ...fit(full.width, full.height, PREVIEW_EDGE));
    $('size').textContent = `${full.width} × ${full.height}`;
    state.width = full.width; state.height = full.height;
  } finally { full.close(); }
  draw();
}

async function fullBlob(type = 'image/jpeg') {
  const job = { ...state }, blob = photo;
  exporting = true;
  const full = await createImageBitmap(blob);
  try {
    let edge = Math.min(engine.maxEdge, Math.sqrt(MAX_PIXELS * Math.max(full.width, full.height) / Math.min(full.width, full.height)));
    for (;;) {
      const [w, h] = fit(full.width, full.height, edge);
      try {
        await upload(full, w, h);
        engine.render(job.stock, job);
        const out = await new Promise(r => engine.canvas.toBlob(r, type, 0.95));
        if (!out) throw new Error('The browser could not encode the image.');
        return { blob: out, stock: job.stock, w, h, reduced: w !== full.width };
      } catch (e) {
        if (!(e instanceof RangeError) || edge < 1024) throw e;
        edge *= 0.7; // the GPU refused this size; a smaller render still gives a usable file
      }
    }
  } finally {
    full.close();
    exporting = false;
    await showPreview(blob);
  }
}

function syncControls() {
  const slide = STOCKS.find(s => s.id === state.stock).id === 'velvia100';
  for (const b of document.querySelectorAll('[data-stock]')) b.setAttribute('aria-pressed', b.dataset.stock === state.stock);
  $('note').textContent = STOCKS.find(s => s.id === state.stock).note;
  for (const [id, key, unit] of [['ev', 'ev', ' stops'], ['print', 'print', ' stops'], ['y', 'y', ''], ['m', 'm', '']]) {
    $(id).value = state[key];
    const v = Number(state[key]);
    $(`${id}-value`).textContent = `${v > 0 ? '+' : ''}${v.toFixed(unit ? 2 : 0)}${unit}`;
  }
  $('grain').checked = state.grain; $('halation').checked = state.halation;
  $('print-controls').hidden = slide;
}

const app = {
  snapshot: () => ({ ...state, photo: photoName, credit: $('credit').textContent.trim() }),
  setStock: id => serial(async () => {
    status('Loading film data');
    await fetchStock(id);
    state.stock = id;
    status('');
    syncControls(); draw();
    return app.snapshot();
  }),
  update(patch) {
    Object.assign(state, patch);
    syncControls(); draw();
    return app.snapshot();
  },
  loadPhoto: source => serial(async () => {
    let blob = source;
    if (typeof source === 'string') {
      const res = await fetch(source);
      if (!res.ok) throw new Error(`Could not read the photo: ${res.status}`);
      blob = await res.blob();
    }
    try { await showPreview(blob); } catch { throw new Error('That file is not a photo this browser can read.'); }
    photo = blob;
    photoName = (source.name || 'photo').replace(/\.[^.]+$/, '');
    status('');
    return app.snapshot();
  }),
  renderDataUrl: type => serial(async () => {
    const { blob } = await fullBlob(type);
    return new Promise((resolve, reject) => {
      const f = new FileReader();
      f.onload = () => resolve(f.result);
      f.onerror = f.onabort = () => reject(new Error('Could not read the rendered image.'));
      f.readAsDataURL(blob);
    });
  }),
  download: () => serial(async () => {
    status('Rendering full size');
    const name = photoName, { blob, stock, w, h, reduced } = await fullBlob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}-${stock}.jpg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    status(reduced ? `Saved at ${w} × ${h}, the largest size this device renders` : '');
    return { width: w, height: h };
  }),
};

async function start() {
  try {
    engine = new Engine($('view'));
  } catch (e) {
    status(`${e.message} Argentix needs WebGL2 with float textures.`);
    return;
  }
  const dispatch = createCommands(app);
  const run = (name, args) => dispatch(name, args).catch(e => status(e.message));

  for (const s of STOCKS) {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.stock = s.id; b.textContent = s.name;
    b.addEventListener('click', () => run('set_stock', { id: s.id }));
    $('stocks').append(b);
  }
  $('ev').addEventListener('input', e => run('set_exposure', { ev: +e.target.value }));
  $('print').addEventListener('input', e => run('set_print_exposure', { stops: +e.target.value }));
  $('y').addEventListener('input', e => run('set_filters', { y: +e.target.value }));
  $('m').addEventListener('input', e => run('set_filters', { m: +e.target.value }));
  $('grain').addEventListener('change', e => run('set_grain', { on: e.target.checked }));
  $('halation').addEventListener('change', e => run('set_halation', { on: e.target.checked }));
  $('reset').addEventListener('click', () => run('reset'));
  $('download').addEventListener('click', () => run('download_photo'));
  $('file').addEventListener('change', e => { if (e.target.files[0]) run('load_photo', { source: e.target.files[0] }); });
  addEventListener('dragover', e => e.preventDefault());
  addEventListener('drop', e => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f?.type.startsWith('image/')) run('load_photo', { source: f });
  });

  $('view').addEventListener('webglcontextlost', () => status('The GPU ran out of memory. Reload the page.'));

  syncControls();
  // first in the queue, so a photo chosen during start-up lands after the sample
  await serial(async () => {
    status('Loading film data');
    const [sample] = await Promise.all([fetch('assets/sample.png').then(r => r.blob()), fetchStock(state.stock)]);
    await showPreview(sample);
    photo = sample;
    status('');
    document.documentElement.dataset.ready = 'true';
    performance.mark('first-render');
  }).catch(e => status(`Argentix could not start: ${e.message} Reload to try again.`));
  for (const s of STOCKS) fetchStock(s.id).catch(() => {});
}

start();
