const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");
const RSSParser = require("rss-parser");
const cron = require("node-cron");

const app = express();
const parser = new RSSParser();

// Allow ALL origins — required for browser-based frontends
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.options("*", cors());
app.use(express.json());

// ── In-memory cache ───────────────────────────────────────────────
let cachedSignals = [];
let lastScanTime = null;
let scanLog = [];

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-opus-4-5-20251001";

// ── Helpers ───────────────────────────────────────────────────────
function todayStr() { return new Date().toISOString().split("T")[0]; }
function daysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString().split("T")[0]; }
async function safeFetch(fn, label) {
  try {
    const result = await fn();
    console.log(`✓ ${label}: ${Array.isArray(result) ? result.length : 1} items`);
    return result;
  } catch (e) {
    console.warn(`✗ ${label} failed: ${e.message}`);
    return [];
  }
}

// ── Data Fetchers ─────────────────────────────────────────────────
async function fetchSEC13D() {
  const url = `https://efts.sec.gov/LATEST/search-index?q=%22acquired%22+%22beneficial+ownership%22&forms=SC+13D,SC+13G&dateRange=custom&startdt=${daysAgo(3)}&enddt=${todayStr()}&hits.hits.total.value=true`;
  const r = await axios.get(url, { timeout: 10000, headers: { "User-Agent": "CatalystScanner research@example.com" } });
  return (r.data.hits?.hits || []).slice(0, 10).map(h => ({
    type: "sec13d",
    company: h._source?.display_names?.[0] || h._source?.entity_name || "Unknown",
    formType: h._source?.form_type,
    date: h._source?.file_date,
  }));
}

async function fetchSEC8K() {
  const terms = encodeURIComponent('"strategic alternatives" OR "merger agreement" OR "acquisition" OR "going private"');
  const url = `https://efts.sec.gov/LATEST/search-index?q=${terms}&forms=8-K&dateRange=custom&startdt=${daysAgo(2)}&enddt=${todayStr()}&hits.hits.total.value=true`;
  const r = await axios.get(url, { timeout: 10000, headers: { "User-Agent": "CatalystScanner research@example.com" } });
  return (r.data.hits?.hits || []).slice(0, 10).map(h => ({
    type: "sec8k",
    company: h._source?.display_names?.[0] || h._source?.entity_name || "Unknown",
    formType: "8-K",
    date: h._source?.file_date,
    description: h._source?.file_description || "",
  }));
}

async function fetchFDA() {
  const url = `https://api.fda.gov/drug/drugsfda.json?search=submissions.submission_status_date:[${daysAgo(90).replace(/-/g,"")}+TO+${todayStr().replace(/-/g,"")}]+AND+submissions.submission_type:ORIG&limit=10`;
  const r = await axios.get(url, { timeout: 10000 });
  return (r.data.results || []).slice(0, 8).map(item => ({
    type: "fda",
    brandName: item.openfda?.brand_name?.[0] || item.brand_name || "Unknown",
    genericName: item.openfda?.generic_name?.[0] || "",
    sponsor: item.sponsor_name || "Unknown",
    applicationNo: item.application_number || "",
    submissions: (item.submissions || []).slice(0, 3).map(s => ({
      type: s.submission_type,
      status: s.submission_status,
      date: s.submission_status_date,
      reviewPriority: s.review_priority,
    })),
  }));
}

async function fetchClinicalTrials() {
  const url = "https://clinicaltrials.gov/api/v2/studies?filter.advanced=AREA[Phase]PHASE3+AND+AREA[OverallStatus]COMPLETED&sort=LastUpdatePostDate:desc&pageSize=8&fields=NCTId,BriefTitle,Condition,LeadSponsorName,CompletionDate,EnrollmentCount";
  const r = await axios.get(url, { timeout: 10000 });
  return (r.data.studies || []).slice(0, 6).map(s => {
    const p = s.protocolSection || {};
    return {
      type: "clinical",
      nctId: p.identificationModule?.nctId || "",
      title: p.identificationModule?.briefTitle || "",
      sponsor: p.sponsorCollaboratorsModule?.leadSponsor?.name || "",
      condition: p.conditionsModule?.conditions?.[0] || "",
      completionDate: p.statusModule?.completionDateStruct?.date || "",
    };
  });
}

async function fetchBiotechNews() {
  const queries = [
    "biotech acquisition merger 2026",
    "FDA approval drug 2026",
    "pharmaceutical buyout deal",
    "biotech PDUFA approval",
  ];
  const results = [];
  for (const q of queries) {
    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
      const feed = await parser.parseURL(url);
      feed.items.slice(0, 3).forEach(item => {
        results.push({
          type: "news",
          title: item.title || "",
          date: item.pubDate || "",
          snippet: item.contentSnippet?.slice(0, 200) || "",
        });
      });
    } catch {}
  }
  return results.slice(0, 12);
}

async function getStockPrice(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
    const r = await axios.get(url, {
      timeout: 8000,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; CatalystScanner/1.0)" }
    });
    const meta = r.data?.chart?.result?.[0]?.meta;
    return { ticker, price: meta?.regularMarketPrice || null };
  } catch {
    return { ticker, price: null };
  }
}

// ── Claude Analysis ───────────────────────────────────────────────
async function analyzeWithClaude(data) {
  const { sec13d, sec8k, fda, clinical, news } = data;
  const totalItems = sec13d.length + sec8k.length + fda.length + clinical.length + news.length;
  if (totalItems === 0) throw new Error("No data fetched from any source.");

  const prompt = `You are an elite biotech and pharmaceutical stock catalyst analyst. Identify the TOP 5 highest-probability pre-move trading opportunities from the real live data below.

Today: ${todayStr()}

GOAL: Find stocks where someone can buy BEFORE a major catalyst causes a 30-200% move in the next 1-14 days, then exit on the day of the move.

ONLY include UPCOMING catalysts — skip anything that already happened.

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
    "headline": "One punchy sentence describing the catalyst",
    "summary": "4-5 sentences: what the catalyst is, why it will move the stock, historical base rate, what the market is missing, what to watch for",
    "confidence": 74,
    "direction": "up",
    "daysUntilCatalyst": 7,
    "catalystDate": "2026-06-02",
    "entryNote": "When and how to enter optimally",
    "riskNote": "Main risk that could invalidate this trade",
    "estimatedMove": 45,
    "sources": ["sec13d", "news"]
  }
]`;

  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    { model: MODEL, max_tokens: 3000, messages: [{ role: "user", content: prompt }] },
    {
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      timeout: 60000,
    }
  );

  const text = response.data.content?.[0]?.text || "[]";
  const clean = text.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(clean);

  return await Promise.all(parsed.map(async (signal) => {
    const priceData = await getStockPrice(signal.ticker);
    return { ...signal, currentPrice: priceData.price, priceChecked: todayStr() };
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
  console.log(`📦 Raw data points: ${totalRaw}`);
  if (totalRaw === 0) { console.error("❌ No data — skipping"); return; }

  const signals = await analyzeWithClaude({ sec13d, sec8k, fda, clinical, news });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  cachedSignals = signals.map((s, i) => ({
    ...s,
    id: `${todayStr()}-${Date.now()}-${i}`,
    scanDate: todayStr(),
    scanTime: new Date().toISOString(),
    outcome: "pending",
  }));

  lastScanTime = new Date().toISOString();
  scanLog.unshift({
    date: lastScanTime,
    elapsed: `${elapsed}s`,
    signals: cachedSignals.length,
    tickers: cachedSignals.map(s => s.ticker).join(", "),
    sources: { sec13d: sec13d.length, sec8k: sec8k.length, fda: fda.length, clinical: clinical.length, news: news.length },
  });
  scanLog = scanLog.slice(0, 30);
  console.log(`✅ Done in ${elapsed}s — ${signals.length} signals: ${cachedSignals.map(s => s.ticker).join(", ")}`);
}

// ── Grade Outcome ─────────────────────────────────────────────────
async function gradeSignal(signal) {
  const prompt = `Grade this past trade prediction.
Made on: ${signal.scanDate} | Stock: ${signal.ticker} (${signal.company})
Direction: ${signal.direction} | Catalyst: ${signal.headline} | Expected: ${signal.catalystDate}
Entry price: $${signal.currentPrice || "unknown"} | Today: ${todayStr()}

Return ONLY JSON:
{"outcome":"win|loss|pending","actualMove":23.5,"catalystConfirmed":true,"note":"Brief factual explanation"}`;

  const r = await axios.post(
    "https://api.anthropic.com/v1/messages",
    { model: MODEL, max_tokens: 300, messages: [{ role: "user", content: prompt }] },
    { headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }, timeout: 30000 }
  );
  const text = r.data.content?.[0]?.text || "{}";
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

// ── Routes ────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "running", lastScan: lastScanTime, signalCount: cachedSignals.length }));
app.get("/signals", (req, res) => res.json({ signals: cachedSignals, lastScan: lastScanTime, scanLog: scanLog.slice(0, 5) }));
app.post("/scan", async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(400).json({ error: "ANTHROPIC_API_KEY not set" });
  try { await runScan(); res.json({ success: true, signals: cachedSignals, lastScan: lastScanTime }); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});
app.post("/grade/:id", async (req, res) => {
  const signal = cachedSignals.find(s => s.id === req.params.id);
  if (!signal) return res.status(404).json({ error: "Signal not found" });
  try { res.json(await gradeSignal(signal)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/log", (req, res) => res.json({ scanLog }));

// ── Scheduled Scans EST ───────────────────────────────────────────
cron.schedule("0 11 * * 1-5", () => { if (ANTHROPIC_API_KEY) runScan(); });   // 6am EST
cron.schedule("30 21 * * 1-5", () => { if (ANTHROPIC_API_KEY) runScan(); });  // 4:30pm EST
cron.schedule("0 1 * * 2-6", () => { if (ANTHROPIC_API_KEY) runScan(); });    // 8pm EST

// ── Start ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Catalyst Backend on port ${PORT}`);
  console.log(`🔑 API Key: ${ANTHROPIC_API_KEY ? "✓ Set" : "✗ MISSING"}`);
  if (ANTHROPIC_API_KEY) { console.log("⚡ Running initial scan..."); runScan().catch(console.error); }
});
