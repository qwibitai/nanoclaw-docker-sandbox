# Telegram Webhook Security Audit

**Date:** 2026-03-21
**Branch:** `feat/telegram-webhook`
**Status:** All findings remediated. External tunnel tests pending (Cloudflare provisioning).

## Architecture

```
Telegram servers
      │ HTTPS POST (each update)
      ▼
Cloudflare Tunnel (nanoclaw.novikov.pro:443)
      │ Sets Cf-Connecting-Ip header with real client IP
      ▼ HTTP (localhost:47019)
NanoClaw webhook server
      │ IP validation → Content-Type check → Body size limit → grammY webhookCallback
      ▼
Existing message handlers
```

## Security Layers

| Layer | What it does |
|-------|-------------|
| Cloudflare Tunnel | No direct IP exposure; HTTPS termination; sets `Cf-Connecting-Ip` |
| IP validation | Rejects requests not from Telegram's published CIDR ranges |
| Secret token | grammY validates `X-Telegram-Bot-Api-Secret-Token` (constant-time) |
| Content-Type check | Rejects non-JSON bodies before they reach grammY |
| Body size limit | 1 MB cap, returns 413 |
| Request timeouts | 15s headers, 30s request (Slowloris mitigation) |
| Localhost binding | Port 47019 bound to 127.0.0.1 only |
| Non-standard port | 47019 instead of obvious 3002 |
| Required env vars | Startup crashes if BOT_TOKEN, WEBHOOK_URL, or WEBHOOK_SECRET missing |

## Pentest Findings & Remediation

### Code Review (static analysis)

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| 1 | HIGH | No explicit IPv6 handling — `isTelegramIp()` relied on accidental `NaN→0` conversion for safety | **Fixed:** Strip `::ffff:` prefix for mapped IPv4; reject pure IPv6 |
| 2 | HIGH | No request body size limit — memory exhaustion DoS via multi-GB POST | **Fixed:** 1 MB cap with `req.destroy()` on exceed |
| 3 | MEDIUM | Incomplete Telegram CIDR allowlist — missing 91.108.{8,12,16,20}.0/22 ranges would silently reject legitimate traffic | **Fixed:** All 5 ranges added |
| 4 | MEDIUM | Webhook secret optional — empty `TELEGRAM_WEBHOOK_SECRET` disables token validation | **Fixed:** Required at startup, throws if missing |
| 5 | MEDIUM | No request/header timeouts — Slowloris DoS | **Fixed:** `headersTimeout=15s`, `requestTimeout=30s` |
| 6 | MEDIUM | `validateIp` option could be accidentally set to false in production | **Accepted:** Defaults to `true`; only tests set `false` |
| 7 | MEDIUM | `Cf-Connecting-Ip` trusted without verifying Cloudflare origin | **Mitigated:** Server bound to 127.0.0.1 — only reachable via tunnel |
| 8 | LOW | `ipToInt()` signed integer behavior | **Verified correct:** `>>> 0` handles all edge cases |
| 9 | INFO | CIDR mask calculation | **Verified correct:** No off-by-one |
| 10 | INFO | No TOCTOU race conditions | **Verified clean** |

### Dynamic Testing (localhost pentest)

| # | Test | Result | Status |
|---|------|--------|--------|
| 1 | Path traversal (`/webhook/../health`) | Reaches `/health` (harmless — just returns "ok") | INFO |
| 2 | IP validation — no header | 403 Forbidden | PASS |
| 3 | IP validation — wrong IP (1.2.3.4) | 403 Forbidden | PASS |
| 4 | IP validation — Telegram IP (149.154.167.50) | 200 Accepted | PASS |
| 5 | IP validation — IPv4-mapped IPv6 | Correctly handled | PASS |
| 6 | IP validation — pure IPv6 | Rejected | PASS |
| 7 | Secret token missing/wrong | grammY returns 200 but silently drops (handlers don't fire) | PASS — by design |
| 8 | XML body injection | **Was:** unhandled SyntaxError rejection | **Fixed:** 415 Unsupported Media Type |
| 9 | Large body (2MB) | Connection reset by body limit | PASS |
| 10 | Multi-header IP coalescing | **Was:** could bypass by appending Telegram IP | **Fixed:** uses first IP only |
| 11 | Port binding | 127.0.0.1 only — not externally reachable | PASS |

### Pending: External Tunnel Tests

These require Cloudflare Tunnel to finish provisioning:

| # | Test | Expected |
|---|------|----------|
| 1 | `GET /health` through tunnel | 200 "ok" |
| 2 | `POST /webhook` from non-Telegram IP through tunnel | 403 (Cloudflare sets real `Cf-Connecting-Ip`) |
| 3 | Spoofed `Cf-Connecting-Ip` through tunnel | 403 (Cloudflare overwrites the header) |
| 4 | End-to-end: Telegram message → NanoClaw logs | Message stored and processed |
| 5 | Offline recovery: stop NanoClaw → send message → restart → message arrives | Telegram pushes queued updates on `setWebhook` |

## Telegram IP Ranges

Source: https://core.telegram.org/bots/webhooks

```
149.154.160.0/20
91.108.4.0/22
91.108.8.0/22
91.108.12.0/22
91.108.16.0/22
91.108.20.0/22
```

## Configuration

```env
TELEGRAM_WEBHOOK_URL=https://nanoclaw.novikov.pro/webhook
TELEGRAM_WEBHOOK_SECRET=<64-char hex from openssl rand -hex 32>
TELEGRAM_WEBHOOK_PORT=47019  # default, override via env
```

Cloudflare Tunnel config: `~/.cloudflared/config.yml`
Tunnel ID: `fc41c7c7-958f-4922-a340-4e912f3cc608`
