// Settings in localStorage and the last photo in IndexedDB, both on this device only.
// Every call tolerates a browser that blocks storage: the page then starts fresh each time.
const SETTINGS_KEY = 'argentix.settings';
const RANGES = { ev: [-2, 2], print: [-1, 1], y: [-20, 20], m: [-20, 20] };

export function saveSettings(s) {
  const { stock, paper, paperChosen, ev, print, y, m, grain, halation } = s;
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ stock, paper, paperChosen, ev, print, y, m, grain, halation })); } catch { /* storage blocked */ }
}

// settings that no longer match the catalog or the slider ranges are dropped, not repaired
export function loadSettings(catalog) {
  let s;
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY)); } catch { return null; }
  if (!s || !catalog.films.some(f => f.id === s.stock)) return null;
  for (const [k, [lo, hi]] of Object.entries(RANGES)) if (!(typeof s[k] === 'number' && s[k] >= lo && s[k] <= hi)) return null;
  return { stock: s.stock, paper: s.paper, paperChosen: !!s.paperChosen, ev: s.ev, print: s.print, y: s.y, m: s.m, grain: !!s.grain, halation: !!s.halation };
}

function db() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('argentix', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('photo');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

// resolves once the write has committed, or failed: a full or blocked store keeps the photo until reload only
export async function savePhoto(blob, name) {
  let d;
  try {
    d = await db();
    await new Promise((resolve, reject) => {
      const tx = d.transaction('photo', 'readwrite');
      tx.objectStore('photo').put({ blob, name }, 'last');
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } catch { /* storage blocked or full */ } finally { d?.close(); }
}

export async function loadPhoto() {
  let d;
  try {
    d = await db();
    return await new Promise(resolve => {
      const r = d.transaction('photo').objectStore('photo').get('last');
      r.onsuccess = () => resolve(r.result?.blob instanceof Blob ? r.result : null);
      r.onerror = () => resolve(null);
    });
  } catch { return null; } finally { d?.close(); }
}
