// First-visit splash, a three-step tour and the help sheet. Presentation only: no film state lives here.
const SEEN_KEY = 'argentix.seen';
const $ = id => document.getElementById(id);

const STEPS = [
  { target: 'stage', text: 'This is a photo rendered on film. Press and hold it to see the original.' },
  { target: 'film-group', text: 'Pick a film. Negative films are printed on a paper, which sets the final contrast and palette.' },
  { target: 'photo-group', text: 'Drop, paste or choose your own photo, then Download it at full size. It never leaves this tab.' },
];

let step = -1, returnTo = null;

function remember() {
  try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* storage blocked: firstVisit() already returns false */ }
}

// true only when storage works and holds no marker; blocked storage skips the splash instead of showing it every visit
function firstVisit() {
  try {
    if (localStorage.getItem(SEEN_KEY) === '1') return false;
    localStorage.setItem(SEEN_KEY + '.probe', '1'); localStorage.removeItem(SEEN_KEY + '.probe');
    return true;
  } catch { return false; }
}

function place() {
  const box = $('tour'), target = $(STEPS[step].target);
  target.scrollIntoView({ block: 'nearest' });
  const r = target.getBoundingClientRect(), w = Math.min(320, innerWidth - 32);
  const below = r.bottom + 12 + box.offsetHeight < innerHeight;
  box.style.width = `${w}px`;
  box.style.left = `${Math.max(16, Math.min(r.left, innerWidth - w - 16))}px`;
  box.style.top = `${below ? r.bottom + 12 : Math.max(16, r.top - box.offsetHeight - 12)}px`;
}

function show(i) {
  document.querySelector('.touring')?.classList.remove('touring');
  step = i;
  if (i < 0 || i >= STEPS.length) {
    if ($('tour').open) $('tour').close();
    step = -1;
    returnTo?.focus?.(); returnTo = null;
    return;
  }
  $(STEPS[i].target).classList.add('touring');
  $('tour-text').textContent = STEPS[i].text;
  $('tour-count').textContent = `${i + 1} of ${STEPS.length}`;
  $('tour-back').hidden = i === 0;
  $('tour-next').textContent = i === STEPS.length - 1 ? 'Done' : 'Next';
  if (!$('tour').open) $('tour').showModal(); // modal, so Tab stays inside the tour
  place();
  $('tour-next').focus();
}

export const guide = {
  startTour() {
    returnTo = document.activeElement?.closest('dialog') ? $('help-open') : document.activeElement;
    $('splash').close(); $('help').close(); remember(); show(0);
    return { step: 1, of: STEPS.length };
  },
  openHelp() { $('help').showModal(); return { open: true }; },
};

export function initGuide(run) {
  $('help-open').addEventListener('click', () => run('open_help'));
  $('help-close').addEventListener('click', () => $('help').close());
  $('help-tour').addEventListener('click', () => run('start_tour'));
  $('splash-tour').addEventListener('click', () => run('start_tour'));
  $('splash-start').addEventListener('click', () => { remember(); $('splash').close(); });
  $('splash').addEventListener('cancel', remember);
  $('tour-next').addEventListener('click', () => show(step + 1));
  $('tour-back').addEventListener('click', () => show(step - 1));
  $('tour-skip').addEventListener('click', () => show(-1));
  $('tour').addEventListener('cancel', e => { e.preventDefault(); show(-1); });
  addEventListener('resize', () => { if (step >= 0) place(); });
  if (firstVisit()) $('splash').showModal();
}
