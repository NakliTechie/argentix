import { Engine, readTables } from './engine.js';
import { DEFAULTS, createCommands } from './commands.js';
import { guide, initGuide } from './guide.js';
import { saveSettings, loadSettings, savePhoto, loadPhoto } from './store.js';

const PREVIEW_EDGE = 1600;
const MAX_PIXELS = 48e6; // four half-float targets at this size take 1.5 GB
const $ = id => document.getElementById(id);

const FIRST_FILM = 'kodak_portra_400';
const GROUPS = ['Colour negative', 'Cinema negative', 'Slide'];
const state = { stock: FIRST_FILM, paper: null, ...DEFAULTS };
let catalog, paperChosen = false, engine, photo, photoName = 'sample', queued = false, exporting = false, original = false;
let tail = Promise.resolve(), picks = 0, wantStock = 0, wantPaper = 0, errorShown = false;

// one message line over the photo; an error stays until the next action succeeds
// the pill is visual only; #announce is a live region that is always in the page, so screen readers hear each change
function status(text, error = false) {
  $('status').textContent = text;
  $('announce').textContent = text;
  $('status').hidden = !text;
  $('status').classList.toggle('error', error);
  errorShown = error && !!text;
}

// photo, stock and export work runs one job at a time, so a slow job cannot land after a newer one
function serial(job) {
  const result = tail.then(job);
  tail = result.catch(() => {});
  return result;
}

const filmInfo = id => catalog.films.find(f => f.id === id);
const paperName = id => catalog.papers.find(p => p.id === id).name.replace('Kodak Professional', 'Kodak');
const printKey = s => `${s.stock}.${s.paper}`;

// a film's own tables, plus the print tables for this paper unless it is a slide. Nothing is
// stored until both reads succeed, so a failed switch leaves the current tables in place.
async function fetchTables(s) {
  const key = printKey(s), needFilm = !engine.films.has(s.stock);
  const needPrint = !filmInfo(s.stock).slide && !engine.prints.has(key);
  let film, print;
  try {
    [film, print] = await Promise.all([
      needFilm && readTables(`tables/film/${s.stock}.bin.gz`),
      needPrint && readTables(`tables/print/${key}.bin.gz`),
    ]);
  } catch (e) {
    throw e instanceof TypeError ? new Error('Could not download the film data. Check your connection and choose the film again.') : e;
  }
  if (film) engine.addFilm(s.stock, film);
  if (print) engine.addPrint(key, print, printKey(state));
}

const tablesReady = s => engine.films.has(s.stock) && (filmInfo(s.stock).slide || engine.prints.has(printKey(s)));

function draw() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    if (!photo || exporting) return;
    if (original) engine.renderOriginal();
    else if (tablesReady(state)) engine.render(state.stock, printKey(state), state);
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
    $('size').textContent = `· ${full.width} × ${full.height} px`;
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
        engine.render(job.stock, printKey(job), job);
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
  const film = filmInfo(state.stock), slide = film.slide;
  if (picks === 0) { $('film').value = state.stock; $('paper').value = state.paper; }
  $('note').textContent = slide ? 'Slide film, viewed directly: no paper.'
    : film.illuminant.startsWith('D') ? 'The film shapes colour, contrast and grain.' : 'Made for indoor lamp light; the print filters balance it.';
  $('paper-row').hidden = slide;
  for (const [id, key, unit] of [['ev', 'ev', ' stops'], ['print', 'print', ' stops'], ['y', 'y', ''], ['m', 'm', '']]) {
    $(id).value = state[key];
    const v = Number(state[key]);
    $(`${id}-value`).textContent = `${v > 0 ? '+' : ''}${v.toFixed(unit ? 2 : 0)}${unit}`;
  }
  $('grain').checked = state.grain; $('halation').checked = state.halation;
  $('print-controls').hidden = slide;
  const who = photoName === 'sample' ? 'Sample photo' : 'Your photo';
  $('caption-text').textContent = `${who} on ${film.name}${slide ? '' : `, printed on ${paperName(state.paper)}`}`;
  saveSettings({ ...state, paperChosen });
}

// current(): whether this pick is still the newest of its kind once its tables have arrived
async function choose(next, current) {
  status('Loading film data');
  await fetchTables(next);
  if (!current()) return;
  Object.assign(state, next);
  status('');
  draw();
}

// the menus keep showing the newest pick; they follow the state only once no pick is waiting
function pick(job) {
  picks++;
  return serial(async () => {
    try { return await job(); } finally { if (--picks === 0) syncControls(); }
  });
}

function isHeic(blob) {
  return /hei[cf]/i.test(blob.type) || /\.hei[cf]$/i.test(blob.name || '');
}

const app = {
  snapshot: () => ({ ...state, photo: photoName, credit: $('credit').textContent.trim() }),
  setStock: id => {
    const mine = ++wantStock; // a later film pick makes this one moot, so it is skipped
    return pick(async () => {
      const current = () => mine === wantStock;
      if (current()) await choose({ stock: id, paper: paperChosen ? state.paper : filmInfo(id).paper ?? state.paper }, current);
      return app.snapshot();
    });
  },
  setPaper: id => {
    const mine = ++wantPaper, current = () => mine === wantPaper;
    return pick(async () => {
      if (current()) { await choose({ stock: state.stock, paper: id }, current); paperChosen = true; }
      return app.snapshot();
    });
  },
  update(patch) {
    Object.assign(state, patch);
    syncControls(); draw();
    return app.snapshot();
  },
  showOriginal(on) {
    original = on;
    $('compare').setAttribute('aria-pressed', on);
    draw();
    return { original };
  },
  openHelp: () => guide.openHelp(),
  startTour: () => guide.startTour(),
  loadPhoto: (source, { remember = true } = {}) => serial(async () => {
    let blob = source;
    if (typeof source === 'string') {
      const res = await fetch(source);
      if (!res.ok) throw new Error(`Could not read the photo: ${res.status}`);
      blob = await res.blob();
    }
    try { await showPreview(blob); } catch {
      throw new Error(isHeic(blob) ? 'HEIC photos do not open in this browser. Open Argentix in Safari, or export the photo as JPEG.'
        : 'That file is not a photo this browser can read.');
    }
    photo = blob;
    photoName = (source.name || 'photo').replace(/\.[^.]+$/, '');
    if (remember) await savePhoto(blob, photoName);
    syncControls();
    status('');
    if ($('stage').getBoundingClientRect().top < 0) $('stage').scrollIntoView({ behavior: 'smooth' });
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
    status(reduced ? `Saved at ${w} × ${h}, the largest size this device renders` : `Saved ${w} × ${h}`);
    setTimeout(() => { if (!errorShown && $('status').textContent.startsWith('Saved')) status(''); }, 4000);
    return { width: w, height: h };
  }),
};

// any release anywhere ends the comparison, so it cannot stay stuck on after focus or the window changes
const compareOff = () => { if (original) run('show_original', { on: false }); };

function holdToCompare(el) {
  const on = e => { e.preventDefault(); run('show_original', { on: true }); };
  el.addEventListener('pointerdown', on);
  el.addEventListener('pointerleave', compareOff);
  el.addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) on(e); });
}

let run;

async function start() {
  try {
    engine = new Engine($('view'));
  } catch (e) {
    status(`${e.message} Argentix needs WebGL2 with float textures.`, true);
    return;
  }
  try {
    const res = await fetch('tables/catalog.json');
    if (!res.ok) throw new Error(`catalog ${res.status}`);
    catalog = await res.json();
  } catch (e) {
    status(`Argentix could not start: ${e.message} Reload to try again.`, true);
    return;
  }
  const saved = loadSettings(catalog);
  if (saved) { paperChosen = saved.paperChosen; delete saved.paperChosen; Object.assign(state, saved); }
  if (!filmInfo(state.stock)) state.stock = catalog.films[0].id;
  if (!catalog.papers.some(p => p.id === state.paper)) state.paper = filmInfo(state.stock).paper ?? catalog.papers[0].id;
  const dispatch = createCommands(app, catalog);
  run = (name, args) => dispatch(name, args)
    .then(r => { if (errorShown) status(''); return r; })
    .catch(e => { status(e.message, true); if (picks === 0) syncControls(); });

  for (const group of GROUPS) {
    const g = document.createElement('optgroup');
    g.label = group;
    for (const f of catalog.films.filter(f => f.group === group)) g.append(new Option(f.name, f.id));
    $('film').append(g);
  }
  for (const p of catalog.papers) $('paper').append(new Option(paperName(p.id), p.id));
  $('film').addEventListener('change', e => run('set_stock', { id: e.target.value }));
  $('paper').addEventListener('change', e => run('set_paper', { id: e.target.value }));
  $('ev').addEventListener('input', e => run('set_exposure', { ev: +e.target.value }));
  $('print').addEventListener('input', e => run('set_print_exposure', { stops: +e.target.value }));
  $('y').addEventListener('input', e => run('set_filters', { y: +e.target.value }));
  $('m').addEventListener('input', e => run('set_filters', { m: +e.target.value }));
  $('grain').addEventListener('change', e => run('set_grain', { on: e.target.checked }));
  $('halation').addEventListener('change', e => run('set_halation', { on: e.target.checked }));
  $('reset').addEventListener('click', () => run('reset'));
  $('download').addEventListener('click', () => run('download_photo'));
  $('file').addEventListener('change', e => { if (e.target.files[0]) run('load_photo', { source: e.target.files[0] }); e.target.value = ''; });
  addEventListener('dragover', e => e.preventDefault());
  addEventListener('drop', e => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) run('load_photo', { source: f });
  });
  document.addEventListener('paste', e => {
    const f = [...(e.clipboardData?.files || [])].find(x => x.type.startsWith('image/'));
    if (f) { e.preventDefault(); run('load_photo', { source: f }); }
  });
  holdToCompare($('view'));
  holdToCompare($('compare'));
  for (const ev of ['pointerup', 'pointercancel', 'keyup', 'blur']) addEventListener(ev, compareOff);
  document.addEventListener('visibilitychange', compareOff);
  $('view').addEventListener('webglcontextlost', () => status('The GPU ran out of memory. Reload the page.', true));
  initGuide(run);

  syncControls();
  // first in the queue, so a photo chosen during start-up lands after the sample
  await serial(async () => {
    status('Loading film data');
    const last = await loadPhoto();
    const [sample] = await Promise.all([last ? null : fetch('assets/sample.png').then(r => r.blob()), fetchTables(state)]);
    try {
      await showPreview(last ? last.blob : sample);
      photo = last ? last.blob : sample; photoName = last ? last.name : 'sample';
    } catch {
      const blob = await (await fetch('assets/sample.png')).blob();
      await showPreview(blob); photo = blob; photoName = 'sample';
    }
    syncControls();
    status('');
    document.documentElement.dataset.ready = 'true';
    performance.mark('first-render');
  }).catch(e => status(`Argentix could not start: ${e.message} Reload to try again.`, true));
}

start();
