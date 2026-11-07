import { Engine, readStock } from './engine.js';
import { STOCKS, DEFAULTS, createCommands } from './commands.js';

const PREVIEW_EDGE = 1600;
const $ = id => document.getElementById(id);
const status = text => { $('status').textContent = text; };

const state = { stock: STOCKS[0].id, ...DEFAULTS };
let engine, photo, photoName = 'sample', pending = null, queued = false;

function fetchStock(id) {
  if (engine.stocks.has(id)) return Promise.resolve();
  pending ??= {};
  pending[id] ??= readStock(`tables/${id}.bin.gz`).then(s => engine.addStock(id, s));
  return pending[id];
}

function draw() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    if (photo && engine.stocks.has(state.stock)) engine.render(state.stock, state);
  });
}

function fit(w, h, edge) {
  const k = Math.min(1, edge / Math.max(w, h));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

async function showPreview() {
  const full = await createImageBitmap(photo);
  const [w, h] = fit(full.width, full.height, PREVIEW_EDGE);
  const bitmap = w === full.width ? full : await createImageBitmap(photo, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
  engine.setImage(bitmap);
  $('size').textContent = `${full.width} × ${full.height}`;
  state.width = full.width; state.height = full.height;
  draw();
}

async function renderFull() {
  const full = await createImageBitmap(photo);
  const [w, h] = fit(full.width, full.height, engine.maxEdge);
  engine.setImage(w === full.width ? full : await createImageBitmap(photo, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' }));
  engine.render(state.stock, state);
  return { w, h, reduced: w !== full.width };
}

async function fullBlob(type = 'image/jpeg') {
  const info = await renderFull();
  const blob = await new Promise(r => engine.canvas.toBlob(r, type, 0.95));
  await showPreview();
  return { blob, ...info };
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
  async setStock(id) {
    status('Loading film data');
    await fetchStock(id);
    state.stock = id;
    status('');
    syncControls(); draw();
    return app.snapshot();
  },
  update(patch) {
    Object.assign(state, patch);
    syncControls(); draw();
    return app.snapshot();
  },
  async loadPhoto(source) {
    photo = typeof source === 'string' ? await (await fetch(source)).blob() : source;
    photoName = (source.name || 'photo').replace(/\.[^.]+$/, '');
    await showPreview();
    status('');
    return app.snapshot();
  },
  async renderDataUrl(type) {
    const { blob } = await fullBlob(type);
    return new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob); });
  },
  async download() {
    status('Rendering full size');
    const { blob, w, h, reduced } = await fullBlob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${photoName}-${state.stock}.jpg`;
    a.click();
    URL.revokeObjectURL(a.href);
    status(reduced ? `Saved at ${w} × ${h}, the largest size this GPU renders` : '');
    return { width: w, height: h };
  },
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

  syncControls();
  status('Loading film data');
  const [sample] = await Promise.all([fetch('assets/sample.png').then(r => r.blob()), fetchStock(state.stock)]);
  photo = sample;
  await showPreview();
  status('');
  document.documentElement.dataset.ready = 'true';
  performance.mark('first-render');
  for (const s of STOCKS) fetchStock(s.id).catch(() => {});
}

start();
