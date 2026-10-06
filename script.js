/* ---------- Storage (IndexedDB) ---------- */

const DB_NAME = 'tasteOfHome';
const DB_VERSION = 2;
let dbPromise = null;

/* Some browsers refuse IndexedDB outright (Safari opening the file straight
   off disk, some private windows). Then everything lives here instead, so
   the recipes still show; changes just don't outlast the tab. */
const memoryStores = { recipes: new Map(), glossary: new Map(), thumbs: new Map() };

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('recipes')) {
        db.createObjectStore('recipes', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('glossary')) {
        db.createObjectStore('glossary', { keyPath: 'id' });
      }
      /* Small copies of each photo, so a card never decodes a 1600px original
         to fill an 84px square. */
      if (!db.objectStoreNames.contains('thumbs')) {
        db.createObjectStore('thumbs', { keyPath: 'id' });
      }
    };
    /* Another tab still running an older version can hold the database in
       its old shape, and the browser makes this page wait, with no limit,
       for that tab to let go. Give it a few seconds, then carry on from
       memory so the recipes show regardless. */
    let settled = false;
    const settle = (db) => {
      if (settled) return;
      settled = true;
      resolve(db);
    };
    request.onblocked = () => {
      setTimeout(() => {
        if (settled) return;
        console.warn('Saved recipes are held by another tab running an older version; showing the built-in recipes for now.');
        showToast('This page is open in another tab with an older version. Close that tab and refresh to see your saved recipes.');
        settle(null);
      }, 3000);
    };
    request.onsuccess = () => {
      const db = request.result;
      /* Opened only after we gave up waiting: leave it for next time. */
      if (settled) {
        db.close();
        return;
      }
      /* And never be that blocking tab ourselves: let a newer version in. */
      db.onversionchange = () => {
        db.close();
        showToast('A newer version of this page was opened. Refresh to keep working here.');
      };
      settle(db);
    };
    request.onerror = () => {
      console.warn('IndexedDB unavailable, keeping recipes in memory:', request.error);
      settle(null);
    };
  });
  return dbPromise;
}

async function dbGetAll(storeName) {
  const db = await openDB();
  if (!db) return Array.from(memoryStores[storeName].values());
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(storeName, value) {
  const db = await openDB();
  if (!db) {
    memoryStores[storeName].set(value.id, value);
    return undefined;
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(storeName, id) {
  const db = await openDB();
  if (!db) {
    memoryStores[storeName].delete(id);
    return undefined;
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGet(storeName, id) {
  const db = await openDB();
  if (!db) return memoryStores[storeName].get(id);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function makeId() {
  return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

/* ---------- Confirm dialog ---------- */

/* Replaces window.confirm so the question is asked on the same paper as
   everything else. Resolves true only if they pick the confirm button. */
function askConfirm({ title, body, confirmLabel = 'Delete', cancelLabel = 'Keep it' }) {
  const overlay = document.getElementById('confirm-overlay');
  const okBtn = document.getElementById('confirm-ok');
  const cancelBtn = document.getElementById('confirm-cancel');
  const previouslyFocused = document.activeElement;

  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-body').textContent = body;
  okBtn.textContent = confirmLabel;
  cancelBtn.textContent = cancelLabel;

  overlay.classList.remove('hidden');
  document.body.classList.add('modal-open');
  cancelBtn.focus();

  return new Promise((resolve) => {
    function finish(answer) {
      overlay.classList.add('hidden');
      if (document.querySelectorAll('.form-overlay:not(.hidden)').length === 0) {
        document.body.classList.remove('modal-open');
      }
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey, true);
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus({ preventScroll: true });
      resolve(answer);
    }

    function onOk() { finish(true); }
    function onCancel() { finish(false); }
    function onBackdrop(e) { if (e.target === overlay) finish(false); }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
    }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey, true);
  });
}

/* ---------- Seed recipes ---------- */

/* Which built-in recipes this browser has been given, so one deleted here
   doesn't come back on the next visit. */
const SEEDED_IDS_KEY = 'tasteOfHome.seededRecipeIds';

/* localStorage throws instead of returning nothing when site data is blocked. */
function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // blocked: the recipes are simply checked again next visit
  }
}

function canFetchLocalFiles() {
  return location.protocol === 'http:' || location.protocol === 'https:';
}

/* A fingerprint of a built-in recipe as recipes-seed.js has it. A browser
   copy still carrying an older fingerprint was never edited in that browser
   (saving the form drops it), so it's safe to bring up to date. */
function seedFingerprint(recipe) {
  const { order, ...content } = recipe;
  const text = JSON.stringify(content);
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/* Media is shown straight from its file in ./media/ until the background
   fetch below has a copy in the browser. */
function seedCopy(recipe, order) {
  return {
    ...recipe,
    order,
    seedHash: seedFingerprint(recipe),
    media: (recipe.media || []).map((item) => ({ ...item, description: item.description || '' })),
  };
}

async function syncSeedRecipes() {
  if (typeof SEED_RECIPES === 'undefined') return;

  const existing = await dbGetAll('recipes');
  const byId = new Map(existing.map((r) => [r.id, r]));

  let delivered = null;
  try {
    delivered = JSON.parse(readStorage(SEEDED_IDS_KEY));
  } catch {
    delivered = null;
  }
  const deliveredIds = new Set(Array.isArray(delivered) ? delivered : existing.map((r) => r.id));

  const lineup = [...existing].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const changed = new Set();
  const staleMediaIds = [];
  let adoptSeedOrder = false;

  for (const seed of SEED_RECIPES) {
    const current = byId.get(seed.id);

    if (!current) {
      if (deliveredIds.has(seed.id)) continue; // deleted in this browser
      /* New to this browser: slot it in where the seed puts it. */
      const fresh = seedCopy(seed, 0);
      lineup.splice(Math.min(seed.order ?? lineup.length, lineup.length), 0, fresh);
      changed.add(fresh);
      continue;
    }

    /* A copy carrying a fingerprint is refreshed when the seed has moved on.
       One without came from before fingerprints existed (the first
       version's seeding, or a restored backup) and is only kept if it was
       saved through the form since, which stamps editedAt; otherwise it's
       older than the seed, which was built from those same recipes. */
    const presync = !current.seedHash && !current.editedAt;
    const outdated = current.seedHash ? current.seedHash !== seedFingerprint(seed) : presync;
    if (!outdated) continue;
    if (presync) adoptSeedOrder = true;

    const refreshed = seedCopy(seed, current.order);
    lineup[lineup.indexOf(current)] = refreshed;
    changed.add(refreshed);
    (current.media || []).forEach((m) => staleMediaIds.push(m.id));
  }

  /* Pre-fingerprint copies brought their order from an old seed or backup,
     not from anyone dragging cards here, so take the current one. */
  if (adoptSeedOrder) {
    const seedOrder = new Map(SEED_RECIPES.map((r, i) => [r.id, i]));
    const rank = (r) => (seedOrder.has(r.id) ? seedOrder.get(r.id) : SEED_RECIPES.length);
    lineup.sort((a, b) => rank(a) - rank(b));
  }

  lineup.forEach((recipe, i) => {
    if (recipe.order !== i) {
      recipe.order = i;
      changed.add(recipe);
    }
  });

  for (const recipe of changed) await dbPut('recipes', recipe);
  /* Thumbnails are keyed by media id, and a refreshed file may differ. */
  for (const id of staleMediaIds) await dbDelete('thumbs', id);
  thumbIndex = null;

  SEED_RECIPES.forEach((r) => deliveredIds.add(r.id));
  writeStorage(SEEDED_IDS_KEY, JSON.stringify([...deliveredIds]));
}

/* The file itself, for sharing and backing up: the copy held in the browser,
   or failing that, fetched from ./media/. */
async function mediaBlob(item) {
  if (item.blob) return item.blob;
  if (!item.src || !canFetchLocalFiles()) return null;
  try {
    const response = await fetch(item.src);
    return response.ok ? await response.blob() : null;
  } catch {
    return null;
  }
}

/* After the page is up, quietly pull built-in media into the browser, one
   file at a time, so sharing has files to attach and photos get thumbnails
   on the next visit. Nothing waits on this. */
async function fetchSeedMediaInBackground() {
  if (!canFetchLocalFiles()) return;
  const recipes = await dbGetAll('recipes');

  for (const { id } of recipes) {
    const recipe = await dbGet('recipes', id);
    const missing = (recipe?.media || []).filter((m) => !m.blob && m.src);

    for (const item of missing) {
      const blob = await mediaBlob(item);
      if (!blob) continue;
      /* Read again just before writing, in case it was edited meanwhile. */
      const latest = await dbGet('recipes', id);
      const target = latest?.media?.find((m) => m.id === item.id && m.src === item.src);
      if (!target) continue;
      target.blob = blob;
      await dbPut('recipes', latest);
      if (recipeCache.has(id)) recipeCache.set(id, latest);
    }
  }
}

/* ---------- Glossary ---------- */

/* Used only if recipes-seed.js is missing its own glossary. */
const DEFAULT_GLOSSARY = [
  { term: '一把 (a handful)', meaning: '~30g' },
  { term: '少许 (a little)', meaning: '~1/4 tsp' },
  { term: '$2 worth of ginger', meaning: 'a thumb-sized knob, ~15g' },
];

/* Which built-in glossary this browser last took in, so it can tell when
   recipes-seed.js has a newer one. */
const SEEDED_GLOSSARY_KEY = 'tasteOfHome.seededGlossary';

/* Every phrase that has ever shipped with the site. A browser's copy of one
   of these came from the project, not from its visitor, so it can be swapped
   for the current list. */
const PAST_SEED_GLOSSARY = [
  ['$2 worth of ginger', 'a thumb-sized knob, ~15g'],
  ['一大汤匙', 'about 2 tbsp'],
  ['一把', 'a handful  ~30g'],
  ['一把 (a handful)', '~30g'],
  ['一点点', '1/2 tbsp'],
  ['一粒椰糖', '1 block of Palm sugar (100g)'],
  ['两块钱姜', '$2 worth of ginger, a thumb-sized knob, ~15g'],
  ['少许', 'a little  ~1/4 tsp'],
  ['少许 (a little)', '~1/4 tsp'],
];

/* Brings this browser's glossary up to the built-in one whenever that
   changes: built-in phrases are replaced and put in the site's order, and
   phrases the visitor added or edited themselves are kept after them. */
async function syncSeedGlossary() {
  const seed = typeof SEED_GLOSSARY !== 'undefined' && SEED_GLOSSARY.length
    ? SEED_GLOSSARY
    : DEFAULT_GLOSSARY;
  const fingerprint = seedFingerprint({ glossary: seed });
  const existing = sortGlossary(await dbGetAll('glossary'));
  if (existing.length && readStorage(SEEDED_GLOSSARY_KEY) === fingerprint) return;

  const builtIn = new Set(
    [...PAST_SEED_GLOSSARY, ...seed.map((e) => [e.term, e.meaning])].map(([t, m]) => `${t}\u0000${m}`)
  );
  const fromProject = (e) => e.fromSeed || builtIn.has(`${e.term}\u0000${e.meaning}`);
  const own = existing.filter((e) => !fromProject(e));

  for (const e of existing) if (fromProject(e)) await dbDelete('glossary', e.id);
  for (const [order, entry] of seed.entries()) {
    await dbPut('glossary', { id: makeId(), term: entry.term, meaning: entry.meaning, order, fromSeed: true });
  }
  for (const [i, entry] of own.entries()) {
    await dbPut('glossary', { ...entry, order: seed.length + i });
  }
  writeStorage(SEEDED_GLOSSARY_KEY, fingerprint);
}

/* Phrases in the order they've been dragged into. Ones saved before ordering
   existed keep the order they were showing in, after the ordered ones. */
function sortGlossary(entries) {
  return entries
    .map((entry, i) => ({ entry, rank: typeof entry.order === 'number' ? entry.order : 1e6 + i }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ entry }) => entry);
}

async function persistGlossaryOrder() {
  const ids = Array.from(document.querySelectorAll('#glossary-list li[data-id]')).map((li) => li.dataset.id);
  for (let i = 0; i < ids.length; i += 1) {
    const entry = await dbGet('glossary', ids[i]);
    if (entry && entry.order !== i) await dbPut('glossary', { ...entry, order: i });
  }
}

async function renderGlossary(filterText = '') {
  const list = document.getElementById('glossary-list');
  const all = sortGlossary(await dbGetAll('glossary'));
  const filtered = all.filter((entry) =>
    entry.term.toLowerCase().includes(filterText.toLowerCase()) ||
    entry.meaning.toLowerCase().includes(filterText.toLowerCase())
  );

  /* The total lives in the search placeholder; the match count only shows
     inside the field while searching. */
  const search = document.getElementById('glossary-search');
  search.placeholder = all.length
    ? `Search ${all.length} decoded phrase${all.length === 1 ? '' : 's'}…`
    : 'Nothing decoded yet, add one above';
  document.getElementById('glossary-count').textContent = filterText
    ? `${filtered.length} of ${all.length}`
    : '';

  /* Reordering a search's matches would be guesswork about where they sit in
     the full list, so the handles only show when nothing is filtered. */
  const sortable = !filterText;
  list.classList.toggle('sortable', sortable);
  const handle = sortable
    ? `<button type="button" class="drag-handle glossary-grip" aria-label="Drag to reorder, or use the arrow keys">${ICON.grip}</button>`
    : '';

  list.innerHTML = filtered
    .map(
      (entry) => `
        <li data-id="${entry.id}">
          ${handle}
          <span class="term">${entry.term}</span>
          <span class="arrow">→</span>
          <span class="meaning">${entry.meaning}</span>
          <button type="button" class="edit-term" aria-label="Edit this phrase">${ICON.edit}</button>
          <button type="button" class="delete-term" aria-label="Remove">${ICON.trash}</button>
        </li>
      `
    )
    .join('') || `<li class="glossary-empty">Nothing matches “${filterText}”.</li>`;
}

function currentGlossaryFilter() {
  return document.getElementById('glossary-search').value;
}

/* Swaps one row for two inputs. Built with DOM nodes rather than a string so
   phrases containing quotes survive the round trip intact. */
function startEditingTerm(li, entry) {
  li.classList.add('editing');
  li.innerHTML = '';

  const termInput = document.createElement('input');
  termInput.type = 'text';
  termInput.className = 'edit-input edit-term-input';
  termInput.value = entry.term;
  termInput.setAttribute('aria-label', 'Her phrase');

  const arrow = document.createElement('span');
  arrow.className = 'arrow';
  arrow.textContent = '→';

  const meaningInput = document.createElement('input');
  meaningInput.type = 'text';
  meaningInput.className = 'edit-input edit-meaning-input';
  meaningInput.value = entry.meaning;
  meaningInput.setAttribute('aria-label', 'Real measurement');

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'mini-btn save-term';
  save.textContent = 'Save';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'quiet-btn cancel-edit';
  cancel.textContent = 'Cancel';

  li.append(termInput, arrow, meaningInput, cancel, save);
  termInput.focus();
  termInput.select();

  [termInput, meaningInput].forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save.click();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel.click();
      }
    });
  });
}

async function saveEditedTerm(li) {
  const term = li.querySelector('.edit-term-input').value.trim();
  const meaning = li.querySelector('.edit-meaning-input').value.trim();
  if (!term || !meaning) {
    showToast('Both halves need something in them');
    return;
  }

  const entry = await dbGet('glossary', li.dataset.id);
  /* Edited here, so it's this visitor's now: built-in updates leave it be. */
  await dbPut('glossary', { ...entry, term, meaning, fromSeed: false });
  await renderGlossary(currentGlossaryFilter());
  showToast('Glossary updated');
}

/* Clicking "+ Add" with a half missing: mark the empty field(s), say what's
   needed, and put the cursor where to start. Typing clears it. */
function showGlossaryAddError(termMissing, meaningMissing, { moveFocus = true } = {}) {
  const term = document.getElementById('glossary-term');
  const meaning = document.getElementById('glossary-meaning');
  const error = document.getElementById('glossary-add-error');
  term.setAttribute('aria-invalid', String(termMissing));
  meaning.setAttribute('aria-invalid', String(meaningMissing));
  error.textContent = termMissing && meaningMissing
    ? 'Write what Mum says and what it really means, then add it.'
    : termMissing
      ? 'Add what Mum says too, e.g. 一点点.'
      : 'Add what it really means too, e.g. ~½ tbsp.';
  error.hidden = false;
  if (moveFocus) (termMissing ? term : meaning).focus();
}

function clearGlossaryAddError() {
  document.getElementById('glossary-term').removeAttribute('aria-invalid');
  document.getElementById('glossary-meaning').removeAttribute('aria-invalid');
  const error = document.getElementById('glossary-add-error');
  error.hidden = true;
  error.textContent = '';
}

function setupGlossary() {
  ['glossary-term', 'glossary-meaning'].forEach((id) => {
    document.getElementById(id).addEventListener('input', (e) => {
      const error = document.getElementById('glossary-add-error');
      if (error.hidden) return;
      /* Narrow the message to whatever is still missing, or clear it. */
      const termMissing = !document.getElementById('glossary-term').value.trim();
      const meaningMissing = !document.getElementById('glossary-meaning').value.trim();
      if (termMissing || meaningMissing) showGlossaryAddError(termMissing, meaningMissing, { moveFocus: false });
      else clearGlossaryAddError();
    });
  });

  document.getElementById('glossary-search').addEventListener('input', (e) => {
    renderGlossary(e.target.value);
  });

  ['glossary-term', 'glossary-meaning'].forEach((id) => {
    document.getElementById(id).addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      document.getElementById('glossary-submit').click();
    });
  });

  document.getElementById('glossary-submit').addEventListener('click', async () => {
    const termInput = document.getElementById('glossary-term');
    const meaningInput = document.getElementById('glossary-meaning');
    const term = termInput.value.trim();
    const meaning = meaningInput.value.trim();
    if (!term || !meaning) {
      showGlossaryAddError(!term, !meaning);
      return;
    }
    clearGlossaryAddError();

    const existing = await dbGetAll('glossary');
    const match = existing.find((entry) => entry.term.trim().toLowerCase() === term.toLowerCase());
    if (match) {
      await dbPut('glossary', { ...match, meaning, fromSeed: false });
      showToast(`Updated “${match.term}”`);
    } else {
      /* New phrases go to the top, where they can be seen landing. */
      const orders = existing.map((entry) => entry.order).filter((n) => typeof n === 'number');
      const order = (orders.length ? Math.min(...orders) : 0) - 1;
      await dbPut('glossary', { id: makeId(), term, meaning, order });
      showToast(`Added “${term}”`);
    }

    termInput.value = '';
    meaningInput.value = '';
    document.getElementById('glossary-search').value = '';
    termInput.focus();
    renderGlossary();
  });

  makeSortable(document.getElementById('glossary-list'), 'li[data-id]', persistGlossaryOrder);

  document.getElementById('glossary-list').addEventListener('click', async (e) => {
    const li = e.target.closest('li');
    if (!li) return;

    if (e.target.classList.contains('edit-term')) {
      const entry = await dbGet('glossary', li.dataset.id);
      if (entry) startEditingTerm(li, entry);
      return;
    }

    if (e.target.classList.contains('save-term')) {
      await saveEditedTerm(li);
      return;
    }

    if (e.target.classList.contains('cancel-edit')) {
      renderGlossary(currentGlossaryFilter());
      return;
    }

    if (!e.target.classList.contains('delete-term')) return;
    const term = li.querySelector('.term').textContent;
    const ok = await askConfirm({
      title: 'Take this phrase off the list?',
      body: `"${term}" comes off the glossary. You can add it back the next time it comes up.`,
      confirmLabel: 'Remove it',
      cancelLabel: 'Keep it',
    });
    if (!ok) return;
    await dbDelete('glossary', li.dataset.id);
    renderGlossary(document.getElementById('glossary-search').value);
  });
}

/* ---------- Recipe form ---------- */

function addIngredientRow(her = '', mine = '') {
  const container = document.getElementById('ingredient-rows');
  const row = document.createElement('div');
  row.className = 'ingredient-row-input';
  row.innerHTML = `
    <button type="button" class="drag-handle" aria-label="Drag to reorder, or use the arrow keys">⠿</button>
    <span class="field-with-mic">
      <input type="text" class="ing-her" placeholder="Her words (e.g. 一把姜)" value="${her}">
      <button type="button" class="mic-btn" data-lang="zh-CN" aria-label="Record her words with voice">${ICON.mic}</button>
    </span>
    <span class="field-with-mic">
      <input type="text" class="ing-mine" placeholder="Your translation (e.g. ~30g)" value="${mine}">
      <button type="button" class="mic-btn" data-lang="en-SG" aria-label="Record your translation with voice">${ICON.mic}</button>
    </span>
    <button type="button" class="remove-row" aria-label="Remove">${ICON.trash}</button>
  `;
  container.appendChild(row);
}

function addStepRow(text = '') {
  const container = document.getElementById('step-rows');
  const row = document.createElement('div');
  row.className = 'step-row-input';
  row.innerHTML = `
    <button type="button" class="drag-handle" aria-label="Drag to reorder, or use the arrow keys">⠿</button>
    <span class="field-with-mic">
      <input type="text" class="step-text" placeholder="Step description" value="${text}">
      <button type="button" class="mic-btn" data-lang="en-SG" aria-label="Record this step with voice">${ICON.mic}</button>
    </span>
    <button type="button" class="remove-row" aria-label="Remove">${ICON.trash}</button>
  `;
  container.appendChild(row);
}

let editingRecipe = null;
let currentMedia = [];

function renderExistingMediaPreview() {
  const container = document.getElementById('existing-media-preview');
  if (!currentMedia.length) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = `
    <p class="section-note">Drag &#10303; to reorder. Names and notes appear when a file is opened.</p>
    <div class="media-editor"></div>
  `;

  const list = container.querySelector('.media-editor');

  currentMedia.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'media-row';
    row.dataset.mediaId = m.id;

    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'drag-handle';
    handle.setAttribute('aria-label', 'Drag to reorder, or use the arrow keys');
    handle.textContent = '⠿';

    const thumb = document.createElement('div');
    thumb.className = 'media-thumb';
    if (m.type === 'audio') {
      thumb.innerHTML = '<span class="audio-thumb">🎙</span>';
    } else if (m.type === 'video') {
      thumbBlobFor(m).then((frame) => {
        const still = frame ? URL.createObjectURL(frame) : m.poster;
        thumb.innerHTML = still
          ? `<span class="thumb-wrap"><img src="${still}" alt="" decoding="async"><span class="play-badge">▶</span></span>`
          : `<span class="thumb-wrap"><video src="${m.blob ? URL.createObjectURL(m.blob) : m.src}" muted preload="metadata"></video><span class="play-badge">▶</span></span>`;
      });
    } else {
      thumbBlobFor(m).then((blob) => {
        thumb.innerHTML = `<img src="${blob ? URL.createObjectURL(blob) : m.src}" alt="" decoding="async">`;
      });
    }

    const fields = document.createElement('div');
    fields.className = 'media-fields';

    /* Values are set as properties, not attributes, so quotes in a name survive. */
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'media-name-input';
    nameInput.placeholder = 'Name this one';
    nameInput.value = m.name || '';
    nameInput.setAttribute('aria-label', 'Name');

    const descInput = document.createElement('input');
    descInput.type = 'text';
    descInput.className = 'media-desc-input';
    descInput.placeholder = 'A note about it (optional)';
    descInput.value = m.description || '';
    descInput.setAttribute('aria-label', 'Description, optional');

    fields.append(nameInput, descInput);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-media';
    remove.setAttribute('aria-label', 'Remove from gallery');
    remove.innerHTML = ICON.trash;

    row.append(handle, thumb, fields, remove);
    list.appendChild(row);
  });
}

function fillFormForEdit(recipe) {
  editingRecipe = recipe;
  currentMedia = recipe && recipe.media
    ? recipe.media.map((m) => ({ ...m, id: m.id || makeId(), description: m.description || '' }))
    : [];
  document.getElementById('recipe-form').reset();
  document.getElementById('ingredient-rows').innerHTML = '';
  document.getElementById('step-rows').innerHTML = '';

  if (recipe) {
    document.getElementById('field-name-en').value = recipe.nameEn;
    document.getElementById('field-name-cn').value = recipe.nameCn || '';
    document.getElementById('field-story').value = recipe.story || '';
    const ingredients = recipe.ingredients.length ? recipe.ingredients : [{ her: '', mine: '' }];
    ingredients.forEach((row) => addIngredientRow(row.her, row.mine));
    const steps = recipe.steps.length ? recipe.steps : [''];
    steps.forEach((step) => addStepRow(step));
    document.getElementById('recipe-form-heading').textContent = 'Edit Recipe';
    document.getElementById('recipe-form-submit').textContent = 'Save changes';
  } else {
    addIngredientRow();
    addStepRow();
    document.getElementById('recipe-form-heading').textContent = 'Add a Recipe';
    document.getElementById('recipe-form-submit').textContent = 'Save recipe';
  }
  renderExistingMediaPreview();
}

function openRecipeForm(recipe = null) {
  fillFormForEdit(recipe);
  document.getElementById('recipe-form-overlay').classList.remove('hidden');
  document.body.classList.add('modal-open');
}

function closeRecipeForm() {
  document.getElementById('recipe-form-overlay').classList.add('hidden');
  document.body.classList.remove('modal-open');
  fillFormForEdit(null);
}

async function handleRecipeSubmit(e) {
  e.preventDefault();

  const nameEn = document.getElementById('field-name-en').value.trim();
  const nameCn = document.getElementById('field-name-cn').value.trim();
  const story = document.getElementById('field-story').value.trim();
  if (!nameEn) return;

  const ingredients = Array.from(document.querySelectorAll('.ingredient-row-input'))
    .map((row) => ({
      her: row.querySelector('.ing-her').value.trim(),
      mine: row.querySelector('.ing-mine').value.trim(),
    }))
    .filter((row) => row.her || row.mine);

  const steps = Array.from(document.querySelectorAll('.step-text'))
    .map((input) => input.value.trim())
    .filter(Boolean);

  let order;
  if (editingRecipe) {
    order = typeof editingRecipe.order === 'number' ? editingRecipe.order : 0;
  } else {
    const all = await dbGetAll('recipes');
    order = all.length
      ? Math.max(...all.map((r) => (typeof r.order === 'number' ? r.order : 0))) + 1
      : 0;
  }

  const recipe = {
    id: editingRecipe ? editingRecipe.id : makeId(),
    nameEn,
    nameCn,
    story,
    ingredients,
    steps,
    media: currentMedia,
    order,
    createdAt: editingRecipe ? editingRecipe.createdAt : Date.now(),
    /* Marks this as changed in this browser, so built-in updates leave it be. */
    editedAt: Date.now(),
  };

  await dbPut('recipes', recipe);
  closeRecipeForm();
  renderRecipes();
}

/* Pointer events rather than HTML5 drag and drop, so this works on a phone
   as well as with a mouse. Used for media, ingredients and steps alike. */
function makeSortable(container, rowSelector, onChange = () => {}) {
  let dragRow = null;

  function rowsIn(list) {
    return Array.from(list.querySelectorAll(rowSelector));
  }

  container.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.drag-handle');
    if (!handle) return;
    e.preventDefault();
    dragRow = handle.closest(rowSelector);
    dragRow.classList.add('dragging');
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      // Some pointer types refuse capture; the drag still tracks fine without it.
    }
  });

  container.addEventListener('pointermove', (e) => {
    if (!dragRow) return;
    const list = dragRow.parentElement;

    for (const row of rowsIn(list)) {
      if (row === dragRow) continue;
      const box = row.getBoundingClientRect();
      if (e.clientY < box.top || e.clientY > box.bottom) continue;
      const above = e.clientY < box.top + box.height / 2;
      list.insertBefore(dragRow, above ? row : row.nextSibling);
      break;
    }
  });

  function finish() {
    if (!dragRow) return;
    dragRow.classList.remove('dragging');
    dragRow = null;
    onChange();
  }

  container.addEventListener('pointerup', finish);
  container.addEventListener('pointercancel', finish);

  /* Same move from the keyboard, for anyone not using a pointer. */
  container.addEventListener('keydown', (e) => {
    const handle = e.target.closest('.drag-handle');
    if (!handle || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();

    const row = handle.closest(rowSelector);
    const list = row.parentElement;
    if (e.key === 'ArrowUp' && row.previousElementSibling) {
      list.insertBefore(row, row.previousElementSibling);
    } else if (e.key === 'ArrowDown' && row.nextElementSibling) {
      list.insertBefore(row.nextElementSibling, row);
    }
    onChange();
    row.querySelector('.drag-handle').focus();
  });
}

function setupReordering() {
  const mediaContainer = document.getElementById('existing-media-preview');

  makeSortable(mediaContainer, '.media-row', () => {
    /* Ingredients and steps are read back off the page when the form is saved,
       so only the media array needs putting back in step. */
    const ids = Array.from(mediaContainer.querySelectorAll('.media-row')).map((r) => r.dataset.mediaId);
    currentMedia.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  });

  makeSortable(document.getElementById('ingredient-rows'), '.ingredient-row-input');
  makeSortable(document.getElementById('step-rows'), '.step-row-input');
}

function setupRecipeForm() {
  document.getElementById('open-recipe-form').addEventListener('click', () => openRecipeForm());
  document.getElementById('close-recipe-form').addEventListener('click', closeRecipeForm);
  document.getElementById('recipe-form-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'recipe-form-overlay') closeRecipeForm();
  });

  document.getElementById('add-ingredient').addEventListener('click', () => addIngredientRow());
  document.getElementById('add-step').addEventListener('click', () => addStepRow());

  document.getElementById('add-media').addEventListener('click', () => {
    document.getElementById('field-media').click();
  });

  document.getElementById('field-media').addEventListener('change', (e) => {
    const files = Array.from(e.target.files);
    files.forEach((file) => {
      currentMedia.push({
        id: makeId(),
        type: mediaTypeOf(file),
        blob: file,
        name: file.name,
      });
    });
    e.target.value = '';
    renderExistingMediaPreview();
  });

  document.getElementById('recipe-form').addEventListener('click', (e) => {
    if (e.target.closest('.remove-row')) {
      e.target.closest('.ingredient-row-input, .step-row-input').remove();
    }
    if (e.target.closest('.remove-media')) {
      const id = e.target.closest('.media-row').dataset.mediaId;
      currentMedia = currentMedia.filter((m) => m.id !== id);
      renderExistingMediaPreview();
    }
  });

  document.getElementById('existing-media-preview').addEventListener('input', (e) => {
    const row = e.target.closest('.media-row');
    if (!row) return;
    const item = currentMedia.find((m) => m.id === row.dataset.mediaId);
    if (!item) return;
    if (e.target.classList.contains('media-name-input')) {
      item.name = e.target.value.trim();
    } else if (e.target.classList.contains('media-desc-input')) {
      item.description = e.target.value.trim();
    }
  });

  document.getElementById('recipe-form').addEventListener('submit', handleRecipeSubmit);

  fillFormForEdit(null);
}

/* ---------- Recipe ordering ---------- */

async function ensureRecipeOrder(recipes) {
  const needsMigration = recipes.some((r) => typeof r.order !== 'number');
  if (!needsMigration) return recipes;
  recipes.sort((a, b) => b.createdAt - a.createdAt);
  await Promise.all(
    recipes.map((r, i) => {
      r.order = i;
      return dbPut('recipes', r);
    })
  );
  return recipes;
}

async function persistRecipeOrder() {
  const grid = document.getElementById('recipe-grid');
  const ids = Array.from(grid.querySelectorAll('.recipe-card[data-id]')).map((c) => c.dataset.id);

  for (let i = 0; i < ids.length; i += 1) {
    const recipe = await dbGet('recipes', ids[i]);
    if (recipe && recipe.order !== i) {
      recipe.order = i;
      await dbPut('recipes', recipe);
    }
  }
}

/* Cards sit in a grid, so a drag has to read across as well as down. */
function setupRecipeDragging() {
  const grid = document.getElementById('recipe-grid');
  let dragCard = null;

  function cards() {
    return Array.from(grid.querySelectorAll('.recipe-card[data-id]'));
  }

  grid.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.drag-recipe');
    if (!handle) return;
    e.preventDefault();
    dragCard = handle.closest('.recipe-card[data-id]');
    dragCard.classList.add('dragging');
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      // Capture isn't available for every pointer type; the drag still tracks.
    }
  });

  grid.addEventListener('pointermove', (e) => {
    if (!dragCard) return;
    const dragBox = dragCard.getBoundingClientRect();

    for (const card of cards()) {
      if (card === dragCard) continue;
      const box = card.getBoundingClientRect();
      if (e.clientX < box.left || e.clientX > box.right) continue;
      if (e.clientY < box.top || e.clientY > box.bottom) continue;

      /* Side by side: compare left to right. Stacked: compare top to bottom. */
      const sameRow = Math.abs(box.top - dragBox.top) < box.height / 2;
      const after = sameRow
        ? e.clientX > box.left + box.width / 2
        : e.clientY > box.top + box.height / 2;

      grid.insertBefore(dragCard, after ? card.nextSibling : card);
      break;
    }
  });

  async function finish() {
    if (!dragCard) return;
    dragCard.classList.remove('dragging');
    dragCard = null;
    await persistRecipeOrder();
    renderRecipes();
  }

  grid.addEventListener('pointerup', finish);
  grid.addEventListener('pointercancel', finish);

  grid.addEventListener('keydown', async (e) => {
    const handle = e.target.closest('.drag-recipe');
    const keys = ['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'];
    if (!handle || !keys.includes(e.key)) return;
    e.preventDefault();

    const card = handle.closest('.recipe-card[data-id]');
    const id = card.dataset.id;
    const earlier = e.key === 'ArrowUp' || e.key === 'ArrowLeft';

    if (earlier && card.previousElementSibling) {
      grid.insertBefore(card, card.previousElementSibling);
    } else if (!earlier && card.nextElementSibling) {
      grid.insertBefore(card.nextElementSibling, card);
    } else {
      return;
    }

    await persistRecipeOrder();
    await renderRecipes();
    const moved = grid.querySelector(`.recipe-card[data-id="${id}"] .drag-recipe`);
    if (moved) moved.focus();
  });
}

/* ---------- Sharing ---------- */

let toastTimer = null;

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  /* Longer messages (instructions, not just "Saved") stay up long enough to read. */
  const duration = Math.min(8000, Math.max(2600, message.length * 55));
  toastTimer = setTimeout(() => toast.classList.add('hidden'), duration);
}

const DEFAULT_SHARE_NAME = { video: 'video', audio: 'recording', image: 'photo' };
const DEFAULT_SHARE_TYPE = { video: 'video/mp4', audio: 'audio/mp4', image: 'image/jpeg' };
const SHARE_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic',
  'video/quicktime': 'mov', 'video/mp4': 'mp4', 'video/webm': 'webm',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav',
};

/* The name typed in the form becomes the filename, tidied up and given a real
   extension so the receiving app knows what it is. */
function shareFileName(item) {
  const type = (item.blob && item.blob.type) || DEFAULT_SHARE_TYPE[item.type] || 'image/jpeg';
  const ext = SHARE_EXT[type] || type.split('/')[1] || 'jpg';
  const base = (item.name || DEFAULT_SHARE_NAME[item.type] || 'photo')
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'photo';
  return `${base}.${ext}`;
}

/* ---------- Recipe card as PDF ---------- */

/* A one-page PDF built by hand around the card drawn as a JPEG: an image
   filling the page, plus a link annotation over the "Open this recipe online"
   line so it can be tapped in a PDF viewer. Small enough not to need a PDF
   library. */
function cardPdf(jpegBytes, width, height, link, title) {
  const enc = new TextEncoder();
  const pageW = 595.28; // A4 width in points; the page is as long as the card
  const scale = pageW / width;
  const pageH = height * scale;
  const n = (v) => Number(v.toFixed(2));

  /* PDF strings: titles as UTF-16 hex (Chinese survives), URLs escaped. */
  const utf16Hex = (str) => {
    let hex = 'FEFF';
    for (const ch of str) {
      const code = ch.codePointAt(0);
      if (code > 0xffff) {
        const c = code - 0x10000;
        hex += (0xd800 + (c >> 10)).toString(16).padStart(4, '0');
        hex += (0xdc00 + (c & 0x3ff)).toString(16).padStart(4, '0');
      } else {
        hex += code.toString(16).padStart(4, '0');
      }
    }
    return `<${hex.toUpperCase()}>`;
  };
  const pdfString = (str) => `(${encodeURI(decodeURI(str)).replace(/[\\()]/g, (c) => `\\${c}`)})`;

  const content = `q ${n(pageW)} 0 0 ${n(pageH)} 0 0 cm /Card Do Q`;
  const annots = link ? ' /Annots [6 0 R]' : '';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(pageW)} ${n(pageH)}] /Resources << /XObject << /Card 4 0 R >> >> /Contents 5 0 R${annots} >>`,
    [`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`, jpegBytes, '\nendstream'],
    `<< /Length ${enc.encode(content).length} >>\nstream\n${content}\nendstream`,
    link
      ? `<< /Type /Annot /Subtype /Link /Border [0 0 0] /Rect [${n(link.left * scale)} ${n(pageH - link.bottom * scale)} ${n(link.right * scale)} ${n(pageH - link.top * scale)}] /A << /S /URI /URI ${pdfString(link.url)} >> >>`
      : '<< >>',
    `<< /Title ${utf16Hex(title)} /Creator (Taste of Home, kuehmachine.com) >>`,
  ];

  const parts = [];
  let length = 0;
  const push = (chunk) => {
    const bytes = typeof chunk === 'string' ? enc.encode(chunk) : chunk;
    parts.push(bytes);
    length += bytes.length;
  };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(length);
    push(`${i + 1} 0 obj\n`);
    (Array.isArray(body) ? body : [body]).forEach(push);
    push('\nendobj\n');
  });
  const xrefAt = length;
  push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  offsets.forEach((o) => push(`${String(o).padStart(10, '0')} 00000 n \n`));
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

/* ---------- Recipe links ---------- */

/* Each recipe has its own address on the site: opening it lands on the page
   with that recipe's pop-up open. Built from wherever the site is served, so
   it's a kuehmachine.com link once it lives there. */
function recipeLink(recipe) {
  return `${location.href.split('#')[0]}#recipe=${encodeURIComponent(recipe.id)}`;
}

function recipeIdFromHash() {
  const match = location.hash.match(/^#recipe=(.+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function openRecipeFromHash() {
  const id = recipeIdFromHash();
  if (!id) return;
  const detailOpen = !document.getElementById('recipe-detail-overlay').classList.contains('hidden');
  if (detailOpen && document.getElementById('recipe-detail').dataset.id === id) return;
  const recipe = recipeCache.get(id) || (await dbGet('recipes', id));
  if (recipe) {
    await openRecipeDetail(recipe);
  } else {
    showToast("That recipe isn't on this copy of the site");
  }
}

/* Where this part of the kueh machine lives once it's on the site. The PDF's
   link and the shared message both point here. */
const SITE_URL = 'https://www.kuehmachine.com/meijun/';

/* The message that travels with the PDF. */
function shareMessage(recipe) {
  const dish = [recipe.nameEn, recipe.nameCn].filter(Boolean).join(' ');
  /* *…* is WhatsApp's bold; other apps show the asterisks as they are. */
  return `Sharing the *${dish}* recipe from 家常菜 · Taste of Home. For more recipes: kuehmachine.com/meijun`;
}

/* ---------- Recipe card image (for sharing) ---------- */

/* Many apps (WhatsApp, Messages, AirDrop) keep only the pictures when a share
   carries both text and photos. So the whole recipe also goes as a picture:
   a scrapbook card drawn on a canvas, sent ahead of the photos. Cards are
   drawn ahead of time, because the share sheet has to open straight off the
   click. */

const CARD_WIDTH = 1080;
const CARD_PAD = 84;
const recipeCardCache = new Map();

function recipeCardKey(recipe) {
  const { nameEn, nameCn, story, ingredients, steps } = recipe;
  const photos = cardPhotoItems(recipe).map((m) => m.id);
  return JSON.stringify([nameEn, nameCn, story, ingredients, steps, photos]);
}

/* Breaks text into lines that fit. Chinese can break between any two
   characters; Latin text only between words. */
function wrapText(ctx, text, maxWidth) {
  const tokens = String(text || '').match(/[⺀-鿿豈-﫿＀-￯　-〿]|[^\s⺀-鿿豈-﫿＀-￯　-〿]+\s*|\s+/g) || [];
  const lines = [];
  let line = '';
  for (const token of tokens) {
    const next = line + token;
    if (line && ctx.measureText(next.trimEnd()).width > maxWidth) {
      lines.push(line.trimEnd());
      line = token.trimStart();
    } else {
      line = next;
    }
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines.length ? lines : [''];
}

/* Lays the card out once to measure its height, then again to draw it.
   photos: decoded images for the thumbnail strip under the story. */
function paintRecipeCard(ctx, recipe, draw, photos = [], withLink = false) {
  const css = getComputedStyle(document.documentElement);
  const color = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  const ink = color('--ink', '#3a2a1e');
  const inkSoft = color('--ink-soft', '#6b5a48');
  const accent = color('--accent', '#b7472a');
  const accentSoft = color('--accent-soft', '#c98a4b');
  const line = color('--line', 'rgba(58, 42, 30, 0.14)');
  const serif = "'Noto Serif SC', serif";
  const hand = "'Caveat', cursive";
  const inner = CARD_WIDTH - CARD_PAD * 2;
  let y = CARD_PAD;

  const text = (str, x, font, fill) => {
    if (!draw) return;
    ctx.font = font;
    ctx.fillStyle = fill;
    ctx.fillText(str, x, y);
  };
  /* Draws wrapped text with its first baseline at y; returns the distance
     from that baseline to the last one. */
  const block = (str, x, width, font, fill, lineHeight) => {
    ctx.font = font;
    const lines = wrapText(ctx, str, width);
    if (draw) {
      ctx.fillStyle = fill;
      lines.forEach((l, i) => ctx.fillText(l, x, y + i * lineHeight));
    }
    return (lines.length - 1) * lineHeight;
  };
  const rule = (dashed) => {
    if (!draw) return;
    ctx.save();
    ctx.strokeStyle = line;
    ctx.lineWidth = 2;
    if (dashed) ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(CARD_PAD, y);
    ctx.lineTo(CARD_WIDTH - CARD_PAD, y);
    ctx.stroke();
    ctx.restore();
  };
  const heading = (en, cn) => {
    y += 64;
    ctx.font = `600 40px ${serif}`;
    const w = ctx.measureText(en).width;
    text(en, CARD_PAD, `600 40px ${serif}`, ink);
    text(cn, CARD_PAD + w + 16, `400 30px ${serif}`, inkSoft);
    y += 30;
  };

  ctx.textBaseline = 'alphabetic';

  // Kicker, title and Chinese name
  text('家常菜 · Taste of Home', CARD_PAD, `700 34px ${hand}`, accent);
  y += 84;
  y += block(recipe.nameEn, CARD_PAD, inner, `600 60px ${serif}`, ink, 80);
  if (recipe.nameCn) {
    y += 68;
    text(recipe.nameCn, CARD_PAD, `400 40px ${serif}`, inkSoft);
  }

  // Story
  if (recipe.story) {
    y += 72;
    y += block(recipe.story, CARD_PAD, inner, `italic 400 31px ${serif}`, inkSoft, 54);
  }

  // Photo strip: up to four, cropped to fill equal 4:3 frames
  if (photos.length) {
    y += 48;
    const gap = 18;
    const w = (inner - gap * (photos.length - 1)) / photos.length;
    const h = Math.round(w * (photos.length === 1 ? 0.6 : 0.75));
    if (draw) {
      photos.forEach((img, i) => {
        const x = CARD_PAD + i * (w + gap);
        const scale = Math.max(w / img.width, h / img.height);
        const sw = w / scale;
        const sh = h / scale;
        ctx.save();
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, y, w, h, 6);
        else ctx.rect(x, y, w, h);
        ctx.clip();
        ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
        ctx.restore();
      });
    }
    y += h;
  }

  // Ingredients: her words in one column, mine in the next
  if (recipe.ingredients.length) {
    y += 64;
    rule(false);
    heading('Ingredients', '材料');
    const herWidth = inner * 0.42;
    const arrowX = CARD_PAD + herWidth + 18;
    const mineX = arrowX + 54;
    const mineWidth = CARD_WIDTH - CARD_PAD - mineX;
    recipe.ingredients.forEach((row) => {
      y += 28;
      rule(true);
      y += 54;
      const top = y;
      const herHeight = block(row.her || '', CARD_PAD, herWidth, `400 30px ${serif}`, ink, 46);
      text('→', arrowX, `400 30px ${serif}`, accentSoft);
      const mineHeight = block(row.mine || '', mineX, mineWidth, `400 30px ${serif}`, accent, 46);
      y = top + Math.max(herHeight, mineHeight);
    });
  }

  // Steps, numbered in the hand font
  if (recipe.steps.length) {
    y += 76;
    rule(false);
    heading('Steps', '做法');
    recipe.steps.forEach((step, i) => {
      y += i ? 72 : 58;
      text(`${i + 1}.`, CARD_PAD, `700 38px ${hand}`, accent);
      y += block(step, CARD_PAD + 58, inner - 58, `400 30px ${serif}`, ink, 50);
    });
  }

  // Sign-off
  y += 80;
  rule(true);
  y += 60;
  text('From 家常菜 · Taste of Home, by Mei Jun · kuehmachine.com', CARD_PAD, `500 32px ${hand}`, inkSoft);

  /* PDF only: a line to tap through to the rest of the recipes. */
  let link = null;
  if (withLink) {
    y += 62;
    const label = 'More recipes at kuehmachine.com/meijun →';
    text(label, CARD_PAD, `700 38px ${hand}`, accent);
    ctx.font = `700 38px ${hand}`;
    link = { left: CARD_PAD - 8, top: y - 40, right: CARD_PAD + ctx.measureText(label).width + 8, bottom: y + 14 };
  }
  return { height: y + CARD_PAD - 24, link };
}

/* The first few photos, decoded small, for the card's thumbnail strip. Files
   only shown from ./media/ are fetched first; opened straight off the disk
   they'd make the canvas unexportable, so they're left out there. */
const CARD_PHOTOS = 4;

function cardPhotoItems(recipe) {
  return (recipe.media || []).filter((m) => m.type === 'image').slice(0, CARD_PHOTOS);
}

async function loadCardPhotos(recipe) {
  const photos = [];
  for (const item of cardPhotoItems(recipe)) {
    try {
      const blob = item.blob || (canFetchLocalFiles() ? await mediaBlob(item) : null);
      if (!blob) continue;
      photos.push(await createImageBitmap(blob, { resizeWidth: 520, resizeQuality: 'high' }));
    } catch {
      // leave that one out
    }
  }
  return photos;
}

async function drawRecipeCard(recipe) {
  /* Google Fonts serves Chinese in slices, so ask for the glyphs this recipe
     actually uses before drawing, or the canvas falls back to a system font. */
  const sample = [recipe.nameEn, recipe.nameCn, recipe.story,
    ...recipe.ingredients.flatMap((r) => [r.her, r.mine]), ...recipe.steps,
    '家常菜 材料 做法 Taste of Home →'].join(' ');
  if (document.fonts && document.fonts.load) {
    try {
      await Promise.all([
        document.fonts.load("400 30px 'Noto Serif SC'", sample),
        document.fonts.load("600 30px 'Noto Serif SC'", sample),
        document.fonts.load("700 30px 'Caveat'", sample),
        document.fonts.load("500 30px 'Caveat'", sample),
      ]);
    } catch {
      // draw with whatever fonts are there
    }
  }

  const photos = await loadCardPhotos(recipe);
  const paper = getComputedStyle(document.documentElement).getPropertyValue('--paper-card').trim() || '#fbf4e6';

  const render = (withLink) => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = CARD_WIDTH;
    canvas.height = Math.ceil(paintRecipeCard(ctx, recipe, false, photos, withLink).height);
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const { link } = paintRecipeCard(ctx, recipe, true, photos, withLink);
    return { canvas, link };
  };
  const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

  /* The image card for downloads and previews; the PDF card adds the link. */
  const image = render(false);
  const forPdf = render(true);
  photos.forEach((p) => p.close && p.close());

  const png = await toBlob(image.canvas, 'image/png');
  const jpeg = await toBlob(forPdf.canvas, 'image/jpeg', 0.9);
  let pdf = null;
  if (jpeg) {
    const bytes = new Uint8Array(await jpeg.arrayBuffer());
    const title = [recipe.nameEn, recipe.nameCn].filter(Boolean).join(' ');
    pdf = cardPdf(bytes, forPdf.canvas.width, forPdf.canvas.height, { ...forPdf.link, url: SITE_URL }, title);
  }
  return { png, pdf };
}

/* The card for this recipe as it stands, drawing it if it isn't ready. */
async function recipeCardFiles(recipe) {
  const key = recipeCardKey(recipe);
  const cached = recipeCardCache.get(recipe.id);
  if (cached && cached.key === key) return cached;
  const { png, pdf } = await drawRecipeCard(recipe);
  const entry = { key, png, pdf };
  if (png) recipeCardCache.set(recipe.id, entry);
  return entry;
}

/* The card as an image (preview and download). */
async function recipeCardBlob(recipe) {
  return (await recipeCardFiles(recipe)).png;
}

/* Only what's already drawn, so sharing never has to wait. */
function readyRecipeCard(recipe) {
  const cached = recipeCardCache.get(recipe.id);
  return cached && cached.key === recipeCardKey(recipe) ? cached : null;
}

async function prepareRecipeCards(recipes) {
  for (const recipe of recipes) {
    try {
      await recipeCardBlob(recipe);
    } catch (err) {
      console.warn('Could not draw the recipe card for', recipe.nameEn, err);
    }
  }
}

/* The whole recipe as plain text, for the share sheet and the clipboard. */
function recipeText(recipe) {
  const lines = [`${recipe.nameEn}${recipe.nameCn ? ` · ${recipe.nameCn}` : ''}`];
  if (recipe.story) lines.push('', recipe.story);
  if (recipe.ingredients.length) {
    lines.push('', 'Ingredients:');
    recipe.ingredients.forEach((row) => {
      lines.push(`- ${[row.her, row.mine].filter(Boolean).join(' → ')}`);
    });
  }
  if (recipe.steps.length) {
    lines.push('', 'Steps:');
    recipe.steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  }
  lines.push('', 'From 家常菜 · Taste of Home — kuehmachine.com');
  return lines.join('\n');
}

const SHARE_PHOTOS = 3;

/* "Hainanese Yi Bua Kueh recipe.png": the bracketed gloss would push the
   name past the length limit. */
function recipeCardFileName(recipe) {
  const shortName = recipe.nameEn.replace(/\s*\([^)]*\)/g, '').slice(0, 50);
  return shareFileName({ name: shortName, type: 'image', blob: { type: 'image/png' } })
    .replace(/\.png$/, ' recipe.png');
}

function sharePhotos(recipe) {
  return (recipe.media || []).filter((m) => m.blob && m.type === 'image').slice(0, SHARE_PHOTOS);
}

/* Opens the system share sheet with the recipe card leading (so apps that
   keep only pictures still get the whole recipe), then the photos, with the
   text alongside. Resolves to 'shared', 'cancelled' or 'failed'. */
/* Opens the system share sheet with the recipe card as a PDF and a short
   message carrying a link back to the recipe on the site. Resolves to
   'shared', 'cancelled' or 'failed'. */
async function shareNatively(recipe) {
  /* No separate title: share targets add it as its own line or subject,
     repeating the dish name that's already in the message. */
  const shareData = { text: shareMessage(recipe) };

  if (navigator.canShare) {
    try {
      const card = readyRecipeCard(recipe) || (await recipeCardFiles(recipe));
      if (card.pdf) {
        const files = [new File([card.pdf], recipeCardFileName(recipe).replace(/\.png$/, '.pdf'), { type: 'application/pdf' })];
        if (navigator.canShare({ files })) shareData.files = files;
      }
    } catch {
      // share the message and link without the file
    }
  }

  try {
    await navigator.share(shareData);
    return 'shared';
  } catch (err) {
    if (err.name === 'AbortError') return 'cancelled';
    /* Some share targets turn down attached files; the message and link
       still go. */
    if (shareData.files) {
      try {
        delete shareData.files;
        await navigator.share(shareData);
        return 'shared';
      } catch (retryErr) {
        if (retryErr.name === 'AbortError') return 'cancelled';
      }
    }
    return 'failed';
  }
}

/* ---------- Share panel ---------- */

/* Share opens this panel rather than going straight out: it shows the recipe
   card that will be sent and offers every way to send it, including the ones
   a desktop browser without a share sheet can still do. */
let sharePanelRecipe = null;
let sharePanelReturnFocus = null;
let sharePreviewUrl = null;

function shareRecipe(recipe) {
  openSharePanel(recipe);
}

function setShareStatus(message) {
  document.getElementById('share-status').textContent = message;
}

async function openSharePanel(recipe) {
  sharePanelRecipe = recipe;
  sharePanelReturnFocus = document.activeElement;

  const canShare = Boolean(navigator.share);

  /* The hand font has no Chinese, so the Chinese name gets its own smaller
     serif span rather than a heavy fallback at the full size. */
  const dish = document.getElementById('share-dish');
  dish.textContent = recipe.nameEn;
  if (recipe.nameCn) {
    const cn = document.createElement('span');
    cn.className = 'cn';
    cn.textContent = recipe.nameCn;
    dish.append(' ', cn);
  }
  document.getElementById('share-summary').textContent = canShare
    ? 'Share this recipe and the memories that come with it.'
    : 'Download the card to send it on, or save the recipe as a PDF to print.';

  const nativeBtn = document.getElementById('share-native');
  nativeBtn.innerHTML = `${ICON.share}<span>Share…</span>`;
  nativeBtn.hidden = !canShare;
  document.getElementById('share-download').innerHTML = `${ICON.download}<span>Download recipe card</span>`;
  document.getElementById('share-pdf').innerHTML = `${ICON.pdf}<span>Save as PDF</span>`;
  setShareStatus('');

  const preview = document.getElementById('share-preview');
  preview.innerHTML = '<p class="share-preview-wait">Drawing the card…</p>';
  preview.scrollTop = 0;

  document.getElementById('share-overlay').classList.remove('hidden');
  document.body.classList.add('modal-open');
  /* Focus the panel itself: keyboard users tab straight to the buttons, and
     nobody sees a focus ring on Share before they've done anything. */
  document.getElementById('share-card').focus({ preventScroll: true });

  try {
    const blob = await recipeCardBlob(recipe);
    if (sharePanelRecipe !== recipe || !blob) return;
    if (sharePreviewUrl) URL.revokeObjectURL(sharePreviewUrl);
    sharePreviewUrl = URL.createObjectURL(blob);
    preview.innerHTML = `<img src="${sharePreviewUrl}" alt="">`;
    /* A brief glimpse of the thumb, so it's clear the card scrolls. */
    preview.querySelector('img').addEventListener('load', () => showShareScrollThumb(), { once: true });
  } catch {
    preview.innerHTML = '<p class="share-preview-wait">The card couldn\'t be drawn here.</p>';
  }
}

function closeSharePanel() {
  document.getElementById('share-overlay').classList.add('hidden');
  if (document.querySelectorAll('.form-overlay:not(.hidden)').length === 0) {
    document.body.classList.remove('modal-open');
  }
  if (sharePreviewUrl) {
    URL.revokeObjectURL(sharePreviewUrl);
    sharePreviewUrl = null;
  }
  sharePanelRecipe = null;
  if (sharePanelReturnFocus && sharePanelReturnFocus.focus) {
    sharePanelReturnFocus.focus({ preventScroll: true });
  }
}

/* ---------- Quiet scrollbars ---------- */

/* A short, thin scroll thumb that shows while something scrolls and fades a
   moment after it stops, in place of the browser's own scrollbar (hidden by
   the .quiet-scroll class). The thumb lives in `host`, a positioned element
   that holds the scroller but doesn't scroll itself. */
const QUIET_THUMB = 36;
const QUIET_INSET = 8;

function attachQuietScrollbar(scroller, host) {
  scroller.classList.add('quiet-scroll');
  const thumb = document.createElement('span');
  thumb.className = 'quiet-thumb';
  thumb.setAttribute('aria-hidden', 'true');
  host.appendChild(thumb);
  let timer = null;

  function show() {
    const range = scroller.scrollHeight - scroller.clientHeight;
    if (range <= 0) {
      thumb.classList.remove('visible');
      return;
    }
    const track = scroller.clientHeight - QUIET_THUMB - QUIET_INSET * 2;
    const top = scroller.offsetTop + QUIET_INSET + (scroller.scrollTop / range) * track;
    thumb.style.transform = `translateY(${top}px)`;
    thumb.classList.add('visible');
    clearTimeout(timer);
    timer = setTimeout(() => thumb.classList.remove('visible'), 900);
  }

  scroller.addEventListener('scroll', show, { passive: true });
  return show;
}

let showShareScrollThumb = () => {};

/* Hands the visitor a file straight to their downloads. */
function downloadFile(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* Save as PDF downloads the recipe card PDF that's already built for
   sharing (story, photos, ingredients, steps, and the link back to the
   site), so there's no print dialog to work through. Resolves to the file
   name, or null if it couldn't be made. */
async function downloadRecipePdf(recipe) {
  const { pdf } = await recipeCardFiles(recipe);
  if (!pdf) return null;
  const name = recipeCardFileName(recipe).replace(/\.png$/, '.pdf');
  downloadFile(pdf, name);
  return name;
}

function setSavedStatus(name) {
  const file = document.createElement('em');
  file.textContent = name;
  document.getElementById('share-status').replaceChildren('Saved ', file, ' to your downloads.');
}

function setupSharePanel() {
  const overlay = document.getElementById('share-overlay');
  const preview = document.getElementById('share-preview');
  showShareScrollThumb = attachQuietScrollbar(preview, preview.parentElement);

  document.getElementById('share-close').addEventListener('click', closeSharePanel);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeSharePanel();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || overlay.classList.contains('hidden')) return;
    e.stopPropagation();
    closeSharePanel();
  }, true);

  document.getElementById('share-native').addEventListener('click', async () => {
    const recipe = sharePanelRecipe;
    if (!recipe) return;
    const result = await shareNatively(recipe);
    if (result === 'shared') {
      closeSharePanel();
      showToast('Recipe shared');
    } else if (result === 'failed') {
      setShareStatus("The share sheet couldn't open here. Download the card and send it instead.");
    }
  });

  document.getElementById('share-download').addEventListener('click', async () => {
    const recipe = sharePanelRecipe;
    if (!recipe) return;
    const blob = await recipeCardBlob(recipe);
    if (!blob) {
      setShareStatus("The card couldn't be drawn here. Try Save as PDF instead.");
      return;
    }
    const name = recipeCardFileName(recipe);
    downloadFile(blob, name);
    setSavedStatus(name);
  });

  document.getElementById('share-pdf').addEventListener('click', async () => {
    const recipe = sharePanelRecipe;
    if (!recipe) return;
    const name = await downloadRecipePdf(recipe);
    if (name) setSavedStatus(name);
    else setShareStatus("The PDF couldn't be made here. Try Download recipe card instead.");
  });
}

/* ---------- Backup & restore ---------- */

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function exportBackup() {
  const recipes = await dbGetAll('recipes');
  const glossary = await dbGetAll('glossary');

  const recipesOut = await Promise.all(
    recipes.map(async (recipe) => ({
      ...recipe,
      media: await Promise.all(
        (recipe.media || []).map(async (m) => ({
          id: m.id,
          type: m.type,
          name: m.name,
          description: m.description || '',
          ...(m.src ? { src: m.src } : {}),
          dataUrl: await mediaBlob(m).then((blob) => (blob ? blobToDataURL(blob) : null)),
        }))
      ),
    }))
  );

  const payload = {
    app: 'tasteOfHome',
    version: 1,
    exportedAt: new Date().toISOString(),
    recipes: recipesOut,
    glossary,
  };

  const json = JSON.stringify(payload);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `taste-of-home-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('Backup downloaded');
}

async function importBackup(file) {
  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    showToast("That doesn't look like a valid backup file");
    return;
  }
  if (!payload || !Array.isArray(payload.recipes)) {
    showToast("That doesn't look like a valid backup file");
    return;
  }

  for (const recipe of payload.recipes) {
    const media = await Promise.all(
      (recipe.media || []).map(async (m) => ({
        id: m.id || makeId(),
        type: m.type,
        name: m.name,
        description: m.description || '',
        ...(m.src ? { src: m.src } : {}),
        blob: m.dataUrl ? await (await fetch(m.dataUrl)).blob() : m.blob,
      }))
    );
    await dbPut('recipes', { ...recipe, media });
  }

  for (const entry of payload.glossary || []) {
    await dbPut('glossary', entry);
  }

  renderRecipes();
  renderGlossary();
  const count = payload.recipes.length;
  showToast(`Restored ${count} recipe${count === 1 ? '' : 's'}`);
}

function setupBackup() {
  document.getElementById('backup-btn').addEventListener('click', exportBackup);
  document.getElementById('restore-btn').addEventListener('click', () => {
    document.getElementById('restore-file').click();
  });
  document.getElementById('restore-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    await importBackup(file);
    e.target.value = '';
  });
}

/* ---------- Rendering recipes ---------- */

/* Object URLs handed out to the current set of cards, revoked on re-render. */
let cardObjectUrls = [];

/* The recipes on screen, by id. Sharing reads from here rather than from
   IndexedDB, because the share sheet only opens straight off a click: an
   await in between can cost the browser's permission to show it. */
const recipeCache = new Map();

function mediaUrl(blob) {
  const url = URL.createObjectURL(blob);
  cardObjectUrls.push(url);
  return url;
}

/* A blob if we hold one, otherwise the file sitting in ./media/. */
function mediaSrc(item) {
  return item.blob ? mediaUrl(item.blob) : item.src;
}

const THUMB_MAX = 480;

/* Every thumbnail is read in one transaction rather than one lookup per photo,
   which is what made a page of cards feel slow. */
let thumbIndex = null;

async function loadThumbIndex() {
  if (!thumbIndex) {
    const all = await dbGetAll('thumbs');
    thumbIndex = new Map(all.map((t) => [t.id, t.blob]));
  }
  return thumbIndex;
}

/* Draws the frame a quarter of the way in, which is usually past any dark
   opening frame. */
function videoFrameBlob(blob) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(blob);
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(result);
    };

    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = url;

    video.addEventListener('loadeddata', () => {
      video.currentTime = Math.min(1, (video.duration || 4) / 4);
    });

    video.addEventListener('seeked', () => {
      try {
        const scale = Math.min(1, THUMB_MAX / Math.max(video.videoWidth, video.videoHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((out) => finish(out), 'image/jpeg', 0.82);
      } catch {
        finish(null);
      }
    });

    video.addEventListener('error', () => finish(null));
    setTimeout(() => finish(null), 5000);
  });
}

async function thumbBlobFor(item) {
  if (item.type === 'audio') return null;
  if (!item.blob) return null;

  const index = await loadThumbIndex();
  const cached = index.get(item.id);
  if (cached) return cached;

  if (item.type === 'video') {
    const frame = await videoFrameBlob(item.blob);
    if (frame) {
      index.set(item.id, frame);
      await dbPut('thumbs', { id: item.id, blob: frame });
    }
    return frame;
  }

  try {
    const bitmap = await createImageBitmap(item.blob);
    const scale = Math.min(1, THUMB_MAX / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
    index.set(item.id, blob);
    await dbPut('thumbs', { id: item.id, blob });
    return blob;
  } catch {
    /* Older browser, or an image it can't decode: fall back to the original. */
    return item.blob;
  }
}

function mediaTypeOf(file) {
  if (file.type.startsWith('video')) return 'video';
  if (file.type.startsWith('audio')) return 'audio';
  return 'image';
}

/* Cards and the pop-up gallery show small copies; only the viewer loads the
   full-size file. */
async function mediaTag(item, alt, { playable = false } = {}) {
  if (item.type === 'audio') {
    const url = mediaSrc(item);
    return `<audio src="${url}" ${playable ? 'controls' : ''}></audio>`;
  }

  if (item.type === 'video') {
    if (playable) {
      return `<video src="${mediaSrc(item)}" controls playsinline preload="metadata"></video>`;
    }

    /* Built-in videos ship with a poster; don't download and decode the
       whole video just to make a card-sized still. (From Leonard.) */
    const frame = item.poster ? null : await thumbBlobFor(item);
    const still = item.poster || (frame ? mediaUrl(frame) : null);
    const inner = still
      ? `<img src="${still}" alt="${alt}" loading="lazy" decoding="async">`
      : `<video src="${mediaSrc(item)}" muted playsinline preload="metadata"></video>`;
    return `<span class="thumb-wrap">${inner}<span class="play-badge">▶</span></span>`;
  }

  /* Built-in photos ship with a small thumbnail made by build-seed.py;
     only photos added in the browser need one made here. */
  const thumb = item.thumb ? null : await thumbBlobFor(item);
  const url = item.thumb || (thumb ? mediaUrl(thumb) : item.src);
  return `<img src="${url}" alt="${alt}" loading="lazy" decoding="async">`;
}

function ingredientsHtml(recipe) {
  return recipe.ingredients
    .map(
      (row) => `
        <div class="ingredient-row">
          <span class="her-words">${row.her}</span>
          <span class="arrow">→</span>
          <span class="my-words">${row.mine}</span>
        </div>
      `
    )
    .join('');
}

/* ---------- Recipe cards (preview) ---------- */

async function renderRecipes() {
  const grid = document.getElementById('recipe-grid');
  const savedCards = grid.querySelectorAll('.recipe-card[data-id]');
  savedCards.forEach((card) => card.remove());
  grid.querySelectorAll('.recipe-loading-error').forEach((item) => item.remove());
  grid.setAttribute('aria-busy', 'true');
  cardObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  cardObjectUrls = [];
  const clearPlaceholders = () => grid.querySelectorAll('.recipe-loading').forEach((item) => item.remove());

  try {
    let recipes = await dbGetAll('recipes');
    recipes = await ensureRecipeOrder(recipes);
    recipes.sort((a, b) => a.order - b.order);
    recipeCache.clear();
    recipes.forEach((r) => recipeCache.set(r.id, r));

    /* Each card appears as soon as it's ready, rather than all of them
       waiting for the slowest. (From Leonard.) */
    for (const [index, recipe] of recipes.entries()) {
      const card = await buildRecipeCard(recipe, index, recipes.length);
      if (index === 0) clearPlaceholders();
      grid.appendChild(card);
      /* A plain timer rather than an animation frame: browsers pause frames
         in background tabs, which held back every card after the first. */
      if (index < recipes.length - 1) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (!recipes.length) clearPlaceholders();
    /* Draw the share cards once the page is up, one at a time. */
    setTimeout(() => prepareRecipeCards(recipes), 500);
  } catch (error) {
    console.error('Could not render recipe cards:', error);
    clearPlaceholders();
    const message = document.createElement('p');
    message.className = 'recipe-loading-error';
    message.setAttribute('role', 'alert');
    message.textContent = 'The recipe cards could not be opened. Refresh the page to try again.';
    grid.appendChild(message);
  } finally {
    grid.setAttribute('aria-busy', 'false');
  }
}

async function buildRecipeCard(recipe, index, total) {
  const card = document.createElement('article');
  card.className = 'recipe-card recipe-card-preview';
  card.dataset.id = recipe.id;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `Open the full recipe for ${recipe.nameEn}`);

  const media = recipe.media || [];
  /* Recordings have nothing to look at, so the card counts them instead. */
  const visual = media.filter((m) => m.type !== 'audio');
  const recordings = media.length - visual.length;

  const cover = visual.find((m) => m.type === 'image') || visual[0];
  const coverHtml = cover
    ? `<div class="card-cover">${await mediaTag(cover, recipe.nameEn)}</div>`
    : '';

  const rest = visual.filter((m) => m !== cover).slice(0, 4);
  const remaining = visual.length - 1 - rest.length;
  const stripTags = await Promise.all(rest.map((m) => mediaTag(m, recipe.nameEn)));
  const stripHtml = rest.length
    ? `<div class="card-strip">
         ${stripTags.join('')}
         ${remaining > 0 ? `<span class="more-count">+${remaining}</span>` : ''}
       </div>`
    : '';

  const counts = [];
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (recipe.ingredients.length) counts.push(plural(recipe.ingredients.length, 'ingredient'));
  if (recipe.steps.length) counts.push(plural(recipe.steps.length, 'step'));
  if (recordings) counts.push(`🎙 ${plural(recordings, 'recording')}`);

  card.innerHTML = `
    <div class="card-actions">
      <button type="button" class="drag-recipe" aria-label="Drag to reorder this recipe, or use the arrow keys">${ICON.grip}</button>
      <button type="button" class="share-recipe" aria-label="Share recipe">${ICON.share}</button>
      <button type="button" class="edit-recipe" aria-label="Edit recipe">${ICON.edit}</button>
      <button type="button" class="delete-recipe" aria-label="Delete recipe">${ICON.trash}</button>
    </div>
    <h3>${recipe.nameEn} ${recipe.nameCn ? `<span class="cn">${recipe.nameCn}</span>` : ''}</h3>
    ${recipe.story ? `<p class="recipe-story">${recipe.story}</p>` : ''}
    ${coverHtml}
    ${stripHtml}
    <p class="card-open-cue">
      <span class="cue-counts">${counts.join(' · ') || 'Not written down yet'}</span>
      <span class="cue-link">Read the full recipe →</span>
    </p>
  `;

  return card;
}

/* ---------- Recipe detail overlay ---------- */

async function openRecipeDetail(recipe) {
  recipeCache.set(recipe.id, recipe);
  /* The address bar names the open recipe, so it can be copied as a link. */
  if (recipeIdFromHash() !== recipe.id) history.replaceState(null, '', `#recipe=${encodeURIComponent(recipe.id)}`);
  recipeCardBlob(recipe).catch(() => {});
  const overlay = document.getElementById('recipe-detail-overlay');
  const panel = document.getElementById('recipe-detail');

  const media = recipe.media || [];
  const visual = media.filter((m) => m.type !== 'audio');
  const recordings = media.filter((m) => m.type === 'audio');

  /* Videos sit in the grid as thumbnails and expand into a player on click. */
  const galleryTiles = await Promise.all(
    visual.map(
      async (m) => `<div class="gallery-item ${m.type}" data-media-id="${m.id}" role="button" tabindex="0"
        aria-label="${m.type === 'video' ? 'Play' : 'Open'} ${m.name || 'this ' + m.type}">${await mediaTag(m, recipe.nameEn)}</div>`
    )
  );
  const galleryHtml = visual.length ? `<div class="detail-gallery">${galleryTiles.join('')}</div>` : '';

  const audioItems = await Promise.all(
    recordings.map(
      async (m) => `<li>
        <span class="audio-name">🎙 ${m.name || 'Recording'}</span>
        ${m.description ? `<span class="audio-note">${m.description}</span>` : ''}
        ${await mediaTag(m, recipe.nameEn, { playable: true })}
      </li>`
    )
  );
  const audioHtml = recordings.length
    ? `<div class="detail-block">
         <h4>In her own words <span class="cn">原话</span></h4>
         <p class="detail-note">Her instructions, as she gave them.</p>
         <ul class="audio-list">${audioItems.join('')}</ul>
       </div>`
    : '';

  const stepsHtml = recipe.steps.length
    ? `<div class="detail-block">
         <h4>Steps <span class="cn">做法</span></h4>
         <ol class="steps-list">${recipe.steps.map((s) => `<li>${s}</li>`).join('')}</ol>
       </div>`
    : '';

  const ingredientsBlock = recipe.ingredients.length
    ? `<div class="detail-block">
         <h4>Ingredients <span class="cn">材料</span></h4>
         <p class="detail-note">Her words, and the measurements I landed on.</p>
         <div class="ingredients">${ingredientsHtml(recipe)}</div>
       </div>`
    : '';

  const nothingYet = !recipe.ingredients.length && !recipe.steps.length && !recordings.length
    ? '<p class="steps-placeholder">Still to be written down properly with her.</p>'
    : '';

  panel.innerHTML = `
    <button type="button" id="close-recipe-detail" class="close-btn" aria-label="Close">×</button>
    <h3 id="recipe-detail-heading">${recipe.nameEn} ${recipe.nameCn ? `<span class="cn">${recipe.nameCn}</span>` : ''}</h3>
    ${recipe.story ? `<p class="recipe-story">${recipe.story}</p>` : ''}
    ${galleryHtml}
    ${audioHtml}
    ${ingredientsBlock}
    ${stepsHtml}
    ${nothingYet}
    <div class="detail-actions">
      <button type="button" class="mini-btn detail-share" aria-label="Share recipe">${ICON.share}<span class="btn-label">Share</span></button>
      <button type="button" class="mini-btn detail-pdf" aria-label="Save as PDF">${ICON.pdf}<span class="btn-label">Save as PDF</span></button>
      <button type="button" class="mini-btn detail-edit" aria-label="Edit this recipe">${ICON.edit}<span class="btn-label">Edit this recipe</span></button>
    </div>
  `;

  panel.dataset.id = recipe.id;
  panel.scrollTop = 0;
  overlay.classList.remove('hidden');
  document.body.classList.add('modal-open');
  panel.tabIndex = -1;
  panel.focus({ preventScroll: true });
}

function closeRecipeDetail() {
  document.querySelectorAll('#recipe-detail audio').forEach((a) => a.pause());
  if (recipeIdFromHash()) history.replaceState(null, '', location.pathname + location.search);
  closeMediaViewer();
  const overlay = document.getElementById('recipe-detail-overlay');
  overlay.classList.add('hidden');
  document.getElementById('recipe-detail').innerHTML = '';
  document.body.classList.remove('modal-open');
}

/* ---------- Icons ---------- */

/* Line icons drawn in the ink colour, so the card actions stay quiet next to
   the photographs. */
const ICON = {
  grip:
    '<svg viewBox="0 0 24 24" aria-hidden="true" class="grip-icon"><circle cx="9" cy="6" r="1.3"/><circle cx="15" cy="6" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="9" cy="18" r="1.3"/><circle cx="15" cy="18" r="1.3"/></svg>',
  mic:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0013 0"/><path d="M12 18v3"/></svg>',
  pdf:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a1.5 1.5 0 00-1.5 1.5v15A1.5 1.5 0 007 21h10a1.5 1.5 0 001.5-1.5V7.5z"/><path d="M14 3v4.5h4.5"/><path d="M9 13h6M9 16.5h4"/></svg>',
  share:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3"/><path d="M8.5 6.5L12 3l3.5 3.5"/><path d="M5 12v7a1.5 1.5 0 001.5 1.5h11A1.5 1.5 0 0019 19v-7"/></svg>',
  edit:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10-10a2.1 2.1 0 10-3-3L5 17v3z"/><path d="M14.5 6.5l3 3"/></svg>',
  download:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11"/><path d="M8 11.5l4 4 4-4"/><path d="M5 19.5h14"/></svg>',
  trash:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M10 4h4a1 1 0 011 1v2H9V5a1 1 0 011-1z"/><path d="M6 7l1 12.5a1.5 1.5 0 001.5 1.4h7a1.5 1.5 0 001.5-1.4L18 7"/><path d="M10.5 11v6M13.5 11v6"/></svg>',
};

/* ---------- Media viewer ---------- */

/* One pop-up for photos and video: arrows move through a recipe's gallery,
   and a click zooms a photo in and out. */
let viewerItems = [];
let viewerIndex = 0;
let viewerUrls = [];

function openMediaViewer(items, index) {
  if (!items.length) return;
  viewerItems = items;
  viewerIndex = index;
  document.getElementById('media-overlay').classList.remove('hidden');
  document.body.classList.add('modal-open');
  renderViewerItem();
}

function renderViewerItem() {
  const holder = document.getElementById('media-holder');
  const item = viewerItems[viewerIndex];

  releaseViewerMedia();
  /* Video always shows framed: its own controls handle full screen. */
  if (item.type === 'video') document.getElementById('media-overlay').classList.remove('fullpage');

  let url = item.src;
  if (item.blob) {
    url = URL.createObjectURL(item.blob);
    viewerUrls.push(url);
  }

  if (item.type === 'video') {
    const video = document.createElement('video');
    video.src = url;
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    holder.appendChild(video);
  } else {
    const img = document.createElement('img');
    img.src = url;
    img.alt = item.name || 'Photo';
    holder.appendChild(img);
  }

  document.getElementById('media-caption').textContent = item.name || '';
  const description = document.getElementById('media-description');
  description.textContent = item.description || '';
  description.hidden = !item.description;
  const counter = document.getElementById('media-counter');
  counter.textContent = viewerItems.length > 1 ? `${viewerIndex + 1} / ${viewerItems.length}` : '';

  const single = viewerItems.length < 2;
  document.getElementById('media-prev').hidden = single;
  document.getElementById('media-next').hidden = single;
}

function releaseViewerMedia() {
  const holder = document.getElementById('media-holder');
  const video = holder.querySelector('video');
  if (video) video.pause();
  holder.innerHTML = '';
  viewerUrls.forEach((url) => URL.revokeObjectURL(url));
  viewerUrls = [];
}

function stepViewer(direction) {
  if (viewerItems.length < 2) return;
  viewerIndex = (viewerIndex + direction + viewerItems.length) % viewerItems.length;
  renderViewerItem();
}

function closeMediaViewer() {
  releaseViewerMedia();
  viewerItems = [];
  const overlay = document.getElementById('media-overlay');
  overlay.classList.remove('fullpage');
  overlay.classList.add('hidden');
  if (document.getElementById('recipe-detail-overlay').classList.contains('hidden')) {
    document.body.classList.remove('modal-open');
  }
}

function setupMediaViewer() {
  const overlay = document.getElementById('media-overlay');

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.id === 'close-media') {
      closeMediaViewer();
    } else if (e.target.id === 'media-prev') {
      stepViewer(-1);
    } else if (e.target.id === 'media-next') {
      stepViewer(1);
    } else if (e.target.tagName === 'IMG') {
      /* A click on the photo drops the frame and fills the window; another
         click brings the frame back. */
      overlay.classList.toggle('fullpage');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (overlay.classList.contains('hidden')) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeMediaViewer();
    } else if (e.key === 'ArrowLeft') {
      stepViewer(-1);
    } else if (e.key === 'ArrowRight') {
      stepViewer(1);
    }
  }, true);
}

async function openViewerFromTile(tile) {
  const panel = document.getElementById('recipe-detail');
  const recipe = await dbGet('recipes', panel.dataset.id);
  if (!recipe) return;
  const visual = (recipe.media || []).filter((m) => m.type !== 'audio');
  const index = visual.findIndex((m) => m.id === tile.dataset.mediaId);
  if (index >= 0) openMediaViewer(visual, index);
}

/* The browser's own print dialog carries a "Save as PDF" destination on every
   platform, so the print stylesheet does the formatting and no PDF library is
   needed. The title becomes the suggested filename. */
function printRecipe(recipe) {
  const previousTitle = document.title;
  document.title = [recipe.nameEn, recipe.nameCn].filter(Boolean).join(' ');

  function restore() {
    document.title = previousTitle;
    window.removeEventListener('afterprint', restore);
  }

  window.addEventListener('afterprint', restore);
  window.print();
  /* Safari doesn't always fire afterprint, so put the title back regardless. */
  setTimeout(restore, 1000);
}

function setupRecipeDetail() {
  const overlay = document.getElementById('recipe-detail-overlay');

  overlay.addEventListener('click', async (e) => {
    if (e.target === overlay || e.target.id === 'close-recipe-detail') {
      closeRecipeDetail();
      return;
    }

    const tile = e.target.closest('.gallery-item');
    if (tile) {
      await openViewerFromTile(tile);
      return;
    }
    /* closest(), not the click target itself: a click on the button's
       label lands on its <span>, which used to do nothing. */
    const panel = document.getElementById('recipe-detail');
    const id = panel.dataset.id;
    if (e.target.closest('.detail-share')) {
      const recipe = recipeCache.get(id) || (await dbGet('recipes', id));
      if (recipe) shareRecipe(recipe);
    } else if (e.target.closest('.detail-pdf')) {
      const recipe = recipeCache.get(id) || (await dbGet('recipes', id));
      if (!recipe) return;
      const name = await downloadRecipePdf(recipe);
      showToast(name ? `Saved ${name} to your downloads` : "The PDF couldn't be made here.");
    } else if (e.target.closest('.detail-edit')) {
      const recipe = await dbGet('recipes', id);
      closeRecipeDetail();
      openRecipeForm(recipe);
    }
  });

  overlay.addEventListener('keydown', async (e) => {
    const tile = e.target.closest('.gallery-item');
    if (!tile || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    await openViewerFromTile(tile);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || overlay.classList.contains('hidden')) return;
    if (!document.getElementById('media-overlay').classList.contains('hidden')) return;
    closeRecipeDetail();
  });
}

function setupRecipeCardActions() {
  const grid = document.getElementById('recipe-grid');

  grid.addEventListener('keydown', async (e) => {
    const card = e.target.closest('.recipe-card[data-id]');
    if (!card || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    const recipe = await dbGet('recipes', card.dataset.id);
    if (recipe) await openRecipeDetail(recipe);
  });

  grid.addEventListener('click', async (e) => {
    const card = e.target.closest('.recipe-card[data-id]');
    if (!card) return;

    if (e.target.closest('.delete-recipe')) {
      const recipe = await dbGet('recipes', card.dataset.id);
      const thumbIds = recipe ? (recipe.media || []).map((m) => m.id) : [];
      const name = recipe ? recipe.nameEn : 'this recipe';
      const ok = await askConfirm({
        title: 'Delete this recipe?',
        body: `"${name}" goes for good: her words, the steps, and every photo on the card. If it isn't in a backup file, there's no other copy.`,
        confirmLabel: 'Delete it',
        cancelLabel: 'Keep it',
      });
      if (!ok) return;
      await dbDelete('recipes', card.dataset.id);
      for (const id of thumbIds) await dbDelete('thumbs', id);
      renderRecipes();
    } else if (e.target.closest('.edit-recipe')) {
      const recipe = await dbGet('recipes', card.dataset.id);
      openRecipeForm(recipe);
    } else if (e.target.closest('.share-recipe')) {
      const recipe = recipeCache.get(card.dataset.id) || (await dbGet('recipes', card.dataset.id));
      if (recipe) shareRecipe(recipe);
    } else if (!e.target.closest('.card-actions') && !card.classList.contains('dragging')) {
      const recipe = await dbGet('recipes', card.dataset.id);
      if (recipe) await openRecipeDetail(recipe);
    }
  });
}

/* ---------- Voice-to-text ---------- */

const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;

/* Each field listens in the language it is normally written in: her words and
   the Chinese name in Mandarin, everything else in English / Singlish. */
function getVoiceLang(micBtn) {
  return (micBtn && micBtn.dataset.lang) || 'en-SG';
}

function voiceLangName(lang) {
  return lang === 'zh-CN' ? '中文' : 'English / Singlish';
}

/* What went wrong, in words someone holding a phone can act on. The browser
   only reports a code; left silent, a failed mic just looks broken. */
function voiceErrorMessage(code, lang) {
  switch (code) {
    case 'not-allowed':
      return "The microphone is blocked. Allow it for this site (the icon in the address bar), and for your browser in your device's privacy settings, then try again.";
    case 'service-not-allowed':
      return 'Voice input is switched off on this device. On iPhone, turn on Siri & Dictation in Settings, then try again.';
    case 'audio-capture':
      return 'No microphone was found. Check one is connected and not in use by another app.';
    case 'network':
      return 'Voice input needs the internet to turn speech into text. Check your connection and try again.';
    case 'language-not-supported':
      return `This browser can't listen in ${voiceLangName(lang)}. Try the other field's mic, or type it in.`;
    case 'no-speech':
      return `Nothing heard in ${voiceLangName(lang)}. Tap the mic and try again.`;
    default:
      return 'Voice input stopped unexpectedly. Tap the mic to try again.';
  }
}

function setupVoiceInput() {
  /* The one in the markup is left empty so the icon lives in a single place. */
  document.querySelectorAll('.mic-btn:empty').forEach((btn) => {
    btn.innerHTML = ICON.mic;
  });

  if (!SpeechRecognitionAPI) {
    document.querySelectorAll('.mic-btn').forEach((btn) => {
      btn.classList.add('unsupported');
      btn.title = "Voice input isn't available in this browser";
    });
    /* A tooltip never shows on a phone, so say it when the mic is tapped. */
    document.body.addEventListener('click', (e) => {
      if (!e.target.closest('.mic-btn')) return;
      showToast("Voice input isn't available in this browser. Try Chrome, Edge, or Safari on iPhone.");
    });
    return;
  }

  /* One listener at a time: tapping the same mic again stops it. */
  let active = null;

  document.body.addEventListener('click', (e) => {
    const micBtn = e.target.closest('.mic-btn');
    if (!micBtn) return;

    if (active) {
      const wasThisMic = active.button === micBtn;
      active.stopped = true;
      active.recognition.abort();
      active = null;
      if (wasThisMic) return;
    }

    const targetField = micBtn.dataset.target
      ? document.getElementById(micBtn.dataset.target)
      : micBtn.closest('.field-with-mic').querySelector('input, textarea');
    if (!targetField) return;

    const recognition = new SpeechRecognitionAPI();
    const lang = getVoiceLang(micBtn);
    recognition.lang = lang;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    const session = { recognition, button: micBtn, heard: false, reported: false, stopped: false };

    const finish = () => {
      micBtn.classList.remove('listening');
      if (active === session) active = null;
    };

    recognition.onstart = () => showToast(`Listening in ${voiceLangName(lang)}… tap the mic again to stop`);
    recognition.onresult = (event) => {
      session.heard = true;
      const transcript = event.results[0][0].transcript;
      targetField.value = targetField.value ? `${targetField.value} ${transcript}` : transcript;
      targetField.dispatchEvent(new Event('input'));
    };
    recognition.onerror = (event) => {
      finish();
      session.reported = true;
      if (event.error === 'aborted') return; // stopped on purpose
      console.warn('Voice input error:', event.error, event.message || '');
      showToast(voiceErrorMessage(event.error, lang));
    };
    /* Some browsers stop without an error when they catch no words; say so
       rather than leave the mic looking broken. */
    recognition.onend = () => {
      finish();
      if (!session.heard && !session.reported && !session.stopped) {
        showToast(voiceErrorMessage('no-speech', lang));
      }
    };

    try {
      recognition.start();
      micBtn.classList.add('listening');
      active = session;
    } catch (err) {
      console.warn('Voice input could not start:', err);
      showToast("Voice input couldn't start. Tap the mic to try again.");
    }
  });
}

/* ---------- Init ---------- */

async function init() {
  /* A hiccup here mustn't stop the page: whatever is stored still renders. */
  try {
    await syncSeedGlossary();
    await syncSeedRecipes();
  } catch (err) {
    console.warn('Could not check the built-in recipes:', err);
  }
  /* Each feature starts on its own, so a fault in one (voice input on an
     unusual browser, say) can't stop the recipe cards from appearing. */
  const start = (name, fn) => {
    try {
      fn();
    } catch (err) {
      console.error(`Could not start ${name}:`, err);
    }
  };
  start('the glossary', () => {
    setupGlossary();
    renderGlossary();
  });
  start('the recipe form', () => {
    setupRecipeForm();
    const story = document.getElementById('field-story');
    attachQuietScrollbar(story, story.parentElement);
    setupReordering();
  });
  start('the recipe cards', () => {
    setupRecipeCardActions();
    setupRecipeDragging();
    setupRecipeDetail();
  });
  start('the photo viewer', setupMediaViewer);
  start('voice input', setupVoiceInput);
  start('backup', setupBackup);
  start('sharing', setupSharePanel);
  await renderRecipes();
  openRecipeFromHash();
  window.addEventListener('hashchange', openRecipeFromHash);
  /* Once the browser is idle, so it never competes with the page loading. */
  const cacheMedia = () => fetchSeedMediaInBackground().catch((err) => console.warn('Background media fetch stopped:', err));
  if ('requestIdleCallback' in window) requestIdleCallback(cacheMedia, { timeout: 3000 });
  else setTimeout(cacheMedia, 1000);
}

document.addEventListener('DOMContentLoaded', init);
