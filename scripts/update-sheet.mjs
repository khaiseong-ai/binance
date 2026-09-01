const comparisonUrl = "https://backpack.exchange/api/funding-comparison";
const openInterestUrl = "https://api.backpack.exchange/api/v1/openInterest";
const backpackFundingHistoryUrl = "https://api.backpack.exchange/api/v1/fundingRates";
const webAppUrl = process.env.SHEET_WEB_APP_URL;
const webAppSecret = process.env.SHEET_WEB_APP_SECRET;

const minAbsDiff = 0.0005; // 0.05% in decimal.
const minOpenInterestUsd = 100000;
const historyLimit = 100;
const historyConcurrency = 5;
const hourMs = 60 * 60 * 1000;

function parseNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "Mozilla/5.0 funding-report",
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${url} returned ${response.status}: ${text.slice(0, 300)}`);
  }
  return response.json();
}

let binanceHistoryCachePromise;

async function loadBinanceHistoryCache() {
  if (!binanceHistoryCachePromise) {
    binanceHistoryCachePromise = import("node:fs/promises")
      .then(({ readFile }) => readFile(new URL("../data/funding-history.json", import.meta.url), "utf8"))
      .then(JSON.parse)
      .then((cache) => {
      const generatedAt = Date.parse(cache.generatedAt);
      if (!Number.isFinite(generatedAt) || Date.now() - generatedAt > 6 * hourMs) {
        throw new Error(`Binance history cache is stale: ${cache.generatedAt || "missing timestamp"}`);
      }
      if (!cache.records || typeof cache.records !== "object") {
        throw new Error("Binance history cache has no records map");
      }
      return cache;
    });
  }
  return binanceHistoryCachePromise;
}

async function fetchBinanceHistory(symbol) {
  const cache = await loadBinanceHistoryCache();
  const records = cache.records[symbol];
  if (!Array.isArray(records)) throw new Error(`Binance history cache is missing ${symbol}`);
  return records;
}

async function mapLimit(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  const normalized =
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
      ? `${value}Z`
      : value;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeBackpackHistory(records) {
  return records
    .map((record) => ({
      timestamp: parseTimestamp(record.intervalEndTimestamp),
      rate: parseNumber(record.fundingRate),
    }))
    .filter((record) => record.timestamp !== undefined && record.rate !== undefined)
    .sort((a, b) => a.timestamp - b.timestamp);
}

function normalizeBinanceHistory(records) {
  return records
    .map((record) => ({
      timestamp: parseTimestamp(record.calcTime ?? record.fundingTime),
      rate: parseNumber(record.lastFundingRate ?? record.fundingRate),
    }))
    .filter((record) => record.timestamp !== undefined && record.rate !== undefined)
    .sort((a, b) => a.timestamp - b.timestamp);
}

function rollingSum(records, snapshotMs, hours) {
  const startMs = snapshotMs - hours * hourMs;
  return records.reduce(
    (sum, record) => sum + (record.timestamp > startMs && record.timestamp <= snapshotMs ? record.rate : 0),
    0,
  );
}

function hasWindowCoverage(records, snapshotMs, hours) {
  if (!records.length) return false;
  const startMs = snapshotMs - hours * hourMs;
  const first = records[0].timestamp;
  const latest = records[records.length - 1].timestamp;
  return first <= startMs + hourMs && latest >= snapshotMs - 12 * hourMs;
}

function pct(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return `${(value * 100).toFixed(4)}%`;
}

function usd(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

function compactSide(diff) {
  return diff >= 0 ? "UP" : "DOWN";
}

function winner(diff) {
  return diff >= 0 ? "Binance" : "Backpack";
}

function padRows(rows, minWidth = 1) {
  const width = Math.max(minWidth, ...rows.map((row) => row.length));
  return rows.map((row) => [...row, ...Array(width - row.length).fill("")]);
}

async function postSheet(rows) {
  const body = JSON.stringify({
      secret: webAppSecret,
      action: "writeSheet",
      sheetName: "Backpack_Binance",
      rows: padRows(rows, 11),
  });
  const response = await fetch(webAppUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 300)}`);
  const parsed = JSON.parse(text);
  if (!parsed.ok) throw new Error(`Apps Script rejected writeSheet: ${text.slice(0, 500)}`);
  return parsed;
}

async function enrichRows(comparison, openInterests, snapshotMs) {
  const oiBySymbol = new Map(openInterests.map((item) => [item.symbol, parseNumber(item.openInterest)]));
  const failures = [];

  const candidates = comparison
    .map((item) => {
      const backpack8h = parseNumber(item.backpackFundingRate);
      const binance8h = parseNumber(item.binanceFundingRate);
      const markPrice = parseNumber(item.backpackMarkPrice);
      const openInterest = oiBySymbol.get(item.backpackMarket);
      const openInterestUsd = openInterest !== undefined && markPrice !== undefined ? openInterest * markPrice : undefined;
      if (backpack8h === undefined || binance8h === undefined) return undefined;

      const diff8h = backpack8h - binance8h;
      return {
        symbol: item.symbol,
        backpackMarket: item.backpackMarket,
        binanceMarket: item.binanceMarket ?? "",
        openInterestUsd,
        backpack8h,
        binance8h,
        diff8h,
        binanceLastUpdated: item.binanceLastUpdated ? new Date(item.binanceLastUpdated).toISOString() : "",
      };
    })
    .filter((row) => row?.binanceMarket);

  const rows = await mapLimit(candidates, historyConcurrency, async (row) => {
    try {
      const [backpackRaw, binanceRaw] = await Promise.all([
        fetchJson(`${backpackFundingHistoryUrl}?symbol=${encodeURIComponent(row.backpackMarket)}&limit=${historyLimit}`),
        fetchBinanceHistory(row.binanceMarket),
      ]);
      const backpackHistory = normalizeBackpackHistory(backpackRaw);
      const binanceHistory = normalizeBinanceHistory(binanceRaw);
      if (!hasWindowCoverage(backpackHistory, snapshotMs, 72) || !hasWindowCoverage(binanceHistory, snapshotMs, 72)) {
        throw new Error(`insufficient 72h coverage (Backpack ${backpackHistory.length}, Binance ${binanceHistory.length})`);
      }

      const backpack1d = rollingSum(backpackHistory, snapshotMs, 24);
      const backpack2d = rollingSum(backpackHistory, snapshotMs, 48);
      const backpack3d = rollingSum(backpackHistory, snapshotMs, 72);
      const binance1d = rollingSum(binanceHistory, snapshotMs, 24);
      const binance2d = rollingSum(binanceHistory, snapshotMs, 48);
      const binance3d = rollingSum(binanceHistory, snapshotMs, 72);
      const diff1d = binance1d - backpack1d;
      const diff2d = binance2d - backpack2d;
      const diff3d = binance3d - backpack3d;

      return {
        ...row,
        backpack1d,
        backpack2d,
        backpack3d,
        binance1d,
        binance2d,
        binance3d,
        diff1d,
        diff2d,
        diff3d,
        maxAbsDiff: Math.max(Math.abs(diff1d), Math.abs(diff2d), Math.abs(diff3d)),
        backpackRecords: backpackHistory.length,
        binanceRecords: binanceHistory.length,
      };
    } catch (error) {
      const message = `[history] ${row.symbol}: ${error.message}`;
      failures.push(message);
      console.log(message);
      return undefined;
    }
  });

  return {
    candidateCount: candidates.length,
    failures,
    rows: rows.filter(Boolean),
  };
}

const snapshotMs = Date.now();
if (!webAppUrl || !webAppSecret) {
  throw new Error("SHEET_WEB_APP_URL and SHEET_WEB_APP_SECRET must be configured");
}
const [comparison, openInterests] = await Promise.all([fetchJson(comparisonUrl), fetchJson(openInterestUrl)]);
const historyResult = await enrichRows(comparison, openInterests, snapshotMs);
const minimumCompleteRows = Math.max(1, Math.floor(historyResult.candidateCount * 0.8));
if (historyResult.rows.length < minimumCompleteRows) {
  const samples = historyResult.failures.slice(0, 5).join(" | ");
  throw new Error(
    `Historical funding integrity gate failed: ${historyResult.rows.length}/${historyResult.candidateCount} ` +
      `complete rows; need at least ${minimumCompleteRows}. Sheet was not changed. ${samples}`,
  );
}
const allRows = historyResult.rows.sort((a, b) => b.maxAbsDiff - a.maxAbsDiff);
const builtRows = allRows.filter(
  (row) =>
    row.openInterestUsd !== undefined &&
    Math.abs(row.diff8h) >= minAbsDiff &&
    row.openInterestUsd > minOpenInterestUsd,
);

const filteredDirectValues = [
  [`Backpack / Binance UTC: ${new Date(snapshotMs).toISOString()}`],
  [`Binance / Backpack historical 1D/2D/3D funding diff | filter: abs current 8h diff >= 0.05% AND Backpack OI > $100k | sort: max abs diff`],
  ["Coin", "Open Interest", "Diff 1D", "Side", "Winner 1D", "Diff 2D", "Side", "Winner 2D", "Diff 3D", "Side", "Winner 3D"],
  ...builtRows.map((row) => {
    return [
      row.symbol,
      usd(row.openInterestUsd),
      pct(row.diff1d),
      compactSide(row.diff1d),
      winner(row.diff1d),
      pct(row.diff2d),
      compactSide(row.diff2d),
      winner(row.diff2d),
      pct(row.diff3d),
      compactSide(row.diff3d),
      winner(row.diff3d),
    ];
  }),
];

const allDirectValues = [
  [`All Binance / Backpack historical 1D/2D/3D funding diff | no OI filter | sort: max abs diff`],
  ["Coin", "Diff 1D", "Side", "Winner 1D", "Diff 2D", "Side", "Winner 2D", "Diff 3D", "Side", "Winner 3D"],
  ...allRows.map((row) => {
    return [
      row.symbol,
      pct(row.diff1d),
      compactSide(row.diff1d),
      winner(row.diff1d),
      pct(row.diff2d),
      compactSide(row.diff2d),
      winner(row.diff2d),
      pct(row.diff3d),
      compactSide(row.diff3d),
      winner(row.diff3d),
    ];
  }),
];

const sheetRows = [
  ...filteredDirectValues,
  [],
  ...allDirectValues,
];

console.log("Posting Backpack_Binance...");
if (process.env.BACKPACK_PRINT_ONLY === "1") {
  const debugJson = JSON.stringify({
    filteredRows: builtRows.length,
    allRows: allRows.length,
    sheetRows,
  }, null, 2);
  if (process.env.BACKPACK_DEBUG_FILE) {
    const fs = await import("node:fs/promises");
    await fs.writeFile(process.env.BACKPACK_DEBUG_FILE, debugJson, "utf8");
  } else {
    console.log(debugJson);
  }
  process.exit(0);
}
const result = await postSheet(sheetRows);
console.log(JSON.stringify({
  googleSheet: result,
  filteredRows: builtRows.length,
  allRows: allRows.length,
  twoZ: allRows.find((row) => row.symbol === "2Z") ?? null,
}, null, 2));
