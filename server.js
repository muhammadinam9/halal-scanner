import express from "express";
import pg from "pg";
import path from "path";
import crypto from "crypto";
import nodemailer from "nodemailer";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || "muhammadinam9@gmail.com";
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD; // Gmail APP PASSWORD (16 chars), not the normal password

if (!ANTHROPIC_API_KEY) console.warn("⚠️  ANTHROPIC_API_KEY not set — AI lookups will fail.");
if (!DATABASE_URL) console.warn("⚠️  DATABASE_URL not set — database features will fail.");
if (!ADMIN_PASSWORD) console.warn("⚠️  ADMIN_PASSWORD not set — admin corrections are disabled.");
if (!EMAIL_PASSWORD) console.warn("⚠️  EMAIL_PASSWORD not set — the contact form cannot send email.");

/* Gmail SMTP transport for the contact form (only built if a password is configured). */
const mailer = EMAIL_PASSWORD
  ? nodemailer.createTransport({
      host: "smtp.gmail.com", port: 465, secure: true,
      auth: { user: CONTACT_EMAIL, pass: EMAIL_PASSWORD },
      connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 8000, // fail fast if SMTP is blocked
      family: 4, // force IPv4 — Render containers have no IPv6 route (ENETUNREACH on IPv6)
    })
  : null;

/* ---------- Language helpers ---------- */
const LANG_NAME = { en: "English", ur: "Urdu", hi: "Hindi", ar: "Arabic" };
const langName = code => LANG_NAME[code] || "English";
const normLang = code => (LANG_NAME[String(code || "en")] ? String(code) : "en");
// Return the explanation fields in the requested language, falling back to the English/base columns.
function pickI18n(row, lang) {
  const j = row.i18n || {};
  if (lang && lang !== "en" && j[lang]) return j[lang];
  return { reason: row.reason, description: row.description, sources: row.sources };
}

/* ---------- Postgres (Neon) ---------- */
const { Pool } = pg;
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Neon requires SSL
});

/* Seed ingredients: h = halal, x = haram, d = doubtful */
const SEED = {
  pork:"x", lard:"x", bacon:"x", ham:"x", "pork fat":"x", "pig fat":"x",
  alcohol:"x", ethanol:"x", "ethyl alcohol":"x", wine:"x", beer:"x", rum:"x", liquor:"x",
  blood:"x", "blood plasma":"x", carmine:"x", cochineal:"x", e120:"x", civet:"x",
  gelatin:"d", gelatine:"d", e441:"d",
  "mono- and diglycerides":"d", monoglycerides:"d", diglycerides:"d", e471:"d",
  glycerin:"d", glycerine:"d", glycerol:"d", e422:"d",
  rennet:"d", enzymes:"d", enzyme:"d", lipase:"d", pepsin:"d", "l-cysteine":"d", e920:"d",
  "natural flavor":"d", "natural flavors":"d", "natural flavour":"d", flavoring:"d",
  shortening:"d", emulsifier:"d", "stearic acid":"d", e570:"d", "magnesium stearate":"d",
  lecithin:"d", whey:"d", "vanilla extract":"d", tallow:"d", "animal fat":"d", stearate:"d", e472:"d",
  sugar:"h", salt:"h", water:"h", "wheat flour":"h", flour:"h", rice:"h",
  corn:"h", "corn syrup":"h", "high fructose corn syrup":"h", glucose:"h", fructose:"h",
  "vegetable oil":"h", "palm oil":"h", "sunflower oil":"h", "canola oil":"h", "olive oil":"h", "soybean oil":"h",
  "citric acid":"h", e330:"h", "ascorbic acid":"h", "vitamin c":"h", e300:"h",
  "baking soda":"h", "sodium bicarbonate":"h", "baking powder":"h",
  cocoa:"h", "cocoa butter":"h", milk:"h", "skim milk":"h", cream:"h", butter:"h",
  soy:"h", "soy lecithin":"h", "soya lecithin":"h", yeast:"h", "yeast extract":"h",
  pectin:"h", e440:"h", carrageenan:"h", e407:"h", "guar gum":"h", "xanthan gum":"h", e415:"h",
  maltodextrin:"h", dextrose:"h", starch:"h", "corn starch":"h", "modified starch":"h",
  honey:"h", vanilla:"h", cinnamon:"h", spices:"h", pepper:"h",
  "soy protein":"h", peanut:"h", peanuts:"h", almond:"h", oats:"h",
  "potassium sorbate":"h", "sodium benzoate":"h", "calcium carbonate":"h", e202:"h", e211:"h"
};

/* Plain-English reasons for why each seeded doubtful (d) ingredient is source-dependent. */
const REASONS = {
  gelatin:"often derived from pork or non-halal animals", gelatine:"often derived from pork or non-halal animals", e441:"gelatin-based, often from pork or non-halal animals",
  "mono- and diglycerides":"can be made from animal or plant fat", monoglycerides:"can be made from animal or plant fat", diglycerides:"can be made from animal or plant fat", e471:"can be made from animal or plant fat",
  glycerin:"can be animal or vegetable derived", glycerine:"can be animal or vegetable derived", glycerol:"can be animal or vegetable derived", e422:"can be animal or vegetable derived",
  rennet:"often sourced from non-halal animal stomachs",
  enzymes:"may come from animal, plant, or microbial sources", enzyme:"may come from animal, plant, or microbial sources", lipase:"may come from animal, plant, or microbial sources", pepsin:"often derived from non-halal animal sources",
  "l-cysteine":"may be derived from human hair or animal feathers", e920:"may be derived from human hair or animal feathers",
  "natural flavor":"source not specified, may be animal-derived", "natural flavors":"source not specified, may be animal-derived", "natural flavour":"source not specified, may be animal-derived", flavoring:"source not specified, may be animal-derived",
  shortening:"may contain animal-derived fat", emulsifier:"may be animal or plant derived",
  "stearic acid":"can be animal or vegetable sourced", e570:"can be animal or vegetable sourced", "magnesium stearate":"can be animal or vegetable sourced", stearate:"can be animal or vegetable sourced", e472:"can be animal or vegetable sourced",
  lecithin:"usually soy but can be egg or animal derived",
  whey:"may use rennet from non-halal animal sources",
  "vanilla extract":"may contain alcohol as a solvent",
  tallow:"rendered animal fat, may be non-halal", "animal fat":"rendered animal fat, may be non-halal"
};

async function initDb() {
  if (!DATABASE_URL) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ingredients (
      name   TEXT PRIMARY KEY,
      status CHAR(1) NOT NULL CHECK (status IN ('h','x','d')),
      reason TEXT,
      source TEXT DEFAULT 'seed',
      added  TIMESTAMPTZ DEFAULT now()
    );
  `);
  // For databases created before these columns existed (no data is dropped).
  await pool.query("ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS reason TEXT");
  await pool.query("ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS source TEXT");
  await pool.query("ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS description TEXT");
  await pool.query("ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS sources TEXT");
  // Per-language cache of AI explanations: { "ur": {reason,description,sources}, "ar": {...} }.
  // The base reason/description/sources columns hold the English/default text.
  await pool.query("ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS i18n JSONB DEFAULT '{}'::jsonb");

  // Whole-product cache: a hash of the full label text -> parsed result, per language.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_cache (
      hash    TEXT NOT NULL,
      lang    TEXT NOT NULL DEFAULT 'en',
      results JSONB NOT NULL,
      added   TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (hash, lang)
    );
  `);

  // Anonymous usage log — NO IP or personal data, only recognized ingredient names.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scan_logs (
      id               SERIAL PRIMARY KEY,
      scanned_at       TIMESTAMPTZ DEFAULT now(),
      ingredient_count INT,
      ingredients_text TEXT
    );
  `);

  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM ingredients");
  if (rows[0].n === 0) {
    const keys = Object.keys(SEED);
    const values = keys.map((k, i) => `($${i*3+1}, $${i*3+2}, $${i*3+3}, 'seed')`).join(",");
    const params = keys.flatMap(k => [k, SEED[k], REASONS[k] || null]);
    await pool.query(
      `INSERT INTO ingredients(name,status,reason,source) VALUES ${values} ON CONFLICT DO NOTHING`,
      params
    );
    console.log(`Seeded ${keys.length} ingredients.`);
  }

  // Backfill reasons for doubtful items seeded before this column existed.
  for (const [name, reason] of Object.entries(REASONS)) {
    await pool.query("UPDATE ingredients SET reason = $2 WHERE name = $1 AND reason IS NULL", [name, reason]);
  }
}

/* ---------- API: get full library ---------- */
app.get("/api/ingredients", async (req, res) => {
  try {
    const lang = normLang(req.query.lang);
    const { rows } = await pool.query("SELECT name,status,reason,description,sources,i18n FROM ingredients ORDER BY name");
    const items = {}, reasons = {};
    rows.forEach(r => { items[r.name] = r.status; const p = pickI18n(r, lang); if (p.reason) reasons[r.name] = p.reason; });
    res.json({ items, reasons });
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: String(e.message) });
  }
});

/* ---------- API: single ingredient detail (for tap-to-detail cards) ---------- */
app.get("/api/ingredient/:name", async (req, res) => {
  const nm = String(req.params.name || "").toLowerCase().trim();
  if (!nm) return res.status(400).json({ found: false });
  try {
    const lang = normLang(req.query.lang);
    const { rows } = await pool.query(
      "SELECT name,status,reason,description,sources,i18n FROM ingredients WHERE name = $1", [nm]
    );
    if (!rows.length) return res.json({ found: false });
    const r = rows[0];
    const p = pickI18n(r, lang);
    res.json({ found: true, name: r.name, status: r.status, reason: p.reason, description: p.description, sources: p.sources });
  } catch (e) {
    res.status(500).json({ found: false, error: "db_error", detail: String(e.message) });
  }
});

/* ---------- API: fill in a missing description/sources for one ingredient (AI, then cache) ---------- */
app.post("/api/enrich-ingredient", async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(503).json({ error: "no_api_key" });
  const name = String(req.body.name || "").toLowerCase().trim();
  if (!name) return res.status(400).json({ error: "bad_request" });
  const lang = normLang(req.body.lang);
  try {
    const cur = await pool.query("SELECT status,reason,description,sources,i18n FROM ingredients WHERE name = $1", [name]);
    const row = cur.rows[0];
    const langLine = lang === "en" ? "" : `Write the "description" and "sources" in ${langName(lang)}.\n`;
    const prompt =
`For the single food/cosmetic ingredient "${name}", return:
- "description": one short plain-English sentence saying what it is.
- "sources": one short sentence on where it typically comes from (animal, plant, synthetic, or microbial).
${langLine}Return ONLY a JSON object, no prose, no markdown:
{"description":"...","sources":"..."}`;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type":"application/json","x-api-key":ANTHROPIC_API_KEY,"anthropic-version":"2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 300, messages: [{ role:"user", content: prompt }] }),
    });
    if (!r.ok) return res.status(502).json({ error: "claude_error", status: r.status });
    const d = await r.json();
    let txt = d.content.filter(c => c.type === "text").map(c => c.text).join("\n").replace(/```json|```/g,"").trim();
    const obj = JSON.parse(txt);
    const description = obj.description ? String(obj.description).trim() : null;
    const sources = obj.sources ? String(obj.sources).trim() : null;

    if (row) {
      // Merge into i18n (preserving any existing reason for this language) and the base columns.
      const i18n = row.i18n || {};
      i18n[lang] = { ...(i18n[lang] || {}), description, sources };
      const baseDesc = lang === "en" ? (description || row.description) : row.description;
      const baseSrc  = lang === "en" ? (sources || row.sources) : row.sources;
      // Only fills description/sources — never touches status or reason, so admin corrections stay intact.
      await pool.query(
        "UPDATE ingredients SET description = $2, sources = $3, i18n = $4::jsonb WHERE name = $1",
        [name, baseDesc, baseSrc, JSON.stringify(i18n)]
      );
    }
    res.json({ name, description, sources });
  } catch (e) {
    res.status(500).json({ error: "enrich_failed", detail: String(e.message) });
  }
});

/* ---------- API: save learned ingredients ---------- */
app.post("/api/ingredients", async (req, res) => {
  try {
    const items = req.body.items || [];
    const lang = normLang(req.body.lang);
    for (const it of items) {
      if (!it.name || !["h","x","d"].includes(it.status)) continue;
      const reason = it.status === "d" ? (it.reason || null) : null;
      const description = it.description ? String(it.description).trim() : null;
      const sources = it.sources ? String(it.sources).trim() : null;
      // English goes in the base columns; other languages go in i18n[lang]. Status is language-independent.
      const isEn = lang === "en";
      const i18n = JSON.stringify({ [lang]: { reason, description, sources } });
      await pool.query(
        `INSERT INTO ingredients(name,status,reason,description,sources,i18n,source)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,'ai')
         ON CONFLICT (name) DO UPDATE SET
           status = EXCLUDED.status,
           reason = COALESCE(EXCLUDED.reason, ingredients.reason),
           description = COALESCE(EXCLUDED.description, ingredients.description),
           sources = COALESCE(EXCLUDED.sources, ingredients.sources),
           i18n = COALESCE(ingredients.i18n,'{}'::jsonb) || EXCLUDED.i18n
         WHERE ingredients.source IS DISTINCT FROM 'admin'`,
        [it.name.toLowerCase().trim(), it.status, isEn ? reason : null, isEn ? description : null, isEn ? sources : null, i18n]
      );
    }
    res.json({ ok: true, saved: items.length });
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: String(e.message) });
  }
});

/* ---------- API: admin manual correction (password-protected) ---------- */
app.post("/api/ingredients/update", async (req, res) => {
  const { password, name, status, reason } = req.body || {};
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: "admin_disabled" });
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: "unauthorized" });
  if (!name || !["h","x","d"].includes(status)) return res.status(400).json({ error: "bad_request" });
  try {
    const nm = String(name).toLowerCase().trim();
    const rsn = status === "d" ? (reason ? String(reason).trim() : null) : null;
    // source='admin' marks this as a manual correction so AI assessments never overwrite it.
    await pool.query(
      `INSERT INTO ingredients(name,status,reason,source) VALUES ($1,$2,$3,'admin')
       ON CONFLICT (name) DO UPDATE SET status = EXCLUDED.status, reason = EXCLUDED.reason, source = 'admin'`,
      [nm, status, rsn]
    );
    res.json({ ok: true, name: nm, status, reason: rsn });
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: String(e.message) });
  }
});

/* ---------- API: admin delete an ingredient (password-protected) ---------- */
app.post("/api/ingredients/delete", async (req, res) => {
  const { password, name } = req.body || {};
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: "admin_disabled" });
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: "unauthorized" });
  if (!name) return res.status(400).json({ error: "bad_request" });
  try {
    const nm = String(name).toLowerCase().trim();
    const r = await pool.query("DELETE FROM ingredients WHERE name = $1", [nm]);
    res.json({ ok: true, deleted: r.rowCount });
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: String(e.message) });
  }
});

/* ---------- API: barcode lookup via Open Food Facts ---------- */
app.get("/api/product/:barcode", async (req, res) => {
  const code = String(req.params.barcode || "").replace(/[^0-9]/g, "");
  if (!code) return res.status(400).json({ found: false, error: "bad_barcode" });
  try {
    const url = `https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,generic_name,ingredients_text,ingredients_text_en`;
    const r = await fetch(url, { headers: { "User-Agent": "HalalScanner/1.0 (ingredient screening)" } });
    if (!r.ok) return res.status(502).json({ found: false, error: "off_error", status: r.status });
    const d = await r.json();
    if (d.status !== 1 || !d.product) return res.json({ found: false, barcode: code });
    const p = d.product;
    const ingredients = (p.ingredients_text_en || p.ingredients_text || "").trim();
    res.json({ found: true, name: (p.product_name || p.generic_name || "").trim(), ingredients, barcode: code });
  } catch (e) {
    res.status(500).json({ found: false, error: "lookup_failed", detail: String(e.message) });
  }
});

/* ---------- API: assess unknown ingredients via Claude ---------- */
app.post("/api/assess", async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(503).json({ error: "no_api_key" });
  const names = req.body.names || [];
  if (!names.length) return res.json({ results: [] });
  const lang = normLang(req.body.lang);
  const langLine = lang === "en" ? "" :
`Respond in ${langName(lang)}. The ingredient label may be in any language — read and understand it, but write all explanations, reasons, descriptions, and the verdict wording in ${langName(lang)}. Keep the "name" field exactly as given (do NOT translate it) and keep "status" as the letter code h/x/d.
`;
  try {
    const prompt =
`You are assessing food/cosmetic ingredients against Islamic dietary law (halal/haram).
${langLine}
For each ingredient return a status:
- "h" = halal / generally permissible
- "x" = haram (e.g. pork derivatives, intoxicating alcohol, blood, carmine)
- "d" = doubtful / mashbooh (source-dependent: animal, plant, or microbial — needs verification)
Be conservative: if permissibility depends on the source, mark "d".
For status "d" ONLY, add a "reason": one short plain-English sentence (under 15 words)
explaining why it is source-dependent, e.g. "can be made from animal or plant fat".
For "h" and "x", set "reason" to "".
For EVERY ingredient also add:
- "description": one short plain-English sentence saying what the ingredient is.
- "sources": one short sentence on where it typically comes from (animal, plant, synthetic, or microbial).
Return ONLY a JSON array, no prose, no markdown:
[{"name":"<exact name as given>","status":"h|x|d","reason":"<short reason if d, else empty>","description":"<one sentence>","sources":"<one sentence>"}]
Ingredients: ${JSON.stringify(names)}`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 1200, messages: [{ role:"user", content: prompt }] }),
    });
    if (!r.ok) return res.status(502).json({ error: "claude_error", status: r.status });
    const d = await r.json();
    let txt = d.content.filter(c => c.type === "text").map(c => c.text).join("\n").replace(/```json|```/g,"").trim();
    let arr = JSON.parse(txt);
    res.json({ results: Array.isArray(arr) ? arr : [] });
  } catch (e) {
    res.status(500).json({ error: "assess_failed", detail: String(e.message) });
  }
});

/* ---------- API: smart scan — parse + rule the whole label in one AI step ---------- */
app.post("/api/scan", async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(503).json({ error: "no_api_key" });
  const text = String(req.body.text || "").trim();
  if (!text) return res.json({ results: [], cached: false });
  const lang = normLang(req.body.lang);
  // Hash a normalized version of the label so trivial whitespace/case changes still hit cache.
  const norm = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const hash = crypto.createHash("sha256").update(norm).digest("hex");
  try {
    // 1) Whole-product cache — a repeat scan of the same label is free (no AI call).
    const hit = await pool.query("SELECT results FROM product_cache WHERE hash = $1 AND lang = $2 AND added > now() - interval '90 days'", [hash, lang]);
    let results, cached = false;
    if (hit.rows.length) {
      results = hit.rows[0].results || [];
      cached = true;
    } else {
      const langLine = lang === "en" ? "" :
        `Write every "reason", "description" and "sources" value in ${langName(lang)} (keep "name" in its original/English form and "status" as h/x/d).\n`;
      const prompt =
`You are a halal/haram food ingredient analyst. You are given the FULL raw text scanned from a product label; it may contain noise. Follow these rules exactly.

1. STANDARD: Base every ruling on the IFANCA (Islamic Food and Nutrition Council of America) halal standard, and apply its positions on ingredient permissibility consistently.

2. PARENTHETICAL NAMES: When an ingredient is written as "Category (Specific Name)" — e.g. "Emulsifier (Soya Lecithin)" or "Antioxidant (E306)" — judge it by the SPECIFIC name inside the parentheses and return it as ONE ingredient using that specific name (e.g. "soya lecithin", "e306"). NEVER output the generic category word ("emulsifier", "antioxidant", "raising agent", "stabilizer", "preservative") as a separate ingredient.

3. DO NOT OVER-FLAG clearly permissible foods. These are "h" (halal), NOT doubtful: egg, milk, butter, cream, cheese (unless animal rennet is named), yogurt, honey, fish, fruit, vegetables, grains, sugar, salt, water, flour, yeast, vegetable oils, soya lecithin.

4. Mark "x" (haram) ONLY for clearly prohibited items: pork and pork derivatives, lard, blood, intoxicating alcohol/ethanol, carmine/cochineal (E120), and ingredients explicitly from non-halal slaughtered animals.

5. Mark "d" (doubtful) ONLY when permissibility genuinely depends on an unknown source: gelatin, mono- and diglycerides (E471), glycerin/glycerol, enzymes, rennet, natural flavors, shortening, animal fat, L-cysteine, and stearic acid/stearates when the source is unspecified.

6. IGNORE non-ingredient text: storage instructions ("store in a cool and dry place"), origin ("product of Pakistan"), company names, addresses, allergen "contains" lines, and nutrition facts.

7. For each ingredient return: "name" (the specific ingredient, lowercase), "status" ("h"/"x"/"d"), a "reason" (short, under 15 words, ONLY for "d" or "x"; "" for "h"), a "description" (one short sentence: what it is), and "sources" (one short sentence: typical origin — animal/plant/synthetic/microbial).
${langLine}Return ONLY a JSON array, no prose, no markdown:
[{"name":"...","status":"h|x|d","reason":"...","description":"...","sources":"..."}]

Label text:
"""
${text}
"""`;

      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type":"application/json","x-api-key":ANTHROPIC_API_KEY,"anthropic-version":"2023-06-01" },
        body: JSON.stringify({ model: MODEL, max_tokens: 4000, messages: [{ role:"user", content: prompt }] }),
      });
      if (!r.ok) return res.status(502).json({ error: "claude_error", status: r.status });
      const d = await r.json();
      let txt = d.content.filter(c => c.type === "text").map(c => c.text).join("\n").replace(/```json|```/g,"").trim();
      let arr = JSON.parse(txt);
      results = (Array.isArray(arr) ? arr : [])
        .filter(x => x && x.name && ["h","x","d"].includes(x.status))
        .map(x => ({
          name: String(x.name).toLowerCase().trim(),
          status: x.status,
          reason: x.reason ? String(x.reason).trim() : "",
          description: x.description ? String(x.description).trim() : "",
          sources: x.sources ? String(x.sources).trim() : "",
        }));

      // Cache the whole-product result, and save each ingredient to the library.
      await pool.query(
        `INSERT INTO product_cache(hash,lang,results) VALUES ($1,$2,$3::jsonb)
         ON CONFLICT (hash,lang) DO UPDATE SET results = EXCLUDED.results, added = now()`,
        [hash, lang, JSON.stringify(results)]
      );
      const isEn = lang === "en";
      for (const it of results) {
        const reason = it.reason || null, description = it.description || null, sources = it.sources || null;
        const i18n = JSON.stringify({ [lang]: { reason, description, sources } });
        await pool.query(
          `INSERT INTO ingredients(name,status,reason,description,sources,i18n,source)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,'ai')
           ON CONFLICT (name) DO UPDATE SET
             status = EXCLUDED.status,
             reason = COALESCE(EXCLUDED.reason, ingredients.reason),
             description = COALESCE(EXCLUDED.description, ingredients.description),
             sources = COALESCE(EXCLUDED.sources, ingredients.sources),
             i18n = COALESCE(ingredients.i18n,'{}'::jsonb) || EXCLUDED.i18n
           WHERE ingredients.source IS DISTINCT FROM 'admin'`,
          [it.name, it.status, isEn ? reason : null, isEn ? description : null, isEn ? sources : null, i18n]
        );
      }
    }

    // 2) Admin corrections always win — overlay any admin-locked rulings onto the result.
    if (results.length) {
      const names = results.map(r => r.name);
      const ov = await pool.query(
        "SELECT name,status,reason,description,sources,i18n FROM ingredients WHERE name = ANY($1) AND source = 'admin'", [names]
      );
      if (ov.rows.length) {
        const map = {};
        ov.rows.forEach(r => { const p = pickI18n(r, lang); map[r.name] = { status: r.status, reason: p.reason || "", description: p.description || "", sources: p.sources || "" }; });
        results = results.map(r => map[r.name] ? { name: r.name, ...map[r.name] } : r);
      }
    }

    // Anonymous log: only the recognized ingredient names + count (never raw OCR text or IPs).
    if (results.length) {
      try {
        await pool.query(
          "INSERT INTO scan_logs(ingredient_count, ingredients_text) VALUES ($1, $2)",
          [results.length, results.map(r => r.name).join(", ")]
        );
      } catch (e) { /* logging must never break a scan */ }
    }

    res.json({ results, cached });
  } catch (e) {
    res.status(500).json({ error: "scan_failed", detail: String(e.message) });
  }
});

/* ---------- API: admin anonymous usage stats (password-protected) ---------- */
app.get("/api/stats", async (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: "admin_disabled" });
  if (req.query.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "unauthorized" });
  try {
    const total = await pool.query("SELECT COUNT(*)::int AS n FROM scan_logs");
    const week = await pool.query("SELECT COUNT(*)::int AS n FROM scan_logs WHERE scanned_at >= now() - interval '7 days'");
    // Split each log's comma-separated names into rows, then count how often each appears.
    const top = await pool.query(`
      SELECT trim(both ' ' from ing) AS name, COUNT(*)::int AS count
      FROM scan_logs, LATERAL unnest(string_to_array(ingredients_text, ',')) AS ing
      WHERE ingredients_text IS NOT NULL AND trim(both ' ' from ing) <> ''
      GROUP BY 1
      ORDER BY count DESC, name
      LIMIT 20;
    `);
    res.json({
      totalScans: total.rows[0].n,
      last7Days: week.rows[0].n,
      topIngredients: top.rows,
    });
  } catch (e) {
    res.status(500).json({ error: "stats_failed", detail: String(e.message) });
  }
});

/* ---------- API: contact form — send an email via Gmail SMTP ---------- */
app.post("/api/contact", async (req, res) => {
  if (!mailer) return res.status(503).json({ error: "email_disabled" });
  const name = String(req.body.name || "").trim().slice(0, 120);
  const email = String(req.body.email || "").trim().slice(0, 200);
  const message = String(req.body.message || "").trim().slice(0, 5000);
  if (!message) return res.status(400).json({ error: "empty_message" });
  try {
    await mailer.sendMail({
      from: `"Halal Scanner" <${CONTACT_EMAIL}>`,            // must be the authenticated Gmail account
      to: CONTACT_EMAIL,
      replyTo: email || undefined,                           // so you can reply straight to the sender
      subject: `Halal Scanner — message from ${name || "a user"}`,
      text: `${message}\n\n— ${name || "(no name)"}${email ? ` (${email})` : ""}`,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "send_failed", detail: String(e.message) });
  }
});

/* ---------- API: draft a company inquiry email ---------- */
app.post("/api/draft-email", async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(503).json({ error: "no_api_key" });
  const { product = "", ingredient = "" } = req.body;
  const lang = normLang(req.body.lang);
  const langLine = lang === "en" ? "" : ` Write the entire email in ${langName(lang)}.`;
  try {
    const p = `Write a short, polite customer-service email asking a food company to clarify the source of a specific ingredient, because the sender follows a halal diet. Ask whether it is animal, plant, or microbial/synthetic in origin, and if animal-derived whether it is halal; also ask if the product holds halal certification. Product: "${product||"(unspecified)"}". Ingredient of concern: "${ingredient}". Keep it under 130 words. End with "Kind regards," on its own line and nothing after. Return only the email body, no subject line, no preamble.${langLine}`;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 500, messages: [{ role:"user", content: p }] }),
    });
    if (!r.ok) return res.status(502).json({ error: "claude_error", status: r.status });
    const d = await r.json();
    const txt = d.content.filter(c => c.type === "text").map(c => c.text).join("\n").trim();
    res.json({ draft: txt });
  } catch (e) {
    res.status(500).json({ error: "draft_failed", detail: String(e.message) });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

initDb()
  .then(() => app.listen(PORT, () => console.log(`Halal Scanner running on :${PORT}`)))
  .catch(e => { console.error("DB init failed:", e); app.listen(PORT, () => console.log(`Running on :${PORT} (db init failed)`)); });
