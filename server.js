import express from "express";
import pg from "pg";
import path from "path";
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

if (!ANTHROPIC_API_KEY) console.warn("⚠️  ANTHROPIC_API_KEY not set — AI lookups will fail.");
if (!DATABASE_URL) console.warn("⚠️  DATABASE_URL not set — database features will fail.");
if (!ADMIN_PASSWORD) console.warn("⚠️  ADMIN_PASSWORD not set — admin corrections are disabled.");

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
app.get("/api/ingredients", async (_req, res) => {
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
