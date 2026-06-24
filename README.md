# Halal Scanner

Scan a product's ingredient label with your phone camera, read it with OCR, and
check each ingredient against Islamic dietary law (halal / haram / doubtful).
Unknown ingredients are assessed by Claude and saved to a permanent database.

## How it works

- **Frontend** (`public/index.html`) — camera capture, OCR (Tesseract.js), verdict UI.
- **Backend** (`server.js`) — Express server. Holds the Claude API key as a
  hidden environment variable, talks to Claude, and reads/writes the ingredient
  library in your Neon Postgres database. The browser never sees the key.

Statuses: `h` = halal, `x` = haram, `d` = doubtful (source-dependent).

---

## Deploy to Render (with GitHub + Neon)

### 1. Put this folder on GitHub
```
cd halal-scanner
git init
git add .
git commit -m "Halal Scanner"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/halal-scanner.git
git push -u origin main
```
(`.gitignore` already keeps `node_modules` and secrets out of the repo.)

### 2. Create the Render service
1. Go to render.com → **New** → **Web Service**.
2. Connect your GitHub repo (`halal-scanner`).
3. Settings:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`

### 3. Add environment variables (Render → your service → Environment)
| Key | Value |
|-----|-------|
| `ANTHROPIC_API_KEY` | your Claude API key (starts with `sk-ant-`) |
| `DATABASE_URL` | your Neon connection string (the **pooled** one, with `?sslmode=require`) |

> The key lives only here, on the server. It is never in the code or the browser.

### 4. Deploy
Click **Create Web Service**. On first boot the server creates the
`ingredients` table and seeds it automatically. Open the Render URL on your
phone — done.

---

## Run locally (optional test before deploy)
```
npm install
ANTHROPIC_API_KEY=sk-ant-... DATABASE_URL=postgres://... npm start
```
Open http://localhost:3000

> Camera needs HTTPS (or localhost). On Render you get HTTPS automatically.

---

## Important notes
- This is an **ingredient screening tool, not a fatwa**. Doubtful (mashbooh)
  items depend on their source — use the "Ask company" tab to verify with the
  manufacturer. Full assurance comes only from recognized halal certification.
- The ingredient seed list is a reasonable starting point, not exhaustive.
  Review entries in the Library tab and adjust `SEED` in `server.js` as needed.
