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
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      console.warn('IndexedDB unavailable, keeping recipes in memory:', request.error);
      resolve(null);
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
/* Left by the first version, which copied the built-in recipes in once and
   never looked at recipes-seed.js again. */
const LEGACY_SEED_FLAG = 'tasteOfHome.seededRecipes.v1';

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
  /* Copies made by the first version carry no fingerprint, so there's no
     telling them from edited ones. They came from the same backup the seed
     was built from, so they're refreshed. */
  const upgrading = !Array.isArray(delivered) && Boolean(readStorage(LEGACY_SEED_FLAG));
  const deliveredIds = new Set(Array.isArray(delivered) ? delivered : existing.map((r) => r.id));

  const lineup = [...existing].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const changed = new Set();
  const staleMediaIds = [];

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

    const outdated = current.seedHash ? current.seedHash !== seedFingerprint(seed) : upgrading;
    if (!outdated) continue;

    const refreshed = seedCopy(seed, current.order);
    lineup[lineup.indexOf(current)] = refreshed;
    changed.add(refreshed);
    (current.media || []).forEach((m) => staleMediaIds.push(m.id));
  }

  /* The first version's order came from its own seed, not from anyone
     dragging cards here, so take the current one. */
  if (upgrading) {
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

async function seedGlossaryIfEmpty() {
  const existing = await dbGetAll('glossary');
  if (existing.length > 0) return;
  const entries = typeof SEED_GLOSSARY !== 'undefined' && SEED_GLOSSARY.length
    ? SEED_GLOSSARY
    : DEFAULT_GLOSSARY;
  for (const entry of entries) {
    await dbPut('glossary', { id: makeId(), ...entry });
  }
}

async function renderGlossary(filterText = '') {
  const list = document.getElementById('glossary-list');
  const all = await dbGetAll('glossary');
  const filtered = all.filter((entry) =>
    entry.term.toLowerCase().includes(filterText.toLowerCase()) ||
    entry.meaning.toLowerCase().includes(filterText.toLowerCase())
  );

  const count = document.getElementById('glossary-count');
  if (count) {
    if (!all.length) {
      count.textContent = 'Nothing pinned down yet';
    } else if (filterText) {
      count.textContent = `${filtered.length} of ${all.length} phrases`;
    } else {
      count.textContent = `${all.length} phrase${all.length === 1 ? '' : 's'} pinned down`;
    }
  }

  list.innerHTML = filtered
    .map(
      (entry) => `
        <li data-id="${entry.id}">
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
  await dbPut('glossary', { ...entry, term, meaning });
  await renderGlossary(currentGlossaryFilter());
  showToast('Glossary updated');
}

function setupGlossary() {
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
    if (!term || !meaning) return;

    const existing = await dbGetAll('glossary');
    const match = existing.find((entry) => entry.term.trim().toLowerCase() === term.toLowerCase());
    if (match) {
      await dbPut('glossary', { ...match, meaning });
      showToast(`Updated “${match.term}”`);
    } else {
      await dbPut('glossary', { id: makeId(), term, meaning });
    }

    termInput.value = '';
    meaningInput.value = '';
    document.getElementById('glossary-search').value = '';
    termInput.focus();
    showToast(`Added “${term}”`);
    renderGlossary();
  });

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
    <p class="section-note">Photos, videos and recordings so far, in the order they'll appear. Drag &#10303; to reorder. Name each one and add a note if it helps, both show up when it's opened.</p>
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
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2600);
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
    .trim()
    .slice(0, 60) || 'photo';
  return `${base}.${ext}`;
}

async function shareRecipe(recipe) {
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
  const text = lines.join('\n');
  const shareData = { title: recipe.nameEn, text };

  if (navigator.canShare && recipe.media && recipe.media.some((m) => m.blob)) {
    try {
      const files = recipe.media.filter((m) => m.blob).slice(0, 4).map(
        (m) =>
          new File([m.blob], shareFileName(m), {
            type: m.blob.type || DEFAULT_SHARE_TYPE[m.type] || 'image/jpeg',
          })
      );
      if (navigator.canShare({ files })) shareData.files = files;
    } catch {
      // share without files
    }
  }

  if (navigator.share) {
    try {
      await navigator.share(shareData);
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }

  try {
    await navigator.clipboard.writeText(text);
    showToast('Recipe copied to clipboard');
  } catch {
    window.prompt('Copy this recipe:', text);
  }
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
    showToast('That doesn’t look like a valid backup file');
    return;
  }
  if (!payload || !Array.isArray(payload.recipes)) {
    showToast('That doesn’t look like a valid backup file');
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

    const frame = await thumbBlobFor(item);
    const still = frame ? mediaUrl(frame) : item.poster;
    const inner = still
      ? `<img src="${still}" alt="${alt}" loading="lazy" decoding="async">`
      : `<video src="${mediaSrc(item)}" muted playsinline preload="metadata"></video>`;
    return `<span class="thumb-wrap">${inner}<span class="play-badge">▶</span></span>`;
  }

  const thumb = await thumbBlobFor(item);
  const url = thumb ? mediaUrl(thumb) : item.src;
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
  cardObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  cardObjectUrls = [];

  let recipes = await dbGetAll('recipes');
  recipes = await ensureRecipeOrder(recipes);
  recipes.sort((a, b) => a.order - b.order);

  const built = await Promise.all(recipes.map((recipe, index) => buildRecipeCard(recipe, index, recipes.length)));
  built.forEach((card) => grid.appendChild(card));
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
    const panel = document.getElementById('recipe-detail');
    if (e.target.classList.contains('detail-pdf')) {
      const recipe = await dbGet('recipes', panel.dataset.id);
      if (recipe) printRecipe(recipe);
      return;
    }

    if (e.target.classList.contains('detail-edit')) {
      const recipe = await dbGet('recipes', panel.dataset.id);
      closeRecipeDetail();
      openRecipeForm(recipe);
    } else if (e.target.classList.contains('detail-share')) {
      const recipe = await dbGet('recipes', panel.dataset.id);
      shareRecipe(recipe);
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

    if (e.target.classList.contains('delete-recipe')) {
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
    } else if (e.target.classList.contains('edit-recipe')) {
      const recipe = await dbGet('recipes', card.dataset.id);
      openRecipeForm(recipe);
    } else if (e.target.classList.contains('share-recipe')) {
      const recipe = await dbGet('recipes', card.dataset.id);
      shareRecipe(recipe);
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

function setupVoiceInput() {
  /* The one in the markup is left empty so the icon lives in a single place. */
  document.querySelectorAll('.mic-btn:empty').forEach((btn) => {
    btn.innerHTML = ICON.mic;
  });

  if (!SpeechRecognitionAPI) {
    document.querySelectorAll('.mic-btn').forEach((btn) => {
      btn.classList.add('unsupported');
      btn.title = 'Voice input is not supported in this browser — try Chrome.';
    });
    return;
  }

  document.body.addEventListener('click', (e) => {
    const micBtn = e.target.closest('.mic-btn');
    if (!micBtn || micBtn.classList.contains('unsupported')) return;

    const targetField = micBtn.dataset.target
      ? document.getElementById(micBtn.dataset.target)
      : micBtn.closest('.field-with-mic').querySelector('input, textarea');
    if (!targetField) return;

    const recognition = new SpeechRecognitionAPI();
    const lang = getVoiceLang(micBtn);
    recognition.lang = lang;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    micBtn.classList.add('listening');

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      targetField.value = targetField.value ? `${targetField.value} ${transcript}` : transcript;
      targetField.dispatchEvent(new Event('input'));
    };
    recognition.onerror = (event) => {
      micBtn.classList.remove('listening');
      if (event.error === 'no-speech') {
        showToast(`Nothing heard in ${voiceLangName(lang)} — try again`);
      }
    };
    recognition.onend = () => micBtn.classList.remove('listening');

    recognition.start();
  });
}

/* ---------- Init ---------- */

async function init() {
  /* A hiccup here mustn't stop the page: whatever is stored still renders. */
  try {
    await seedGlossaryIfEmpty();
    await syncSeedRecipes();
  } catch (err) {
    console.warn('Could not check the built-in recipes:', err);
  }
  setupGlossary();
  renderGlossary();

  setupRecipeForm();
  setupReordering();
  setupRecipeCardActions();
  setupRecipeDragging();
  setupRecipeDetail();
  setupMediaViewer();
  setupVoiceInput();
  setupBackup();
  await renderRecipes();
  fetchSeedMediaInBackground().catch((err) => console.warn('Background media fetch stopped:', err));
}

document.addEventListener('DOMContentLoaded', init);
