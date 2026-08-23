/* ---------- Storage (IndexedDB) ---------- */

const DB_NAME = 'tasteOfHome';
const DB_VERSION = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('recipes')) {
        db.createObjectStore('recipes', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('glossary')) {
        db.createObjectStore('glossary', { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function dbGetAll(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(storeName, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(storeName, id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGet(storeName, id) {
  const db = await openDB();
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

const SEED_FLAG = 'tasteOfHome.seededRecipes.v1';

async function seedRecipesIfNeeded() {
  if (typeof SEED_RECIPES === 'undefined') return;
  if (localStorage.getItem(SEED_FLAG)) return;

  const existing = await dbGetAll('recipes');
  const existingIds = new Set(existing.map((r) => r.id));

  for (const recipe of SEED_RECIPES) {
    if (existingIds.has(recipe.id)) continue;

    const media = [];
    for (const item of recipe.media || []) {
      try {
        const response = await fetch(item.src);
        if (!response.ok) throw new Error(response.status);
        media.push({ id: item.id, type: item.type, name: item.name, blob: await response.blob() });
      } catch {
        // Opened straight off the filesystem, or a photo went missing.
        // The recipe still saves, just without that image.
        console.warn('Could not load seed photo', item.src);
      }
    }

    await dbPut('recipes', { ...recipe, media });
  }

  localStorage.setItem(SEED_FLAG, '1');
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

  list.innerHTML = filtered
    .map(
      (entry) => `
        <li data-id="${entry.id}">
          <span class="term">${entry.term}</span>
          <span class="arrow">→</span>
          <span class="meaning">${entry.meaning}</span>
          <button type="button" class="delete-term" aria-label="Remove">×</button>
        </li>
      `
    )
    .join('') || '<li style="justify-content:center; color: var(--ink-soft);">No matches yet.</li>';
}

function setupGlossary() {
  document.getElementById('glossary-search').addEventListener('input', (e) => {
    renderGlossary(e.target.value);
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
    renderGlossary();
  });

  document.getElementById('glossary-list').addEventListener('click', async (e) => {
    if (!e.target.classList.contains('delete-term')) return;
    const li = e.target.closest('li');
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
    <input type="text" class="ing-her" placeholder="Her words (e.g. 一把姜)" value="${her}">
    <span class="mic-btn" title="Record with voice">🎤</span>
    <input type="text" class="ing-mine" placeholder="Your translation (e.g. ~30g)" value="${mine}">
    <button type="button" class="remove-row" aria-label="Remove">×</button>
  `;
  container.appendChild(row);
}

function addStepRow(text = '') {
  const container = document.getElementById('step-rows');
  const row = document.createElement('div');
  row.className = 'step-row-input';
  row.innerHTML = `
    <input type="text" class="step-text" placeholder="Step description" value="${text}">
    <span class="mic-btn" title="Record with voice">🎤</span>
    <button type="button" class="remove-row" aria-label="Remove">×</button>
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
  const thumbs = currentMedia
    .map((m) => {
      const url = URL.createObjectURL(m.blob);
      const el = m.type === 'video' ? `<video src="${url}" muted></video>` : `<img src="${url}">`;
      return `
        <div class="media-thumb" data-media-id="${m.id}">
          ${el}
          <button type="button" class="remove-media" aria-label="Remove from gallery">×</button>
        </div>
      `;
    })
    .join('');
  container.innerHTML = `
    <p class="section-note">The gallery — new files are added alongside these. Click × to remove one.</p>
    <div class="recipe-media">${thumbs}</div>
  `;
}

function fillFormForEdit(recipe) {
  editingRecipe = recipe;
  currentMedia = recipe && recipe.media ? recipe.media.map((m) => ({ ...m, id: m.id || makeId() })) : [];
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
        type: file.type.startsWith('video') ? 'video' : 'image',
        blob: file,
        name: file.name,
      });
    });
    e.target.value = '';
    renderExistingMediaPreview();
  });

  document.getElementById('recipe-form').addEventListener('click', (e) => {
    if (e.target.classList.contains('remove-row')) {
      e.target.closest('.ingredient-row-input, .step-row-input').remove();
    }
    if (e.target.classList.contains('remove-media')) {
      const id = e.target.closest('.media-thumb').dataset.mediaId;
      currentMedia = currentMedia.filter((m) => m.id !== id);
      renderExistingMediaPreview();
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

async function moveRecipe(id, direction) {
  let recipes = await dbGetAll('recipes');
  recipes = await ensureRecipeOrder(recipes);
  recipes.sort((a, b) => a.order - b.order);

  const index = recipes.findIndex((r) => r.id === id);
  const swapWith = direction === 'up' ? index - 1 : index + 1;
  if (index === -1 || swapWith < 0 || swapWith >= recipes.length) return;

  const temp = recipes[index].order;
  recipes[index].order = recipes[swapWith].order;
  recipes[swapWith].order = temp;

  await dbPut('recipes', recipes[index]);
  await dbPut('recipes', recipes[swapWith]);
  renderRecipes();
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

  if (navigator.canShare && recipe.media && recipe.media.length) {
    try {
      const files = recipe.media.slice(0, 4).map(
        (m) =>
          new File([m.blob], m.name || (m.type === 'video' ? 'video.mp4' : 'photo.jpg'), {
            type: m.blob.type || (m.type === 'video' ? 'video/mp4' : 'image/jpeg'),
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
          dataUrl: await blobToDataURL(m.blob),
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

function mediaUrl(item) {
  const url = URL.createObjectURL(item.blob);
  cardObjectUrls.push(url);
  return url;
}

function mediaTag(item, alt, className = '') {
  const url = mediaUrl(item);
  const cls = className ? ` class="${className}"` : '';
  return item.type === 'video'
    ? `<video${cls} src="${url}" muted playsinline></video>`
    : `<img${cls} src="${url}" alt="${alt}">`;
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

  recipes.forEach((recipe, index) => {
    const card = document.createElement('article');
    card.className = 'recipe-card recipe-card-preview';
    card.dataset.id = recipe.id;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Open the full recipe for ${recipe.nameEn}`);

    const media = recipe.media || [];
    const coverHtml = media.length
      ? `<div class="card-cover">${mediaTag(media[0], recipe.nameEn)}</div>`
      : '';

    const rest = media.slice(1, 5);
    const remaining = media.length - 1 - rest.length;
    const stripHtml = rest.length
      ? `<div class="card-strip">
           ${rest.map((m) => mediaTag(m, recipe.nameEn)).join('')}
           ${remaining > 0 ? `<span class="more-count">+${remaining}</span>` : ''}
         </div>`
      : '';

    const counts = [];
    if (recipe.ingredients.length) counts.push(`${recipe.ingredients.length} ingredients`);
    if (recipe.steps.length) counts.push(`${recipe.steps.length} steps`);

    card.innerHTML = `
      <div class="card-actions">
        <button type="button" class="move-recipe" data-dir="up" aria-label="Move earlier in the sequence" ${index === 0 ? 'disabled' : ''}>▲</button>
        <button type="button" class="move-recipe" data-dir="down" aria-label="Move later in the sequence" ${index === recipes.length - 1 ? 'disabled' : ''}>▼</button>
        <button type="button" class="share-recipe" aria-label="Share recipe">📤</button>
        <button type="button" class="edit-recipe" aria-label="Edit recipe">✎</button>
        <button type="button" class="delete-recipe" aria-label="Delete recipe">🗑</button>
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

    grid.appendChild(card);
  });
}

/* ---------- Recipe detail overlay ---------- */

function openRecipeDetail(recipe) {
  const overlay = document.getElementById('recipe-detail-overlay');
  const panel = document.getElementById('recipe-detail');

  const media = recipe.media || [];
  const galleryHtml = media.length
    ? `<div class="detail-gallery">${media.map((m) => mediaTag(m, recipe.nameEn)).join('')}</div>`
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

  const nothingYet = !recipe.ingredients.length && !recipe.steps.length
    ? '<p class="steps-placeholder">Still to be written down properly with her.</p>'
    : '';

  panel.innerHTML = `
    <button type="button" id="close-recipe-detail" class="close-btn" aria-label="Close">×</button>
    <h3 id="recipe-detail-heading">${recipe.nameEn} ${recipe.nameCn ? `<span class="cn">${recipe.nameCn}</span>` : ''}</h3>
    ${recipe.story ? `<p class="recipe-story">${recipe.story}</p>` : ''}
    ${galleryHtml}
    ${ingredientsBlock}
    ${stepsHtml}
    ${nothingYet}
    <div class="detail-actions">
      <button type="button" class="mini-btn detail-share">📤 Share</button>
      <button type="button" class="mini-btn detail-edit">✎ Edit this recipe</button>
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
  const overlay = document.getElementById('recipe-detail-overlay');
  overlay.classList.add('hidden');
  document.getElementById('recipe-detail').innerHTML = '';
  document.body.classList.remove('modal-open');
}

function setupRecipeDetail() {
  const overlay = document.getElementById('recipe-detail-overlay');

  overlay.addEventListener('click', async (e) => {
    if (e.target === overlay || e.target.id === 'close-recipe-detail') {
      closeRecipeDetail();
      return;
    }
    const panel = document.getElementById('recipe-detail');
    if (e.target.classList.contains('detail-edit')) {
      const recipe = await dbGet('recipes', panel.dataset.id);
      closeRecipeDetail();
      openRecipeForm(recipe);
    } else if (e.target.classList.contains('detail-share')) {
      const recipe = await dbGet('recipes', panel.dataset.id);
      shareRecipe(recipe);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeRecipeDetail();
  });
}

function setupRecipeCardActions() {
  const grid = document.getElementById('recipe-grid');

  grid.addEventListener('keydown', async (e) => {
    const card = e.target.closest('.recipe-card[data-id]');
    if (!card || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    const recipe = await dbGet('recipes', card.dataset.id);
    if (recipe) openRecipeDetail(recipe);
  });

  grid.addEventListener('click', async (e) => {
    const card = e.target.closest('.recipe-card[data-id]');
    if (!card) return;

    if (e.target.classList.contains('delete-recipe')) {
      const recipe = await dbGet('recipes', card.dataset.id);
      const name = recipe ? recipe.nameEn : 'this recipe';
      const ok = await askConfirm({
        title: 'Delete this recipe?',
        body: `"${name}" goes for good: her words, the steps, and every photo on the card. If it isn't in a backup file, there's no other copy.`,
        confirmLabel: 'Delete it',
        cancelLabel: 'Keep it',
      });
      if (!ok) return;
      await dbDelete('recipes', card.dataset.id);
      renderRecipes();
    } else if (e.target.classList.contains('edit-recipe')) {
      const recipe = await dbGet('recipes', card.dataset.id);
      openRecipeForm(recipe);
    } else if (e.target.classList.contains('move-recipe')) {
      if (e.target.disabled) return;
      await moveRecipe(card.dataset.id, e.target.dataset.dir);
    } else if (e.target.classList.contains('share-recipe')) {
      const recipe = await dbGet('recipes', card.dataset.id);
      shareRecipe(recipe);
    } else if (!e.target.closest('.card-actions')) {
      const recipe = await dbGet('recipes', card.dataset.id);
      if (recipe) openRecipeDetail(recipe);
    }
  });
}

/* ---------- Voice-to-text ---------- */

const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;

function getVoiceLang() {
  const checked = document.querySelector('input[name="voice-lang"]:checked');
  return checked ? checked.value : 'zh-CN';
}

function setupVoiceInput() {
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
      : micBtn.previousElementSibling;
    if (!targetField) return;

    const recognition = new SpeechRecognitionAPI();
    recognition.lang = getVoiceLang();
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    micBtn.classList.add('listening');

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      targetField.value = targetField.value ? `${targetField.value} ${transcript}` : transcript;
      targetField.dispatchEvent(new Event('input'));
    };
    recognition.onerror = () => micBtn.classList.remove('listening');
    recognition.onend = () => micBtn.classList.remove('listening');

    recognition.start();
  });
}

/* ---------- Init ---------- */

async function init() {
  await seedGlossaryIfEmpty();
  await seedRecipesIfNeeded();
  setupGlossary();
  renderGlossary();

  setupRecipeForm();
  setupRecipeCardActions();
  setupRecipeDetail();
  setupVoiceInput();
  setupBackup();
  renderRecipes();
}

document.addEventListener('DOMContentLoaded', init);
