/* Taste of Home recipe reader: a Cloudflare Worker.

   Takes a photo of a handwritten recipe from the Add a Recipe form, asks
   Gemini to read and translate it, and returns the recipe ready to fill the
   form. It lives on Mei Jun's own free Cloudflare account, not in the
   kuehmachine.com repository.

   Settings (Cloudflare dashboard -> this Worker -> Settings -> Variables):
     GEMINI_API_KEY   secret, from aistudio.google.com (free tier)
     GEMINI_MODEL     optional, tried first; otherwise the free models below

   Only answers the Taste of Home page itself, and only a few times a minute
   per visitor, so nobody else can use up the free allowance. */

const ALLOWED_ORIGINS = [
  'https://www.kuehmachine.com',
  'https://kuehmachine.com',
  'http://localhost:8080',
];
/* Free-tier models, best first. The newest is often busy on the free tier,
   so a busy or rate-limited model hands over to the next. */
const FREE_MODELS = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'];
/* The first model gets longest: reading handwriting can take a while. */
const attemptTimeout = (index) => (index === 0 ? 75000 : 35000);
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const RATE_LIMIT = { windowMs: 60 * 1000, requests: 6 };
const recentRequests = new Map();

const INSTRUCTIONS = `You read handwritten home recipes, usually Chinese (simplified or traditional), written by a mother for her daughter.

Return only a JSON object, with no other text, in exactly this shape:
{
  "nameEn": "English dish name, the one a Singaporean family would use",
  "nameCn": "Chinese dish name as written, in simplified characters",
  "ingredients": [
    { "her": "the ingredient exactly as she wrote it, simplified characters, keeping her numbers and units", "mine": "a clear English translation with the quantity, e.g. 'Brown sugar 7 tbsp'" }
  ],
  "steps": ["one step per item, translated into clear English, in cooking order"],
  "unsure": ["anything you could not read with confidence, or had to assume, in a short English phrase"]
}

Rules:
- Read only what is written. Never invent ingredients, quantities or steps; if something is unreadable, leave it out of the lists and say so in "unsure".
- Convert traditional characters to simplified in "her" and "nameCn", but keep her wording (e.g. 七汤匙, 1/4茶匙, 300gm).
- gm of water means ml in "mine". 汤匙 is tbsp, 茶匙 is tsp. 黄糖 is brown sugar.
- Every step MUST be written in English. Translate her Chinese; never copy Chinese into "steps".
- Steps are short imperative English sentences without a trailing full stop, e.g. "Boil the pandan leaves and brown sugar for 15 minutes".
- Notes she adds at the side or bottom belong in the step they describe; put the steps in the order you would cook them.
- If the photo is not a recipe, return {"error": "not_a_recipe"}.`;

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function reply(origin, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

function rateLimited(address) {
  const now = Date.now();
  const recent = (recentRequests.get(address) || []).filter((t) => now - t < RATE_LIMIT.windowMs);
  recent.push(now);
  recentRequests.set(address, recent);
  if (recentRequests.size > 500) recentRequests.clear();
  return recent.length > RATE_LIMIT.requests;
}

/* The model's text, wherever the response puts it: the last model output
   step's text parts. */
function modelText(result) {
  const steps = Array.isArray(result.steps) ? result.steps : [];
  const outputs = steps.filter((s) => s.type === 'model_output');
  const parts = (outputs.length ? outputs : steps).flatMap((s) => s.content || []);
  return parts.filter((p) => p.type === 'text' && p.text).map((p) => p.text).join('\n');
}

/* The first complete JSON object in the text, ignoring any words or code
   fences around it. Oversized replies are refused. */
function extractJson(text) {
  if (typeof text !== 'string' || text.length > 100000) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/* Plain strings only, trimmed to sensible lengths. The page checks again on
   arrival and shows everything as text, never as HTML. */
const asText = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const asList = (value, max) => (Array.isArray(value) ? value.slice(0, max) : []);

/* Only the fields the form uses, as plain strings. */
function cleanRecipe(raw) {
  return {
    nameEn: asText(raw.nameEn, 200),
    nameCn: asText(raw.nameCn, 200),
    ingredients: asList(raw.ingredients, 60)
      .map((i) => ({ her: asText(i && i.her, 300), mine: asText(i && i.mine, 300) }))
      .filter((i) => i.her || i.mine),
    steps: asList(raw.steps, 60).map((step) => asText(step, 2000)).filter(Boolean),
    unsure: asList(raw.unsure, 10).map((item) => asText(item, 200)).filter(Boolean),
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return new Response('Not found', { status: 404 });
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST') return reply(origin, 405, { error: 'method_not_allowed' });
    if (!env.GEMINI_API_KEY) return reply(origin, 500, { error: 'not_configured' });

    const address = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (rateLimited(address)) return reply(origin, 429, { error: 'too_many_requests' });

    let body;
    try {
      body = await request.json();
    } catch {
      return reply(origin, 400, { error: 'bad_request' });
    }
    const image = typeof body.image === 'string' ? body.image : '';
    const mimeType = /^image\/(jpeg|png|webp)$/.test(body.mimeType || '') ? body.mimeType : 'image/jpeg';
    if (!image || image.length * 0.75 > MAX_IMAGE_BYTES) return reply(origin, 413, { error: 'image_too_large' });

    const models = [...new Set([env.GEMINI_MODEL, ...FREE_MODELS].filter(Boolean))];
    let response = null;
    let limited = false;
    for (const [index, model] of models.entries()) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), attemptTimeout(index));
      try {
        response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            system_instruction: INSTRUCTIONS,
            input: [
              { type: 'image', data: image, mime_type: mimeType },
              { type: 'text', text: 'Read this handwritten recipe and return the JSON.' },
            ],
          }),
        });
      } catch {
        response = null; // timed out or unreachable: try the next model
        console.log('Gemini attempt failed', model);
        continue;
      } finally {
        clearTimeout(timer);
      }
      if (response.ok) break;
      const detail = (await response.text()).slice(0, 300);
      console.log('Gemini error', model, response.status, detail);
      if (response.status === 429) limited = true;
      /* Busy, limited or unavailable: the next model may still answer. */
      if (![404, 429, 500, 503, 504].includes(response.status)) break;
      response = null;
    }

    if (!response) return reply(origin, limited ? 429 : 503, { error: limited ? 'daily_limit' : 'busy' });
    if (!response.ok) return reply(origin, 502, { error: 'reader_failed' });

    const raw = extractJson(modelText(await response.json()));
    if (!raw) return reply(origin, 502, { error: 'unreadable_reply' });
    if (raw.error === 'not_a_recipe') return reply(origin, 422, { error: 'not_a_recipe' });

    const recipe = cleanRecipe(raw);
    if (!recipe.ingredients.length && !recipe.steps.length) return reply(origin, 422, { error: 'nothing_found' });
    return reply(origin, 200, recipe);
  },
};
