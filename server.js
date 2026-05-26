const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");
const RSSParser = require("rss-parser");
const cron = require("node-cron");

const app = express();
const parser = new RSSParser();

app.use(cors());
app.use(express.json());

// ── In-memory cache ───────────────────────────────────────────────
let cachedSignals = [];
let lastScanTime = null;
let scanLog = [];

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-opus-4-5-20251001";

// ── Helpers ───────────────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().split("T")[0];
}
function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().split("T")[0];
}
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

// 1. SEC EDGAR - 13D/13G filings (large stake acquisitions)
async function fetchSEC13D() {
  const url = `https://efts.sec.gov/LATEST/search-index?q=%22acquired%22+%22beneficial+ownership%22&forms=SC+13D,SC+13G&dateRange=custom&startdt=${daysAgo(3)}&enddt=${todayStr()}&hits.hits.total.value=true`;
  const r = await axios.get(url, { timeout: 10000, headers: { "User-Agent": "CatalystScanner research@example.com" } });
  return (r.data.hits?.hits || []).slice(0, 10).map(h => ({
    type: "sec13d",
    company: h._source?.display_names?.[0] || h._source?.entity_name || "Unknown",
    formType: h._source?.form_type,
    date: h._source?.file_date,
    accession: h._source?.file_num,
  }));
}

// 2. SEC EDGAR - 8-K filings with strategic language
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

// 3. OpenFDA - upcoming PDUFA dates and recent approvals
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

// 4. ClinicalTrials.gov - recently completed Phase 3 trials
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
      enrollment: p.designModule?.enrollmentInfo?.count || 0,
    };
  });
}

// 5. Google News RSS - biotech/pharma acquisition news
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
          link: item.link || "",
          date: item.pubDate || "",
          source: item.creator || "Google News",
          snippet: item.contentSnippet?.slice(0, 200) || "",
        });
      });
    } catch {}
  }
  return results.slice(0, 12);
}

// 6. Yahoo Finance - get current stock price for a ticker
async function getStockPrice(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
    const r = await axios.get(url, {
      timeout: 8000,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; CatalystScanner/1.0)" }
    });
    const meta = r.data?.chart?.result?.[0]?.meta;
    return {
      ticker,
      price: meta?.regularMarketPrice || null,
      prevClose: meta?.chartPreviousClose || null,
      currency: meta?.currency || "USD",
    };
  } catch {
    return { ticker, price: null };
  }
}

// 7. Finviz - small cap biotech screener
async function fetchFinvizBiotech() {
  const url = "https://finviz.com/screener.ashx?v=111&f=sec_healthcare,cap_small,ta_change_u10&o=-change&r=1";
  const r = await axios.get(url, {
    timeout: 10000,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept": "text/html",
    }
  });
  const $ = cheerio.load(r.data);
  const stocks = [];
  $("table.table-light tr").each((i, row) => {
    if (i === 0) return;
    const cells = $(row).find("td");
    if (cells.length > 8) {
      stocks.push({
        ticker: $(cells[1]).text().trim(),
        company: $(cells[2]).text().trim(),
        sector: $(cells[3]).text().trim(),
        change: $(cells[8]).text().trim(),
        volume: $(cells[10]).text().trim(),
      });
    }
  });
  return stocks.slice(0, 8);
}

// ── Claude Analysis ───────────────────────────────────────────────
async function analyzeWithClaude(data) {
  const { sec13d, sec8k, fda, clinical, news, finviz } = data;

  const totalItems = sec13d.length + sec8k.length + fda.length + clinical.length + news.length;
  if (totalItems === 0) {
    throw new Error("No data fetched from any source. Check server connectivity.");
  }

  const prompt = `You are an elite biotech and pharmaceutical stock catalyst analyst with 20 years of experience. Your job is to identify the TOP 5 highest-probability pre-move trading opportunities from the real data below.

Today's date: ${todayStr()}

GOAL: Find stocks where I can buy BEFORE a major catalyst causes a 30-200% move, and exit on the day of the move.

PRIORITY SIGNALS (ranked by reliability):
1. Acquisition targets — 13D/13G filings showing large stake purchases (precede buyouts)
2. 8-K "strategic alternatives" language (company is selling itself)  
3. FDA PDUFA approvals with Breakthrough/Priority designation
4. Phase 3 trial completions with strong data
5. News of imminent deals or FDA decisions

DATA:

SEC 13D/13G FILINGS (stake acquisitions - last 3 days):
${JSON.stringify(sec13d, null, 2)}

SEC 8-K FILINGS (strategic announcements - last 48 hours):
${JSON.stringify(sec8k, null, 2)}

FDA DRUG APPLICATIONS (recent submissions/approvals):
${JSON.stringify(fda, null, 2)}

COMPLETED PHASE 3 TRIALS:
${JSON.stringify(clinical, null, 2)}

BIOTECH/PHARMA NEWS (last 24 hours):
${JSON.stringify(news, null, 2)}

SMALL CAP BIOTECH MOVERS (unusual volume/price action):
${JSON.stringify(finviz, null, 2)}

Analyze all data carefully. Cross-reference signals — a stock appearing in multiple data sources gets higher confidence. Identify the real company tickers. Consider:
- Is this catalyst UPCOMING (good) or already happened (skip it)?
- What is the historical base rate for this type of catalyst?
- How many days does the trader have to get in before the move?

Return ONLY a valid JSON array with exactly 5 objects, no markdown, no explanation:
[
  {
    "ticker": "REAL STOCK TICKER",
    "company": "Full Company Name",
    "signalType": "sec13d|sec8k|fda|clinical|news",
    "headline": "One punchy sentence describing the catalyst",
    "summary": "4-5 sentences: what the catalyst is, why it will move the stock, historical base rate for similar setups, what the market is missing, what to watch for",
    "confidence": 74,
    "direction": "up",
    "daysUntilCatalyst": 7,
    "catalystDate": "2026-06-02",
    "entryNote": "One sentence: when and how to enter optimally",
    "riskNote": "One sentence: the main risk that could invalidate this trade",
    "estimatedMove": 45,
    "sources": ["sec13d", "news"]
  }
]

Rules:
- confidence: integer 0-100
- direction: "up" or "down" only  
- estimatedMove: positive integer (% move expected)
- daysUntilCatalyst: integer days from today
- Only include UPCOMING catalysts, not past events
- If a catalyst already happened, skip it
- sources: array of which data sources flagged this stock`;

  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: MODEL,
      max_tokens: 3000,
      messages: [{ role: "user", content: prompt }],
    },
    {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      timeout: 60000,
    }
  );

  const text = response.data.content?.[0]?.text || "[]";
  const clean = text.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(clean);

  // Enrich with live stock prices
  const enriched = await Promise.all(
    parsed.map(async (signal) => {
      const priceData = await getStockPrice(signal.ticker);
      return { ...signal, currentPrice: priceData.price, priceChecked: todayStr() };
    })
  );

  return enriched;
}

// ── Main Scan Function ────────────────────────────────────────────
async function runScan() {
  console.log(`\n🔍 Starting scan at ${new Date().toISOString()}`);
  const startTime = Date.now();

  const [sec13d, sec8k, fda, clinical, news, finviz] = await Promise.all([
    safeFetch(fetchSEC13D, "SEC 13D/13G"),
    safeFetch(fetchSEC8K, "SEC 8-K"),
    safeFetch(fetchFDA, "FDA"),
    safeFetch(fetchClinicalTrials, "ClinicalTrials"),
    safeFetch(fetchBiotechNews, "Google News"),
    safeFetch(fetchFinvizBiotech, "Finviz"),
  ]);

  const totalRaw = sec13d.length + sec8k.length + fda.length + clinical.length + news.length + finviz.length;
  console.log(`📦 Total raw data points: ${totalRaw}`);

  if (totalRaw === 0) {
    console.error("❌ No data from any source — skipping Claude analysis");
    return;
  }

  const signals = await analyzeWithClaude({ sec13d, sec8k, fda, clinical, news, finviz });

  cachedSignals = signals.map((s, i) => ({
    ...s,
    id: `${todayStr()}-${Date.now()}-${i}`,
    scanDate: todayStr(),
    scanTime: new Date().toISOString(),
    outcome: "pending",
  }));

  lastScanTime = new Date().toISOString();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  scanLog.unshift({
    date: lastScanTime,
    elapsed: `${elapsed}s`,
    signals: cachedSignals.length,
    tickers: cachedSignals.map(s => s.ticker).join(", "),
    sources: { sec13d: sec13d.length, sec8k: sec8k.length, fda: fda.length, clinical: clinical.length, news: news.length, finviz: finviz.length },
  });
  scanLog = scanLog.slice(0, 30);

  console.log(`✅ Scan complete in ${elapsed}s — ${signals.length} signals: ${cachedSignals.map(s => s.ticker).join(", ")}`);
}

// ── Grade Outcome ─────────────────────────────────────────────────
async function gradeSignal(signal) {
  const prompt = `You are a financial analyst grading a past trade prediction.

Prediction made on: ${signal.scanDate}
Stock: ${signal.ticker} (${signal.company})
Predicted direction: ${signal.direction}
Catalyst: ${signal.headline}
Expected catalyst date: ${signal.catalystDate}
Entry price at time of signal: $${signal.currentPrice || "unknown"}
Today's date: ${todayStr()}

Based on your knowledge of this stock's actual performance around ${signal.catalystDate}, determine the outcome.

Return ONLY this JSON object:
{
  "outcome": "win|loss|pending",
  "actualMove": 23.5,
  "exitPrice": 45.20,
  "catalystConfirmed": true,
  "note": "Brief factual explanation of what actually happened"
}

If the catalyst date hasn't passed yet, return outcome: "pending".
actualMove is the % move (positive number regardless of direction).`;

  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: MODEL,
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    },
    {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      timeout: 30000,
    }
  );

  const text = response.data.content?.[0]?.text || "{}";
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

// ── Routes ────────────────────────────────────────────────────────

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "running",
    lastScan: lastScanTime,
    signalCount: cachedSignals.length,
    nextScans: "06:00, 16:30, 20:00 EST",
  });
});

// Get latest signals
app.get("/signals", (req, res) => {
  res.json({
    signals: cachedSignals,
    lastScan: lastScanTime,
    scanLog: scanLog.slice(0, 5),
  });
});

// Trigger manual scan
app.post("/scan", async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(400).json({ error: "ANTHROPIC_API_KEY not set on server" });
  }
  try {
    await runScan();
    res.json({ success: true, signals: cachedSignals, lastScan: lastScanTime });
  } catch (e) {
    console.error("Scan error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Grade a signal outcome
app.post("/grade/:id", async (req, res) => {
  const signal = cachedSignals.find(s => s.id === req.params.id);
  if (!signal) return res.status(404).json({ error: "Signal not found" });
  try {
    const result = await gradeSignal(signal);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get scan log
app.get("/log", (req, res) => {
  res.json({ scanLog });
});

// Get stock price
app.get("/price/:ticker", async (req, res) => {
  const data = await getStockPrice(req.params.ticker.toUpperCase());
  res.json(data);
});

// ── Scheduled Scans (EST) ─────────────────────────────────────────
// 6:00 AM EST = 11:00 UTC
cron.schedule("0 11 * * 1-5", () => { if (ANTHROPIC_API_KEY) runScan(); }, { timezone: "UTC" });
// 4:30 PM EST = 21:30 UTC
cron.schedule("30 21 * * 1-5", () => { if (ANTHROPIC_API_KEY) runScan(); }, { timezone: "UTC" });
// 8:00 PM EST = 01:00 UTC next day
cron.schedule("0 1 * * 2-6", () => { if (ANTHROPIC_API_KEY) runScan(); }, { timezone: "UTC" });

// ── Start ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 Catalyst Scanner Backend running on port ${PORT}`);
  console.log(`📅 Auto-scans: 6:00 AM, 4:30 PM, 8:00 PM EST (weekdays)`);
  console.log(`🔑 API Key: ${ANTHROPIC_API_KEY ? "✓ Set" : "✗ NOT SET — add ANTHROPIC_API_KEY env var"}`);
  if (ANTHROPIC_API_KEY) {
    console.log("\n⚡ Running initial scan...");
    runScan().catch(console.error);
  }
});
