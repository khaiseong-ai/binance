const ALLOWED_ENDPOINTS = new Set([
  "/fapi/v1/exchangeInfo",
  "/fapi/v1/fundingRate",
]);
const FUNDING_HISTORY_ENDPOINT = "/bapi/futures/v1/public/future/common/get-funding-rate-history";

function sendJson(res, status, body) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
  res.status(status).send(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, error: "method not allowed" });
    return;
  }

  const expectedSecret = process.env.PROXY_SECRET;
  if (!expectedSecret) {
    sendJson(res, 500, { ok: false, error: "PROXY_SECRET is not configured" });
    return;
  }

  const auth = req.headers.authorization || "";
  const providedSecret = auth.startsWith("Bearer ") ? auth.slice(7) : req.query.secret;
  if (providedSecret !== expectedSecret) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return;
  }

  const endpoint = String(req.query.endpoint || "");
  if (!ALLOWED_ENDPOINTS.has(endpoint) && endpoint !== FUNDING_HISTORY_ENDPOINT) {
    sendJson(res, 400, { ok: false, error: "endpoint not allowed" });
    return;
  }

  try {
    let upstream;
    if (endpoint === FUNDING_HISTORY_ENDPOINT) {
      const symbol = String(req.query.symbol || "").toUpperCase();
      if (!/^[A-Z0-9]{2,30}$/.test(symbol)) {
        sendJson(res, 400, { ok: false, error: "invalid symbol" });
        return;
      }

      const rows = Math.min(1000, Math.max(1, Number(req.query.rows) || 100));
      const page = Math.max(1, Number(req.query.page) || 1);
      upstream = await fetch(`https://www.binance.com${FUNDING_HISTORY_ENDPOINT}`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Origin: "https://www.binance.com",
          Referer: "https://www.binance.com/en/futures/funding-history/perpetual/funding-fee-history",
          "User-Agent": "Mozilla/5.0 binance-funding-proxy",
        },
        body: JSON.stringify({ symbol, page, rows }),
      });
    } else {
      const url = new URL(`https://fapi.binance.com${endpoint}`);
      for (const [key, value] of Object.entries(req.query)) {
        if (key === "endpoint" || key === "secret") continue;
        if (Array.isArray(value)) {
          for (const item of value) url.searchParams.append(key, item);
        } else if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, value);
        }
      }
      upstream = await fetch(url.toString(), {
        headers: { "User-Agent": "Mozilla/5.0 binance-funding-proxy" },
      });
    }

    const text = await upstream.text();
    if (!upstream.ok) {
      sendJson(res, upstream.status, {
        ok: false,
        error: `binance status ${upstream.status}`,
        body: text.slice(0, 500),
      });
      return;
    }
    const parsed = JSON.parse(text);
    if (endpoint === FUNDING_HISTORY_ENDPOINT) {
      const rows = parsed?.data?.rows ?? parsed?.data ?? parsed?.rows;
      if (!Array.isArray(rows)) {
        sendJson(res, 502, {
          ok: false,
          error: "unexpected Binance history response",
          body: text.slice(0, 500),
        });
        return;
      }
      sendJson(res, 200, { ok: true, data: rows });
      return;
    }
    sendJson(res, 200, { ok: true, data: parsed });
  } catch (error) {
    sendJson(res, 502, { ok: false, error: error.message });
  }
}
