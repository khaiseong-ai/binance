import { mkdir, readFile, writeFile } from "node:fs/promises";

const comparisonUrl = "https://backpack.exchange/api/funding-comparison";
const outputPath = new URL("../data/funding-history.json", import.meta.url);
const concurrency = 5;

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: "application/json",
      "user-agent": "funding-history-cache/1.0",
      ...options.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function fetchFundingHistory(symbol) {
  const official = new URL("https://fapi.binance.com/fapi/v1/fundingRate");
  official.searchParams.set("symbol", symbol);
  official.searchParams.set("limit", "100");
  try {
    const records = await fetchJson(official);
    if (Array.isArray(records)) return records;
  } catch (officialError) {
    console.warn(`[official] ${symbol}: ${officialError.message}`);
  }

  const payload = await fetchJson(
    "https://www.binance.com/bapi/futures/v1/public/future/common/get-funding-rate-history",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://www.binance.com",
        referer: "https://www.binance.com/en/futures/funding-history/perpetual/funding-fee-history",
      },
      body: JSON.stringify({ symbol, page: 1, rows: 100 }),
    },
  );
  const records = payload?.data?.rows ?? payload?.data ?? payload?.rows;
  if (!Array.isArray(records)) throw new Error(`${symbol} returned an unexpected history payload`);
  return records;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

const comparison = await fetchJson(comparisonUrl);
const symbols = [...new Set(comparison.map((item) => item.binanceMarket).filter(Boolean))].sort();
const failures = [];
const fetched = await mapLimit(symbols, concurrency, async (symbol) => {
  try {
    return [symbol, await fetchFundingHistory(symbol)];
  } catch (error) {
    failures.push(`${symbol}: ${error.message}`);
    return undefined;
  }
});

const freshRecords = Object.fromEntries(fetched.filter(Boolean));
const minimumComplete = Math.max(1, Math.floor(symbols.length * 0.8));
if (Object.keys(freshRecords).length < minimumComplete) {
  throw new Error(
    `Binance cache integrity failed: ${Object.keys(freshRecords).length}/${symbols.length}; ` +
      `need ${minimumComplete}. ${failures.slice(0, 5).join(" | ")}`,
  );
}

let previousRecords = {};
try {
  previousRecords = JSON.parse(await readFile(outputPath, "utf8")).records ?? {};
} catch {}

const output = {
  generatedAt: new Date().toISOString(),
  candidateCount: symbols.length,
  completeCount: Object.keys(freshRecords).length,
  failures,
  records: { ...previousRecords, ...freshRecords },
};
await mkdir(new URL("../data/", import.meta.url), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output)}\n`, "utf8");
console.log(`Wrote ${output.completeCount}/${output.candidateCount} Binance histories at ${output.generatedAt}`);
