# Triple Whale → Google Sheets

Pulls Triple Whale **pixel-attributed** ad performance (Google Ads + Microsoft/Bing,
plus ChatGPT/OpenAI) into a Google Sheet via Triple Whale's Data-Out SQL endpoint
(`pixel_joined_tvf()`), mirroring the Attribution page.

`Code.gs` is a Google Apps Script bound to the reporting spreadsheet.

---

## The one idea that makes this sustainable

There is **one source of truth**: a hidden tab `_store`, one row per
`(Date, Channel, Campaign)`, holding **raw summed components** — spend, revenue,
orders, clicks, impressions, etc. — **not** derived ratios.

Everything else is a **projection** of that store, computed in memory at render time:

| Tab | What it is |
|---|---|
| `Campaigns` | last 7 full days, one row per campaign |
| `Today` | today (partial), TOTAL row pinned on top |
| `Yesterday` | New-Customer roll-up + by-campaign |
| `By Day` | one row per day (Google + Microsoft combined) |
| `By Day - Campaign` | one row per campaign per day |
| `By Day - OpenAI` | ChatGPT ads, channel level |

Because every tab is derived from the same store, **the tabs can never disagree**,
and ratios are always recomputed from sums (you can't average ratios, so storing
components is the only correct form).

### Why the old duplication is now impossible

Syncing a day **replaces that day's rows atomically** (the whole `_store` is
rebuilt from an in-memory map on every write). There is no path that appends to a
day, so duplicate `(date, campaign)` rows can't accumulate — which was the failure
mode of the previous script, where a bad row written once was preserved forever
because days outside a 3-day window were never recomputed.

### Why numbers are now correct over time

Attribution is set to a **28-day window**, so a given day's attributed
revenue/conversions keep changing for 28 days as later purchases get attributed
back. `REFRESH_DAYS = 30` recomputes the whole still-changing window on every sync.
Anything older is frozen (it genuinely can't change) and never re-pulled.

### How it stays under the API / runtime limits

- **One SQL call per day.** Each day is a small scan, so the TW engine never times
  out. (The old script did 2–3 calls per day.)
- **Frozen history.** A normal daily sync only touches the last 30 days plus any
  not-yet-fetched older days — not the whole range.
- **Backfill, resumable.** History is filled in oldest-ward across runs, bounded by
  `MAX_RUNTIME_MS` (25 min, for a Workspace account's 30-min ceiling). If a run hits
  the budget mid-backfill it schedules a one-shot `resumeSync` ~1 min later and
  picks up exactly where it left off. Coverage is a contiguous `[oldest … today]`
  range, so "resume" just means "extend `oldest` further back."
- **"Max history."** The backfill keeps going until it sees `EMPTY_RUN_TO_STOP` (21)
  consecutive empty days — i.e. the start of the account's data — or the
  `BACKFILL_MAX_DAYS` (~4-year) backstop.

---

## Setup

1. **Script Properties** (Project Settings → Script Properties):
   - `TW_API_KEY` — Triple Whale API key *(required)*
   - `SLACK_WEBHOOK_URL` — Slack Incoming Webhook *(only if you use the Slack sends)*
     The webhook is **not** stored in the code on purpose — a committed webhook is a
     leaked credential. Keep it in this property.
2. Set `SHOP_ID` at the top of `Code.gs` to your `*.myshopify.com` domain.
3. **Project Settings → Time zone → `America/New_York`** (drives day boundaries and
   Slack send times).
4. Reload the sheet. Use the **Triple Whale** menu.

## First run — recommended order

1. **Diagnostics → Validate API key** — confirms the key + shop.
2. **Diagnostics → List channel ids** — confirm the real ids for Microsoft and
   OpenAI, and fix `ADS_CHANNELS` / `OPENAI_CHANNELS` if they differ.
3. **Diagnostics → Diagnose a day** — pick a recent day. This shows how much
   `order_revenue` sits on rows matched by `channel`, by `provider_id`, or by
   neither. See the note below — this is the one assumption worth verifying.
4. **Sync now (incremental)** — first sync fetches the last 30 days and starts the
   backfill. Re-run, or let the `resumeSync` trigger continue, until
   **Diagnostics → Show backfill state** says *start of data reached: yes*.
5. **Automation → Set up / repair automation** — installs the daily 6am sync and the
   Slack sends (8am yesterday summary; 11am/1pm/4pm today pacing).

## The one assumption to verify (revenue coverage)

The previous script fetched spend and revenue in two separate queries and then
**silently dropped** revenue rows whose `channel` wasn't in the list — even ones it
had gone out of its way to fetch by `provider_id`. This version instead does a
single query matching `channel IN (...) OR provider_id IN (...)` and resolves an
"effective channel," which **captures attributed revenue the old version lost**.

Run **Diagnostics → Diagnose a day** to confirm:
- Revenue under `provider_id=…` buckets = revenue this script now captures that the
  old one dropped (expected, good).
- Revenue under `OTHER` = revenue still not attributable to your channels (a
  channel-only filter would miss it too). If this is large and you expected it under
  Google/Microsoft, the channel/provider ids probably need adjusting.

## Menu reference

- **Sync now (incremental)** — refresh recent window + extend backfill + re-render.
- **Rebuild everything (full)** — wipe `_store` + state, resync from scratch.
- **Refresh today only** — cheap re-pull of just today.
- **Automation** — set up / status / remove the triggers.
- **Slack** — send the yesterday summary / today pacing now.
- **Diagnostics** — validate key, list channels, diagnose a day, discover pixel
  columns, show backfill state.

## Config knobs (`Code.gs`)

| Constant | Meaning |
|---|---|
| `MODEL`, `ATTR_WINDOW` | attribution model + window, applied as WHERE filters |
| `ADS_CHANNELS`, `OPENAI_CHANNELS` | Triple Whale channel ids |
| `REFRESH_DAYS` | recent days recomputed every sync — keep ≥ the attribution window |
| `BACKFILL_MAX_DAYS` | hard backstop on how far back to probe |
| `EMPTY_RUN_TO_STOP` | consecutive empty days that mean "start of data" |
| `BACKFILL_START` | optional `yyyy-MM-dd` floor the backfill must reach before it can stop on the empty-run heuristic (set when you need history to a specific date and the account may have had a dormant stretch) |
| `MAX_RUNTIME_MS` | stop-and-save budget (25 min Workspace / drop to ~4.5 min on a consumer Gmail account) |
| `CAMPAIGNS_DAYS` | window shown on the Campaigns tab |
