# Binance Funding Proxy for Vercel

This proxy only allows Binance international USD-M Futures market-data endpoints used by the funding-rate sheet:

- `/fapi/v1/exchangeInfo`
- `/fapi/v1/fundingRate`

## Deploy

1. Create a new GitHub repo and upload this folder's contents, or use Vercel CLI from this folder.
2. In Vercel, import the repo as a new project.
3. Add an environment variable:

```text
PROXY_SECRET=<your-random-secret>
```

Use a random value. Do not use `change-this-secret`.

4. Deploy.

## Test

Replace `<vercel-url>` and `<secret>`:

```text
https://<vercel-url>/api/binance?endpoint=/fapi/v1/fundingRate&symbol=BTCUSDT&limit=3&secret=<secret>
```

Expected response:

```json
{
  "ok": true,
  "data": [
    {
      "symbol": "BTCUSDT",
      "fundingRate": "..."
    }
  ]
}
```

