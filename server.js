import express from "express";
import pg from "pg";
import path from "path";
import crypto from "crypto";
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

/* ---------- VERIFIED authority table ----------
   Human-curated rulings based on published halal-certification guidance
   (IFANCA / JAKIM / SANHA style lists). These are deterministic:
   they are matched BEFORE any AI call and are never overwritten by AI. */
const VERIFIED = {
  // Colours E100–E199
  e100:{s:"h",r:""}, e101:{s:"d",r:"riboflavin may be produced using animal-derived media"},
  e102:{s:"h",r:""}, e104:{s:"h",r:""}, e110:{s:"h",r:""},
  e120:{s:"x",r:"carmine/cochineal — made from insects, not permissible"},
  e122:{s:"h",r:""}, e123:{s:"h",r:""}, e124:{s:"h",r:""}, e127:{s:"h",r:""},
  e129:{s:"h",r:""}, e131:{s:"h",r:""}, e132:{s:"h",r:""}, e133:{s:"h",r:""},
  e140:{s:"h",r:""}, e141:{s:"h",r:""}, e142:{s:"h",r:""},
  e150a:{s:"h",r:""}, e150b:{s:"h",r:""}, e150c:{s:"h",r:""}, e150d:{s:"h",r:""},
  e151:{s:"h",r:""}, e153:{s:"d",r:"vegetable carbon is halal; animal-bone charcoal is not"},
  e155:{s:"h",r:""}, e160a:{s:"h",r:""},
  e160b:{s:"h",r:""}, e160c:{s:"h",r:""},
  e160d:{s:"h",r:""}, e160e:{s:"h",r:""},
  e161b:{s:"h",r:""}, e162:{s:"h",r:""}, e163:{s:"h",r:""},
  e170:{s:"h",r:""}, e171:{s:"h",r:""}, e172:{s:"h",r:""}, e173:{s:"h",r:""},
  e174:{s:"h",r:""}, e175:{s:"h",r:""},
  // Preservatives E200–E299
  e200:{s:"h",r:""}, e201:{s:"h",r:""}, e202:{s:"h",r:""}, e203:{s:"h",r:""},
  e210:{s:"h",r:""}, e211:{s:"h",r:""}, e212:{s:"h",r:""}, e213:{s:"h",r:""},
  e220:{s:"h",r:""}, e221:{s:"h",r:""}, e222:{s:"h",r:""}, e223:{s:"h",r:""},
  e224:{s:"h",r:""}, e226:{s:"h",r:""}, e227:{s:"h",r:""}, e228:{s:"h",r:""},
  e234:{s:"h",r:""}, e235:{s:"h",r:""},
  e249:{s:"h",r:""}, e250:{s:"h",r:""}, e251:{s:"h",r:""}, e252:{s:"h",r:""},
  e260:{s:"h",r:""}, e261:{s:"h",r:""}, e262:{s:"h",r:""}, e263:{s:"h",r:""},
  e270:{s:"h",r:""}, e280:{s:"h",r:""}, e281:{s:"h",r:""}, e282:{s:"h",r:""},
  e283:{s:"h",r:""}, e290:{s:"h",r:""}, e296:{s:"h",r:""}, e297:{s:"h",r:""},
  // Antioxidants & acids E300–E399
  e300:{s:"h",r:""}, e301:{s:"h",r:""}, e302:{s:"h",r:""},
  e304:{s:"d",r:"ascorbyl palmitate — palmitate can be animal or plant derived"},
  e306:{s:"h",r:""}, e307:{s:"h",r:""}, e308:{s:"h",r:""}, e309:{s:"h",r:""},
  e310:{s:"h",r:""}, e311:{s:"h",r:""}, e312:{s:"h",r:""},
  e319:{s:"h",r:""}, e320:{s:"h",r:""}, e321:{s:"h",r:""},
  e322:{s:"d",r:"lecithin is usually soy but can be egg or animal derived"},
  e325:{s:"h",r:""}, e326:{s:"h",r:""}, e327:{s:"h",r:""},
  e330:{s:"h",r:""}, e331:{s:"h",r:""}, e332:{s:"h",r:""}, e333:{s:"h",r:""},
  e334:{s:"h",r:""}, e335:{s:"h",r:""}, e336:{s:"h",r:""}, e337:{s:"h",r:""},
  e338:{s:"h",r:""}, e339:{s:"h",r:""}, e340:{s:"h",r:""}, e341:{s:"h",r:""},
  e350:{s:"h",r:""}, e351:{s:"h",r:""}, e352:{s:"h",r:""},
  e353:{s:"h",r:""}, e354:{s:"h",r:""}, e355:{s:"h",r:""},
  e363:{s:"h",r:""}, e380:{s:"h",r:""},
  // Thickeners & emulsifiers E400–E499
  e400:{s:"h",r:""}, e401:{s:"h",r:""}, e402:{s:"h",r:""}, e403:{s:"h",r:""},
  e404:{s:"h",r:""}, e405:{s:"h",r:""}, e406:{s:"h",r:""}, e407:{s:"h",r:""},
  e407a:{s:"h",r:""}, e410:{s:"h",r:""}, e412:{s:"h",r:""}, e413:{s:"h",r:""},
  e414:{s:"h",r:""}, e415:{s:"h",r:""}, e416:{s:"h",r:""}, e417:{s:"h",r:""},
  e418:{s:"h",r:""}, e420:{s:"h",r:""}, e421:{s:"h",r:""},
  e422:{s:"d",r:"glycerin/glycerol can be animal or vegetable derived"},
  e430:{s:"d",r:"polyoxyethylene stearate — stearate source may be animal"},
  e431:{s:"d",r:"stearate source may be animal"},
  e432:{s:"d",r:"polysorbate — fatty acid source may be animal"},
  e433:{s:"d",r:"polysorbate — fatty acid source may be animal"},
  e434:{s:"d",r:"polysorbate — fatty acid source may be animal"},
  e435:{s:"d",r:"polysorbate — fatty acid source may be animal"},
  e436:{s:"d",r:"polysorbate — fatty acid source may be animal"},
  e440:{s:"h",r:""}, e441:{s:"x",r:"gelatin — animal derived; haram unless certified halal source"},
  e442:{s:"d",r:"ammonium phosphatides — fatty acid source may be animal"},
  e444:{s:"h",r:""}, e445:{s:"h",r:""},
  e450:{s:"h",r:""}, e451:{s:"h",r:""}, e452:{s:"h",r:""},
  e460:{s:"h",r:""}, e461:{s:"h",r:""}, e463:{s:"h",r:""}, e464:{s:"h",r:""},
  e465:{s:"h",r:""}, e466:{s:"h",r:""},
  e470a:{s:"d",r:"fatty acid salts — source may be animal or plant"},
  e470b:{s:"d",r:"fatty acid salts — source may be animal or plant"},
  e471:{s:"d",r:"mono- and diglycerides — can be made from animal or plant fat"},
  e472a:{s:"d",r:"fatty acid ester — source may be animal or plant"},
  e472b:{s:"d",r:"fatty acid ester — source may be animal or plant"},
  e472c:{s:"d",r:"fatty acid ester — source may be animal or plant"},
  e472d:{s:"d",r:"fatty acid ester — source may be animal or plant"},
  e472e:{s:"d",r:"fatty acid ester (DATEM) — source may be animal or plant"},
  e472f:{s:"d",r:"fatty acid ester — source may be animal or plant"},
  e473:{s:"d",r:"sucrose esters — fatty acid source may be animal"},
  e474:{s:"d",r:"sucroglycerides — fatty acid source may be animal"},
  e475:{s:"d",r:"polyglycerol esters — fatty acid source may be animal"},
  e476:{s:"d",r:"polyglycerol polyricinoleate — glycerol source may be animal"},
  e477:{s:"d",r:"propylene glycol esters — fatty acid source may be animal"},
  e481:{s:"d",r:"sodium stearoyl lactylate — stearic acid source may be animal"},
  e482:{s:"d",r:"calcium stearoyl lactylate — stearic acid source may be animal"},
  e483:{s:"d",r:"stearyl tartrate — stearic acid source may be animal"},
  e491:{s:"d",r:"sorbitan stearate — stearic acid source may be animal"},
  e492:{s:"d",r:"sorbitan tristearate — stearic acid source may be animal"},
  e493:{s:"d",r:"sorbitan laurate — fatty acid source may be animal"},
  e494:{s:"d",r:"sorbitan oleate — fatty acid source may be animal"},
  e495:{s:"d",r:"sorbitan palmitate — fatty acid source may be animal"},
  // E500s
  e500:{s:"h",r:""}, e501:{s:"h",r:""}, e503:{s:"h",r:""}, e504:{s:"h",r:""},
  e507:{s:"h",r:""}, e508:{s:"h",r:""}, e509:{s:"h",r:""}, e511:{s:"h",r:""},
  e512:{s:"h",r:""}, e513:{s:"h",r:""}, e514:{s:"h",r:""}, e515:{s:"h",r:""},
  e516:{s:"h",r:""}, e517:{s:"h",r:""}, e520:{s:"h",r:""}, e521:{s:"h",r:""},
  e524:{s:"h",r:""}, e525:{s:"h",r:""}, e526:{s:"h",r:""}, e527:{s:"h",r:""},
  e528:{s:"h",r:""}, e529:{s:"h",r:""}, e530:{s:"h",r:""},
  e535:{s:"h",r:""}, e536:{s:"h",r:""}, e538:{s:"h",r:""},
  e541:{s:"h",r:""},
  e542:{s:"x",r:"bone phosphate — animal bone derived; haram unless certified halal source"},
  e551:{s:"h",r:""}, e552:{s:"h",r:""}, e553a:{s:"h",r:""}, e553b:{s:"h",r:""},
  e554:{s:"h",r:""}, e556:{s:"h",r:""}, e558:{s:"h",r:""}, e559:{s:"h",r:""},
  e570:{s:"d",r:"stearic acid — can be animal or vegetable sourced"},
  e572:{s:"d",r:"magnesium stearate — stearic acid source may be animal"},
  e574:{s:"h",r:""}, e575:{s:"h",r:""}, e576:{s:"h",r:""}, e577:{s:"h",r:""},
  e578:{s:"h",r:""}, e579:{s:"h",r:""}, e585:{s:"h",r:""},
  // Flavour enhancers E600s
  e620:{s:"h",r:""}, e621:{s:"h",r:""}, e622:{s:"h",r:""}, e623:{s:"h",r:""},
  e624:{s:"h",r:""}, e625:{s:"h",r:""},
  e626:{s:"d",r:"guanylic acid — may be derived from fish or meat"},
  e627:{s:"d",r:"disodium guanylate — may be derived from fish or meat"},
  e628:{s:"d",r:"may be derived from fish or meat"},
  e629:{s:"d",r:"may be derived from fish or meat"},
  e630:{s:"d",r:"inosinic acid — may be derived from meat or fish"},
  e631:{s:"d",r:"disodium inosinate — may be derived from meat or fish"},
  e632:{s:"d",r:"may be derived from meat or fish"},
  e633:{s:"d",r:"may be derived from meat or fish"},
  e634:{s:"d",r:"may be derived from meat or fish"},
  e635:{s:"d",r:"disodium ribonucleotides — may be derived from meat or fish"},
  e640:{s:"d",r:"glycine — may be derived from gelatin"},
  // Glazing agents & misc E900s
  e900:{s:"h",r:""}, e901:{s:"h",r:""}, e902:{s:"h",r:""},
  e903:{s:"h",r:""},
  e904:{s:"d",r:"shellac — insect secretion; permissibility differs between authorities"},
  e905:{s:"h",r:""}, e912:{s:"h",r:""}, e914:{s:"h",r:""},
  e920:{s:"d",r:"L-cysteine — may be derived from human hair or animal feathers"},
  e921:{s:"d",r:"L-cystine — may be derived from hair or feathers"},
  e927b:{s:"h",r:""}, e938:{s:"h",r:""}, e939:{s:"h",r:""},
  e941:{s:"h",r:""}, e942:{s:"h",r:""}, e948:{s:"h",r:""},
  e950:{s:"h",r:""}, e951:{s:"h",r:""}, e952:{s:"h",r:""}, e953:{s:"h",r:""},
  e954:{s:"h",r:""}, e955:{s:"h",r:""}, e957:{s:"h",r:""},
  e960:{s:"h",r:""}, e961:{s:"h",r:""}, e962:{s:"h",r:""},
  e965:{s:"h",r:""}, e966:{s:"h",r:""}, e967:{s:"h",r:""}, e968:{s:"h",r:""},
  e999:{s:"d",r:"quillaia extract — may be processed with alcohol"},
  e1100:{s:"d",r:"amylase enzyme — source may be animal, plant, or microbial"},
  e1105:{s:"d",r:"lysozyme — usually from egg white, verify source"},
  e1400:{s:"h",r:""}, e1404:{s:"h",r:""}, e1410:{s:"h",r:""}, e1412:{s:"h",r:""},
  e1414:{s:"h",r:""}, e1420:{s:"h",r:""}, e1422:{s:"h",r:""}, e1440:{s:"h",r:""},
  e1442:{s:"h",r:""}, e1450:{s:"h",r:""}, e1451:{s:"h",r:""},
  e1505:{s:"h",r:""}, e1518:{s:"d",r:"triacetin — glycerol source may be animal"},
  e1520:{s:"h",r:""}
};
// Normalize a token like "E-471", "INS 471", "e471i" to a VERIFIED key.
function verifiedKey(name){
  const m = String(name).toLowerCase().replace(/\s+/g,"").match(/^(?:e|ins)[\s\-]?(\d{3,4}[a-e]?)/);
  return m ? ("e"+m[1]) : null;
}

/* Reject OCR noise / label boilerplate that Claude sometimes returns as a fake
   "ingredient" (e.g. "ml © allrights reserved", "oe see", "s = 4").
   Returns true when the name is NOT a plausible ingredient and must be dropped. */
function looksLikeGarbage(name){
  const n = String(name || "").trim().toLowerCase();
  if (!n) return true;
  if (verifiedKey(n)) return false;                 // valid E-number, always keep
  if (n.length < 3 || n.length > 60) return true;   // too short / absurdly long
  const letters = (n.match(/[a-zÀ-ɏ؀-ۿ一-鿿]/gi) || []).length;
  if (letters < 3) return true;                      // must have real letters, not "s = 4"
  if (letters / n.length < 0.5) return true;         // mostly symbols/digits
  if (/[©®™=@|{}\[\]<>*#~^\\]/.test(n)) return true;  // legal / math / junk symbols
  if (/https?:|www\.|\.com/.test(n)) return true;    // URLs
  // Label boilerplate / non-ingredient phrases.
  if (/\b(all\s*rights?|reserved|copyright|batch|best before|expiry|expir|manufactured|packed|mfg|net\s*(wt|weight)|store in|keep in|cool and dry|barcode|see below|see back|see side|nutrition|ingredients?\s*:?\s*$)\b/.test(n)) return true;
  if (!/[aeiouy]/.test(n)) return true;              // no vowel at all = OCR gibble ("oe see" keeps, "bcdf" drops)
  return false;
}

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
      if (looksLikeGarbage(it.name)) continue;   // never persist OCR noise / boilerplate
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
         WHERE ingredients.source IS DISTINCT FROM 'admin'
           AND NOT (ingredients.status = 'x' AND EXCLUDED.status IN ('d','h'))
           AND NOT (ingredients.status = 'd' AND EXCLUDED.status = 'h')`,
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

/* ---------- API: admin one-time cleanup — purge stored OCR noise / boilerplate ---------- */
app.post("/api/ingredients/cleanup", async (req, res) => {
  const { password, apply } = req.body || {};
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: "admin_disabled" });
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: "unauthorized" });
  try {
    // Never touch admin-locked rows. Scan the rest through the same garbage gate.
    const { rows } = await pool.query("SELECT name FROM ingredients WHERE source IS DISTINCT FROM 'admin'");
    const junk = rows.map(r => r.name).filter(looksLikeGarbage);
    if (!apply) return res.json({ ok: true, preview: true, count: junk.length, names: junk.slice(0, 200) });
    let deleted = 0;
    if (junk.length) {
      const r = await pool.query("DELETE FROM ingredients WHERE name = ANY($1) AND source IS DISTINCT FROM 'admin'", [junk]);
      deleted = r.rowCount;
    }
    res.json({ ok: true, preview: false, deleted });
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

6. IGNORE non-ingredient text: storage instructions ("store in a cool and dry place"), origin ("product of Pakistan"), company names, addresses, allergen "contains" lines, nutrition facts, legal text ("all rights reserved", "©"), barcodes/batch/expiry codes, and OCR gibberish or fragments that are not a real ingredient (e.g. "oe see", "s = 4", "ml"). If a token is not a recognizable ingredient, leave it out entirely.

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
        }))
        .filter(x => !looksLikeGarbage(x.name));

      // Authority override: verified E-number rulings always beat the AI.
      results = results.map(it => {
        const k = verifiedKey(it.name) || (VERIFIED[it.name] ? it.name : null);
        if (k && VERIFIED[k]) {
          const v = VERIFIED[k];
          return { ...it, status: v.s, reason: v.r || it.reason };
        }
        return it;
      });

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
           WHERE ingredients.source IS DISTINCT FROM 'admin'
             AND NOT (ingredients.status = 'x' AND EXCLUDED.status IN ('d','h'))
             AND NOT (ingredients.status = 'd' AND EXCLUDED.status = 'h')`,
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
