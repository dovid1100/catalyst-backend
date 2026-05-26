const express = require("express");
const cors = require("cors");
const axios = require("axios");
const RSSParser = require("rss-parser");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");

const app = express();
const parser = new RSSParser();

app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.options("*", cors());
app.use(express.json());

// ── Persistent storage ────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, "data.json");

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {}
  return { currentSignals: [], history: [], scanLog: [], lastScan: null };
}

function saveData(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error("Save error:", e.message); }
}

let db = loadData();
if (!db.currentSignals) db.currentSignals = [];
if (!db.history) db.history = [];
if (!db.scanLog) db.scanLog = [];
console.log(`📂 Loaded — current: ${db.currentSignals.length} signals, history: ${db.history.length} scans`);

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-opus-4-5-20251101";

// ── Helpers ───────────────────────────────────────────────────────
function todayStr() { return new Date().toISOString().split("T")[0]; }
function daysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString().split("T")[0]; }

// US Market Holidays 2026
const HOLIDAYS = new Set([
  "2026-01-01","2026-01-19","2026-02-16","2026-04-03","2026-05-25",
  "2026-07-03","2026-09-07","2026-11-26","2026-12-25",
  "2027-01-01","2027-01-18","2027-02-15","2027-04-02","2027-05-31"
]);

function addTradingDays(fromDate, days) {
  let date = new Date(fromDate);
  let added = 0;
  while (added < days) {
    date.setDate(date.getDate() + 1);
    const dow = date.getDay();
    const ds = date.toISOString().split("T")[0];
    if (dow !== 0 && dow !== 6 && !HOLIDAYS.has(ds)) added++;
  }
  return date.toISOString().split("T")[0];
}

function tradingDaysUntil(targetDate) {
  const today = new Date(todayStr());
  const target = new Date(targetDate);
  if (target <= today) return 0;
  let count = 0;
  let d = new Date(today);
  while (d < target) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    const ds = d.toISOString().split("T")[0];
    if (dow !== 0 && dow !== 6 && !HOLIDAYS.has(ds)) count++;
  }
  return count;
}

async function safeFetch(fn, label) {
  try { const r = await fn(); console.log(`✓ ${label}: ${r.length}`); return r; }
  catch (e) { console.warn(`✗ ${label}: ${e.message}`); return []; }
}

// ── Data Fetchers ─────────────────────────────────────────────────
async function fetchSEC13D() {
  const url = `https://efts.sec.gov/LATEST/search-index?q=%22acquired%22+%22beneficial+ownership%22&forms=SC+13D,SC+13G&dateRange=custom&startdt=${daysAgo(3)}&enddt=${todayStr()}&hits.hits.total.value=true`;
  const r = await axios.get(url, { timeout: 10000, headers: { "User-Agent": "CatalystScanner research@example.com" } });
  return (r.data.hits?.hits || []).slice(0, 10).map(h => ({
    type: "sec13d", company: h._source?.display_names?.[0] || "Unknown",
    formType: h._source?.form_type, date: h._source?.file_date,
  }));
}

async function fetchSEC8K() {
  const terms = encodeURIComponent('"strategic alternatives" OR "merger agreement" OR "acquisition" OR "going private"');
  const url = `https://efts.sec.gov/LATEST/search-index?q=${terms}&forms=8-K&dateRange=custom&startdt=${daysAgo(2)}&enddt=${todayStr()}&hits.hits.total.value=true`;
  const r = await axios.get(url, { timeout: 10000, headers: { "User-Agent": "CatalystScanner research@example.com" } });
  return (r.data.hits?.hits || []).slice(0, 10).map(h => ({
    type: "sec8k", company: h._source?.display_names?.[0] || "Unknown",
    formType: "8-K", date: h._source?.file_date, description: h._source?.file_description || "",
  }));
}

async function fetchFDA() {
  const url = `https://api.fda.gov/drug/drugsfda.json?search=submissions.submission_status_date:[${daysAgo(90).replace(/-/g,"")}+TO+${todayStr().replace(/-/g,"")}]+AND+submissions.submission_type:ORIG&limit=10`;
  const r = await axios.get(url, { timeout: 10000 });
  return (r.data.results || []).slice(0, 8).map(item => ({
    type: "fda", brandName: item.openfda?.brand_name?.[0] || "Unknown",
    genericName: item.openfda?.generic_name?.[0] || "", sponsor: item.sponsor_name || "Unknown",
    applicationNo: item.application_number || "",
    submissions: (item.submissions || []).slice(0, 3).map(s => ({
      type: s.submission_type, status: s.submission_status,
      date: s.submission_status_date, reviewPriority: s.review_priority,
    })),
  }));
}

async function fetchClinicalTrials() {
  const url = "https://clinicaltrials.gov/api/v2/studies?filter.advanced=AREA[Phase]PHASE3+AND+AREA[OverallStatus]COMPLETED&sort=LastUpdatePostDate:desc&pageSize=8&fields=NCTId,BriefTitle,Condition,LeadSponsorName,CompletionDate";
  const r = await axios.get(url, { timeout: 10000 });
  return (r.data.studies || []).slice(0, 6).map(s => {
    const p = s.protocolSection || {};
    return {
      type: "clinical", nctId: p.identificationModule?.nctId || "",
      title: p.identificationModule?.briefTitle || "",
      sponsor: p.sponsorCollaboratorsModule?.leadSponsor?.name || "",
      condition: p.conditionsModule?.conditions?.[0] || "",
    };
  });
}

async function fetchBiotechNews() {
  const queries = ["biotech acquisition merger 2026", "FDA approval drug 2026", "pharmaceutical buyout deal", "biotech PDUFA approval"];
  const results = [];
  for (const q of queries) {
    try {
      const feed = await parser.parseURL(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`);
      feed.items.slice(0, 3).forEach(item => results.push({
        type: "news", title: item.title || "", date: item.pubDate || "",
        snippet: item.contentSnippet?.slice(0, 200) || "",
      }));
    } catch {}
  }
  return results.slice(0, 12);
}

async function getStockPrice(ticker) {
  try {
    const r = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`, {
      timeout: 8000, headers: { "User-Agent": "Mozilla/5.0" }
    });
    const meta = r.data?.chart?.result?.[0]?.meta;
    return { ticker, price: meta?.regularMarketPrice || null };
  } catch { return { ticker, price: null }; }
}

// ── Claude Analysis ───────────────────────────────────────────────
async function analyzeWithClaude(data) {
  const { sec13d, sec8k, fda, clinical, news } = data;
  const totalItems = sec13d.length + sec8k.length + fda.length + clinical.length + news.length;
  if (totalItems === 0) throw new Error("No data fetched from any source.");

  const prompt = `You are an elite biotech and pharmaceutical stock catalyst analyst. Identify UP TO 10 highest-probability pre-move trading opportunities from the real live data below.

Today: ${todayStr()}
GOAL: Find stocks where someone can buy BEFORE a major catalyst causes a 30-200% move. The trader will exit on the day of the move.
ONLY include UPCOMING catalysts — strictly skip anything that already happened.

URGENCY RULES (use TRADING DAYS only, skip weekends and holidays):
- "urgent" = catalyst within 1-7 trading days
- "upcoming" = catalyst 8-14 trading days away  
- "watching" = catalyst 15+ trading days away

SEC 13D/13G FILINGS (large stake purchases — precede buyouts):
${JSON.stringify(sec13d, null, 2)}

SEC 8-K FILINGS (strategic announcements):
${JSON.stringify(sec8k, null, 2)}

FDA DRUG APPLICATIONS:
${JSON.stringify(fda, null, 2)}

COMPLETED PHASE 3 TRIALS:
${JSON.stringify(clinical, null, 2)}

BIOTECH/PHARMA NEWS (last 24 hours):
${JSON.stringify(news, null, 2)}

Return ONLY a valid JSON array, no markdown, no explanation:
[
  {
    "ticker": "REAL TICKER",
    "company": "Full Company Name",
    "signalType": "sec13d|sec8k|fda|clinical|news",
    "urgency": "urgent|upcoming|watching",
    "headline": "One punchy sentence describing the catalyst",
    "summary": "4-5 sentences: what the catalyst is, why it will move the stock, historical base rate, what the market is missing, what to watch for",
    "confidence": 74,
    "direction": "up",
    "tradingDaysUntilCatalyst": 7,
    "catalystDate": "2026-06-02",
    "entryNote": "When and how to enter optimally — trading days only",
    "riskNote": "Main risk that could invalidate this trade",
    "estimatedMove": 45,
    "sources": ["sec13d", "news"]
  }
]`;

  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    { model: MODEL, max_tokens: 4000, messages: [{ role: "user", content: prompt }] },
    { headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }, timeout: 60000 }
  );

  const text = response.data.content?.[0]?.text || "[]";
  const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());

  // Enrich with live prices and recalculate trading days server-side
  return await Promise.all(parsed.map(async (signal) => {
    const priceData = await getStockPrice(signal.ticker);
    const tradingDays = signal.catalystDate ? tradingDaysUntil(signal.catalystDate) : signal.tradingDaysUntilCatalyst;
    const urgency = tradingDays <= 7 ? "urgent" : tradingDays <= 14 ? "upcoming" : "watching";
    return {
      ...signal,
      tradingDaysUntilCatalyst: tradingDays,
      urgency,
      currentPrice: priceData.price,
      priceChecked: todayStr()
    };
  }));
}

// ── Main Scan ─────────────────────────────────────────────────────
async function runScan() {
  console.log(`\n🔍 Scan started at ${new Date().toISOString()}`);
  const start = Date.now();

  const [sec13d, sec8k, fda, clinical, news] = await Promise.all([
    safeFetch(fetchSEC13D, "SEC 13D/13G"),
    safeFetch(fetchSEC8K, "SEC 8-K"),
    safeFetch(fetchFDA, "FDA"),
    safeFetch(fetchClinicalTrials, "ClinicalTrials"),
    safeFetch(fetchBiotechNews, "Google News"),
  ]);

  const totalRaw = sec13d.length + sec8k.length + fda.length + clinical.length + news.length;
  if (totalRaw === 0) { console.error("❌ No data"); return; }

  const signals = await analyzeWithClaude({ sec13d, sec8k, fda, clinical, news });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const scanTime = new Date().toISOString();
  const scanDate = todayStr();

  const newSignals = signals.map((s, i) => ({
    ...s,
    id: `${scanDate}-${Date.now()}-${i}`,
    scanDate,
    scanTime,
    outcome: "pending",
  }));

  // Current signals = only latest scan
  db.currentSignals = newSignals;

  // History = every scan ever, grouped
  db.history.unshift({
    scanDate,
    scanTime,
    elapsed: `${elapsed}s`,
    sources: { sec13d: sec13d.length, sec8k: sec8k.length, fda: fda.length, clinical: clinical.length, news: news.length },
    signals: newSignals,
  });
  // Keep last 365 scans in history (1 year)
  db.history = db.history.slice(0, 365);

  db.lastScan = scanTime;
  db.scanLog = [{
    date: scanTime, elapsed: `${elapsed}s`,
    signals: newSignals.length,
    tickers: newSignals.map(s => s.ticker).join(", "),
    sources: { sec13d: sec13d.length, sec8k: sec8k.length, fda: fda.length, clinical: clinical.length, news: news.length },
  }, ...(db.scanLog || [])].slice(0, 365);

  saveData(db);
  console.log(`✅ Done in ${elapsed}s — ${newSignals.length} signals saved`);
}

// ── Grade Outcome ─────────────────────────────────────────────────
async function gradeSignal(signal) {
  const prompt = `Grade this past trade prediction.
Made on: ${signal.scanDate} | Stock: ${signal.ticker} (${signal.company})
Direction: ${signal.direction} | Catalyst: ${signal.headline} | Expected: ${signal.catalystDate}
Entry price: $${signal.currentPrice || "unknown"} | Today: ${todayStr()}

Return ONLY JSON:
{"outcome":"win|loss|pending","actualMove":23.5,"catalystConfirmed":true,"note":"Brief factual explanation of what actually happened"}`;

  const r = await axios.post(
    "https://api.anthropic.com/v1/messages",
    { model: MODEL, max_tokens: 300, messages: [{ role: "user", content: prompt }] },
    { headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }, timeout: 30000 }
  );
  return JSON.parse(r.data.content?.[0]?.text.replace(/```json|```/g, "").trim() || "{}");
}

function updateSignalInDb(id, updates) {
  // Update in currentSignals
  const ci = db.currentSignals.findIndex(s => s.id === id);
  if (ci !== -1) db.currentSignals[ci] = { ...db.currentSignals[ci], ...updates };
  // Update in history
  for (const scan of db.history) {
    const hi = scan.signals.findIndex(s => s.id === id);
    if (hi !== -1) { scan.signals[hi] = { ...scan.signals[hi], ...updates }; break; }
  }
  saveData(db);
}

// ── Routes ────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "running", lastScan: db.lastScan, signalCount: db.currentSignals.length, historyCount: db.history.length }));

app.get("/signals", (req, res) => res.json({ signals: db.currentSignals, lastScan: db.lastScan, scanLog: db.scanLog }));

app.get("/history", (req, res) => res.json({ history: db.history }));

app.post("/scan", async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(400).json({ error: "ANTHROPIC_API_KEY not set" });
  try {
    await runScan();
    res.json({ success: true, signals: db.currentSignals, lastScan: db.lastScan, scanLog: db.scanLog });
  } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

app.post("/grade/:id", async (req, res) => {
  // Search in current and history
  let signal = db.currentSignals.find(s => s.id === req.params.id);
  if (!signal) {
    for (const scan of db.history) {
      signal = scan.signals.find(s => s.id === req.params.id);
      if (signal) break;
    }
  }
  if (!signal) return res.status(404).json({ error: "Signal not found" });
  try {
    const result = await gradeSignal(signal);
    updateSignalInDb(req.params.id, { outcome: result.outcome, actualMove: result.actualMove, outcomeNote: result.note });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/stats", (req, res) => {
  const allSignals = db.history.flatMap(s => s.signals);
  const graded = allSignals.filter(s => s.outcome === "win" || s.outcome === "loss");
  const wins = graded.filter(s => s.outcome === "win");
  const totalPnl = graded.reduce((a, s) => {
    const m = s.actualMove || s.estimatedMove || 0;
    return a + (s.outcome === "win" ? 1000 * m / 100 : -1000 * m / 100);
  }, 0);
  res.json({
    totalSignals: allSignals.length, totalScans: db.history.length,
    gradedTrades: graded.length, wins: wins.length,
    losses: graded.length - wins.length,
    winRate: graded.length ? Math.round(wins.length / graded.length * 100) : null,
    totalPnl: Math.round(totalPnl * 100) / 100,
    lastScan: db.lastScan,
  });
});

app.get("/log", (req, res) => res.json({ scanLog: db.scanLog }));

// ── Scheduled Scans EST ───────────────────────────────────────────
cron.schedule("0 11 * * 1-5", () => { if (ANTHROPIC_API_KEY) runScan(); });
cron.schedule("30 21 * * 1-5", () => { if (ANTHROPIC_API_KEY) runScan(); });
cron.schedule("0 1 * * 2-6", () => { if (ANTHROPIC_API_KEY) runScan(); });

// ── Start ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Catalyst Backend on port ${PORT}`);
  console.log(`💾 ${DATA_FILE}`);
  console.log(`🔑 API Key: ${ANTHROPIC_API_KEY ? "✓ Set" : "✗ MISSING"}`);
  if (ANTHROPIC_API_KEY) { console.log("⚡ Running initial scan..."); runScan().catch(console.error); }
});
