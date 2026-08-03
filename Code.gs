/**
 * Triple Whale → Google Sheets  —  pixel-attributed performance
 * =============================================================================
 * Pulls Triple Whale pixel-attributed ad performance (Google Ads + Microsoft/
 * Bing, plus ChatGPT/OpenAI) from pixel_joined_tvf() via the Data-Out SQL
 * endpoint, and lands it in a Google Sheet. Mirrors the Attribution page.
 *
 * DESIGN (why this version is simpler than the old one)
 * -----------------------------------------------------------------------------
 * There is ONE source of truth: a hidden tab `_store`, one row per
 * (Date, Channel, Campaign), holding RAW SUMMED COMPONENTS — spend, revenue,
 * orders, clicks, etc. — NOT derived ratios. Every visible tab (Campaigns,
 * Today, Yesterday, By Day, By Day - Campaign, By Day - OpenAI) is a cheap
 * PROJECTION of that store, so the tabs can never disagree with each other.
 *
 * Ingestion is idempotent per day: syncing a day DELETES that day's rows and
 * re-inserts them. Duplicates are therefore impossible by construction — the
 * failure mode of the previous script. Because a whole day is replaced atomically
 * you also get free resumability: a run that stops early loses nothing.
 *
 * Data older than the attribution window is FROZEN (it can't change), so a normal
 * sync only recomputes the most recent REFRESH_DAYS days plus any not-yet-fetched
 * older days. History grows without ever re-pulling the whole range.
 *
 * ATTRIBUTION: MODEL / ATTR_WINDOW below are applied as WHERE filters on
 * pixel_joined_tvf() (per Triple Whale support). Left blank, the API returns its
 * default (Triple Attribution / Lifetime), which reads higher than Last Click.
 *
 * SETUP
 *   1. Script Properties: TW_API_KEY (required), SLACK_WEBHOOK_URL (for Slack).
 *   2. Set SHOP_ID below to your myshopify domain.
 *   3. Project Settings → Time zone → America/New_York (Slack + day boundaries).
 *   4. Reload the sheet → Triple Whale menu → Diagnostics → Validate API key.
 *   5. Triple Whale → Set up / repair automation  (installs triggers, starts
 *      the backfill). Or run "Sync now" once by hand first.
 *
 * Lockhern Digital — internal reporting tool.
 */

// ============================== CONFIG =====================================

var SHOP_ID  = 'shopxeroshoes.myshopify.com';
var CURRENCY = 'USD';

// Attribution model + window, applied as WHERE filters on pixel_joined_tvf().
// Set either to '' to let the API use its default.
// Models:  'Last Click', 'First Click', 'Linear All', 'Linear Paid',
//          'Triple Attribution', 'Triple Attribution + Views',
//          'Clicks & Views', 'Total Impact'.
// Windows: '1_day', '7_days', '14_days', '28_days', 'lifetime'.
var MODEL       = 'Last Click';
var ATTR_WINDOW = '28_days';

// Channel sources. `ads` is the campaign-level Google + Microsoft feed; `openai`
// is ChatGPT ads, kept channel-level only. If Microsoft rows don't show up, its
// id may differ — run Diagnostics → List channel ids and fix the id here
// (alternatives seen in the wild: 'microsoft', 'bing-ads').
var ADS_CHANNELS    = ['google-ads', 'bing'];
var OPENAI_CHANNELS = ['openai-ads'];

// How the daily sync behaves.
//   REFRESH_DAYS      recompute this many recent days every sync. MUST be >= the
//                     attribution window: with 28-day attribution a day's
//                     numbers keep changing for 28 days as later purchases get
//                     attributed back, so anything shorter under-reports.
//   BACKFILL_MAX_DAYS hard backstop on how far back to probe ("max history").
//   EMPTY_RUN_TO_STOP once this many consecutive older days come back empty, we
//                     assume we've reached the start of the account's data and
//                     stop extending backwards.
//   MAX_RUNTIME_MS    stop and save before Apps Script kills the run. Workspace
//                     accounts allow 30 min; 25 min leaves headroom. (A consumer
//                     Gmail account is 6 min — drop this to ~4.5*60*1000.)
var REFRESH_DAYS      = 30;
var BACKFILL_MAX_DAYS = 1460;           // ~4 years
var EMPTY_RUN_TO_STOP = 21;
var MAX_RUNTIME_MS    = 25 * 60 * 1000;

// Oldest date to pull ('yyyy-MM-dd'). This is a HARD limit: the backfill fills
// every day from today back to exactly this date and then STOPS — it never pulls
// anything older, and any older days already in the store are trimmed out. Set
// it to the start of the range you want in the sheet.
// Leave '' to instead pull as far back as data exists (using the empty-run
// heuristic below to detect the start of the account's data).
var BACKFILL_START    = '2026-06-01';   // pull June 1, 2026 → today, nothing older

// Window (in full days) shown on the Campaigns tab.
var CAMPAIGNS_DAYS = 7;

// Tab names.
var STORE_SHEET       = '_store';        // hidden source of truth
var CAMPAIGNS_SHEET   = 'Campaigns';
var TODAY_SHEET       = 'Today';
var YESTERDAY_SHEET   = 'Yesterday';
var BYDAY_SHEET       = 'By Day';
var CAMPAIGN_DAY_SHEET= 'By Day - Campaign';
var OPENAI_SHEET      = 'By Day - OpenAI';

// Script Property keys for backfill state.
var PROP_OLDEST     = 'COVERED_OLDEST';       // oldest date fetched (contiguous to today)
var PROP_DATA_START = 'DATA_START_REACHED';   // 'true' once we hit the start of data

var SQL_ENDPOINT = 'https://api.triplewhale.com/api/v2/orcabase/api/sql';
var WHOAMI       = 'https://api.triplewhale.com/api/v2/users/api-keys/me';

// Slack Incoming Webhook — read from Script Property SLACK_WEBHOOK_URL. Do NOT
// paste the live URL here: this file lives in git, and a committed webhook is a
// leaked credential anyone can post to.
var SLACK_WEBHOOK_URL = '';

// [header, store/derived key]. Layout mirrors the Attribution page.
var COLUMNS = [
  ['Campaign',     'campaign'],
  ['Channel',      'channel'],
  ['Spend',        'total_spend'],
  ['ROAS',         'channel_roas'],
  ['Pixel ROAS',   'pixel_roas'],
  ['Purchases',    'pixel_purchases'],
  ['NCP',          'nc_purchases'],
  ['NC AOV',       'nc_aov'],
  ['NC PP',        'nc_percent'],
  ['NC CPA',       'nc_cpa'],
  ['Pixel CV',     'pixel_cv'],
  ['Pixel CPA',    'pixel_cpa'],
  ['Pixel AOV',    'pixel_aov'],
  ['NC ROAS',      'nc_roas'],
  ['NC CV',        'nc_cv'],
  ['Channel Conv', 'channel_conv'],
  ['Channel CV',   'channel_cv'],
  ['Clicks',       'total_clicks'],
  ['Impressions',  'total_impressions'],
  ['CTR',          'ctr'],
  ['CPC',          'cpc'],
];

var FORMATS = {
  total_spend: '$#,##0.00', pixel_cv: '$#,##0.00', nc_cv: '$#,##0.00', channel_cv: '$#,##0.00',
  pixel_cpa: '$#,##0.00', pixel_aov: '$#,##0.00', nc_cpa: '$#,##0.00', nc_aov: '$#,##0.00', cpc: '$#,##0.00',
  channel_roas: '#,##0.00', pixel_roas: '#,##0.00', nc_roas: '#,##0.00',
  pixel_purchases: '#,##0', nc_purchases: '#,##0', channel_conv: '#,##0.00',
  total_clicks: '#,##0', total_impressions: '#,##0',
  nc_percent: '0.00%', ctr: '0.00%',
};

// Raw component fields stored per row (order defines the _store columns).
var STORE_FIELDS = ['spend', 'order_revenue', 'orders_quantity', 'new_customer_orders',
  'new_customer_order_revenue', 'channel_conv', 'channel_cv', 'clicks', 'impressions'];

var HEAD_BG = '#1b2a4a', HEAD_FG = '#ffffff';

// ============================== MENU =======================================

function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('Triple Whale')
    .addItem('Sync now (add new + reconcile last 30 days)', 'sync')
    .addItem('Rebuild all data — background (watch _status)', 'rebuildInBackground')
    .addItem('Rebuild all data — foreground', 'fullResync')
    .addItem('Refresh today only', 'refreshToday')
    .addSeparator()
    .addSubMenu(ui.createMenu('Automation')
      .addItem('Set up / repair automation', 'setupAutomation')
      .addItem('Automation status', 'automationStatus')
      .addItem('Remove all automation', 'removeAllAutomation'))
    .addSubMenu(ui.createMenu('Slack')
      .addItem('Send yesterday summary now', 'slackYesterday')
      .addItem('Send today pacing now', 'slackToday'))
    .addSubMenu(ui.createMenu('Diagnostics')
      .addItem('Validate API key', 'validateKey')
      .addItem('List channel ids', 'listChannels')
      .addItem('Diagnose a day (revenue coverage)', 'diagnoseDayPrompt')
      .addItem('Probe revenue (where is it?)', 'probeRevenuePrompt')
      .addItem('Discover pixel columns', 'discoverPixel')
      .addItem('Show backfill state', 'backfillState'))
    .addToUi();
}

// ============================== INGESTION ==================================
// One entry point. Recompute the recent (unfrozen) window, extend the backfill
// a little further into the past, then re-render every tab from the store.

function sync() {
  assertShop_();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) { progress_('Sync: another run holds the lock — skipping.'); return; }
  try {
    _syncLocked_();
  } finally {
    lock.releaseLock();
  }
}

function _syncLocked_() {
  var t0  = Date.now();
  var tz  = tz_();
  var days = readStore_();                 // { 'yyyy-MM-dd': [storeRow, ...] }
  var today = todayStr_();
  var props = PropertiesService.getScriptProperties();

  // 1) Recompute the recent, still-changing window (today .. today-REFRESH_DAYS).
  progress_('Starting — reconciling the last ' + REFRESH_DAYS + ' days (today back)…');
  var refreshed = 0;
  for (var i = 0; i < REFRESH_DAYS; i++) {
    if (Date.now() - t0 > MAX_RUNTIME_MS) break;
    var d = dateStr_(-i);
    days[d] = fetchDayRows_(d);
    refreshed++;
    if (refreshed === 1 || refreshed % 10 === 0 || refreshed === REFRESH_DAYS) {
      progress_('Reconciling recent days: ' + refreshed + '/' + REFRESH_DAYS + '  (' + d + ')');
    }
    Utilities.sleep(30);
  }

  // 2) Extend the backfill further into the past (unless we've reached the start
  //    of the data). Coverage is a contiguous range [oldest .. today].
  var oldest = props.getProperty(PROP_OLDEST) || minKey_(days) || today;
  var dataStart = props.getProperty(PROP_DATA_START) === 'true';
  var emptyRun = 0, backfilled = 0, stopped = null;

  if (!dataStart) {
    var cursor = dateAdd_(oldest, -1);         // first day older than we've covered
    var floor  = BACKFILL_START || dateStr_(-BACKFILL_MAX_DAYS);   // stop here
    var total  = Math.max(0, daysBetween_(floor, cursor) + 1);     // days left to backfill
    if (cursor >= floor) progress_('Backfilling history: ' + cursor + ' → ' + floor + '  (~' + total + ' days)…');
    while (cursor >= floor) {
      if (Date.now() - t0 > MAX_RUNTIME_MS) { stopped = cursor; break; }
      var rows = fetchDayRows_(cursor);
      days[cursor] = rows;
      oldest = cursor;
      backfilled++;
      if (rows.length) emptyRun = 0; else emptyRun++;
      // The empty-run "start of data" heuristic only applies in open-ended mode.
      // With an explicit BACKFILL_START we always fill straight through to it.
      if (!BACKFILL_START && emptyRun >= EMPTY_RUN_TO_STOP) { dataStart = true; break; }
      if (backfilled === 1 || backfilled % 5 === 0) {
        progress_('Backfilling: ' + backfilled + '/' + total + ' days  (at ' + cursor + ')');
      }
      cursor = dateAdd_(cursor, -1);
      Utilities.sleep(30);
    }
    if (cursor < floor) dataStart = true;      // reached the floor (or backstop) — done
  }

  // Enforce the hard start: drop anything older than BACKFILL_START (cleans up
  // any days a previous, more-open-ended run may have pulled).
  if (BACKFILL_START) {
    Object.keys(days).forEach(function (d) { if (d < BACKFILL_START) delete days[d]; });
    oldest = minKey_(days) || today;
  }

  props.setProperty(PROP_OLDEST, oldest);
  props.setProperty(PROP_DATA_START, dataStart ? 'true' : 'false');

  // 3) Persist the store, then render every tab from it.
  progress_('Saving ' + Object.keys(days).length + ' days to the store…');
  writeStore_(days);
  progress_('Building the tabs…');
  renderAll_(days, oldest, today);

  // 4) If the backfill isn't finished and we stopped on the clock, resume soon.
  if (stopped && !dataStart) {
    scheduleResume_();
    progress_('Sync done. Backfill paused at ' + stopped + ' on the time budget — resuming in ~1 min.');
  } else {
    clearResumeTriggers_();
    progress_('Sync complete. ' + refreshed + ' recent day(s) refreshed, ' + backfilled +
      ' backfilled. Oldest: ' + oldest + (dataStart ? ' (start of data reached).' : '.'));
  }
}

// Kick off a full rebuild in the BACKGROUND via a one-shot trigger, so the
// spreadsheet UI isn't blocked and the _status tab updates live while it runs.
function rebuildInBackground() {
  clearRebuildTriggers_();
  ScriptApp.newTrigger('fullResync').timeBased().after(3000).create();
  try { setStatus_('Rebuild scheduled — starting in a few seconds. Watch this tab.'); } catch (e) {}
  SpreadsheetApp.getUi().alert('Rebuild started in the background.\n\n' +
    'Open the "_status" tab — it updates live (about one line every few seconds) as each day is pulled. ' +
    'You can close this dialog and keep working; the data tabs refresh when it finishes (~a few minutes).');
}

// Full rebuild: wipe the store + state and sync from scratch. Safe to run from
// the menu (foreground) or from the background trigger above.
function fullResync() {
  assertShop_();
  clearRebuildTriggers_();                      // remove the one-shot that launched us
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(STORE_SHEET);
  if (sh) ss.deleteSheet(sh);
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty(PROP_OLDEST);
  props.deleteProperty(PROP_DATA_START);
  progress_('Full rebuild: store cleared, pulling from scratch…');
  sync();
}

function clearRebuildTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'fullResync') ScriptApp.deleteTrigger(t);
  });
}

// Re-pull just today (partial) and re-render the Today tab. Cheap enough to run
// several times a day / from an hourly trigger.
function refreshToday() {
  assertShop_();
  var days = readStore_();
  var today = todayStr_();
  days[today] = fetchDayRows_(today);
  writeStore_(days);
  renderToday_(days, today);
  progress_('Today refreshed.');
}

// Fetch and aggregate ONE day into store rows — a SINGLE SQL call for all
// channels, then split by grain (ads = per campaign, OpenAI = channel level).
// Returns [] for a genuinely empty day — its absence of rows IS the record;
// coverage is tracked by date range, so an empty day is never re-fetched.
function fetchDayRows_(ds) {
  var rows = rawDay_(ds, ADS_CHANNELS.concat(OPENAI_CHANNELS));
  var ads = rows.filter(function (r) { return ADS_CHANNELS.indexOf(r._channel) !== -1; });
  var oa  = rows.filter(function (r) { return OPENAI_CHANNELS.indexOf(r._channel) !== -1; });
  return aggregateDay_(ads, 'campaign', ds).concat(aggregateDay_(oa, 'channel', ds));
}

// Raw rows for one day, filtered to `channels` IN THE SCRIPT (not in SQL).
//
// IMPORTANT: we deliberately do NOT put a channel/provider_id predicate in the
// WHERE clause. In Triple Whale's SQL a predicate on channel/provider_id is
// pushed into pixel_joined_tvf() and suppresses the pixel ORDER rows — only the
// ad-spend rows come back, which is why order_revenue/new-customer columns were
// all 0. Selecting on spend/revenue returns the full joined set (ad rows AND
// order rows, each already carrying its own `channel`); we keep just our
// channels here. Confirmed against Diagnostics → Diagnose a day, where
// channel=google-ads / channel=bing carry the real attributed revenue.
function rawDay_(ds, channels) {
  var q = "SELECT * FROM pixel_joined_tvf()" +
    " WHERE event_date BETWEEN @startDate AND @endDate" +
    " AND (spend > 0 OR order_revenue > 0)" +
    attrFilter_();
  var rows = extractRows_(postSql_({ shopId: SHOP_ID, currency: CURRENCY, query: q,
    period: { startDate: ds, endDate: ds } }));
  var out = [];
  rows.forEach(function (r) {
    if (channels.indexOf(r.channel) === -1) return;   // keep only our channels
    r._channel = r.channel;
    out.push(r);
  });
  return out;
}

function attrFilter_() {
  return (MODEL ? (" AND model = '" + MODEL + "'") : '') +
         (ATTR_WINDOW ? (" AND attribution_window = '" + ATTR_WINDOW + "'") : '');
}

// ============================== AGGREGATION ================================
// pixel_joined is a JOINED table (ad rows and order rows are separate rows), so
// we pull raw rows and sum here. We store raw COMPONENTS and derive ratios only
// at render time — you cannot average ratios, so storing sums is the only form
// that reprojects correctly across every tab.

function seedComponents_(extra) {
  var g = {};
  STORE_FIELDS.forEach(function (f) { g[f] = 0; });
  Object.keys(extra || {}).forEach(function (k) { g[k] = extra[k]; });
  return g;
}

function sumInto_(g, r) {
  var n = function (v) { var x = Number(v); return isNaN(x) ? 0 : x; };
  g.spend                      += n(r.spend);
  g.order_revenue              += n(r.order_revenue);
  g.orders_quantity            += n(r.orders_quantity);
  g.new_customer_orders        += n(r.new_customer_orders);
  g.new_customer_order_revenue += n(r.new_customer_order_revenue);
  g.channel_conv               += n(r.channel_reported_conversions);
  g.channel_cv                 += n(r.channel_reported_conversion_value);
  g.clicks                     += n(r.clicks);
  g.impressions                += n(r.impressions);
  return g;
}

function campaignName_(r) {
  return String(r.campaign_name || '(not set)').trim().replace(/\s+/g, ' ');
}

// Aggregate raw rows for a day to store rows. grain 'campaign' → one row per
// channel+campaign; grain 'channel' → one row per channel (campaign blank).
function aggregateDay_(rows, grain, ds) {
  var groups = {};
  rows.forEach(function (r) {
    var chan = r._channel || r.channel || '';
    var camp = grain === 'campaign' ? campaignName_(r) : '';
    var key = chan + '||' + camp;
    var g = groups[key] || (groups[key] = seedComponents_({ date: ds, channel: chan, campaign: camp }));
    sumInto_(g, r);
  });
  return Object.keys(groups).map(function (k) { return groups[k]; });
}

// Derive display metrics from summed components. Shared by every tab so numbers
// are computed identically everywhere.
function deriveMetrics_(g) {
  var div = function (a, b) { return b ? a / b : ''; };
  var out = {
    campaign: g.campaign, channel: g.channel, date: g.date,
    total_spend: g.spend,
    pixel_cv: g.order_revenue,
    pixel_roas: div(g.order_revenue, g.spend),
    pixel_purchases: g.orders_quantity,
    pixel_cpa: div(g.spend, g.orders_quantity),
    pixel_aov: div(g.order_revenue, g.orders_quantity),
    nc_purchases: g.new_customer_orders,
    nc_cv: g.new_customer_order_revenue,
    nc_roas: div(g.new_customer_order_revenue, g.spend),
    nc_cpa: div(g.spend, g.new_customer_orders),
    nc_aov: div(g.new_customer_order_revenue, g.new_customer_orders),
    nc_percent: div(g.new_customer_orders, g.orders_quantity),
    channel_conv: g.channel_conv,
    channel_cv: g.channel_cv,
    channel_roas: div(g.channel_cv, g.spend),
    total_clicks: g.clicks,
    total_impressions: g.impressions,
    ctr: div(g.clicks, g.impressions),
    cpc: div(g.spend, g.clicks),
  };
  return out;
}

// Sum a list of component-bearing store rows into one component bag.
function sumComponents_(rows, extra) {
  var g = seedComponents_(extra || {});
  rows.forEach(function (r) {
    STORE_FIELDS.forEach(function (f) { g[f] += Number(r[f]) || 0; });
  });
  return g;
}

// ============================== STORE I/O ==================================

// Read the hidden store into { 'yyyy-MM-dd': [ {date,channel,campaign,...fields} ] }.
function readStore_() {
  var days = {};
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STORE_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return days;
  var width = 3 + STORE_FIELDS.length;
  var vals = sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues();
  vals.forEach(function (row) {
    var date = String(row[0]).trim();
    if (!date) return;
    var rec = { date: date, channel: String(row[1]), campaign: String(row[2]) };
    STORE_FIELDS.forEach(function (f, i) { rec[f] = Number(row[3 + i]) || 0; });
    (days[date] || (days[date] = [])).push(rec);
  });
  return days;
}

// Rewrite the hidden store from the in-memory map. Dates newest first.
function writeStore_(days) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(STORE_SHEET) || ss.insertSheet(STORE_SHEET);
  sheet.clearContents();

  var header = ['Date', 'Channel', 'Campaign'].concat(STORE_FIELDS);
  sheet.getRange(1, 1, 1, header.length).setValues([header]);

  var out = [];
  datesDesc_(days).forEach(function (d) {
    days[d].forEach(function (r) {
      var row = [d, r.channel, r.campaign];
      STORE_FIELDS.forEach(function (f) { row.push(Number(r[f]) || 0); });
      out.push(row);
    });
  });
  if (out.length) {
    sheet.getRange(2, 1, out.length, header.length).setValues(out);
    sheet.getRange(2, 1, out.length, 1).setNumberFormat('@');   // keep dates as text keys
  }
  sheet.hideSheet();
}

// ============================== PROJECTIONS ================================
// Every tab below is derived purely from the store — no API calls.

function renderAll_(days, oldest, today) {
  renderCampaigns_(days);
  renderToday_(days, today);
  renderYesterday_(days);
  renderByDay_(days, oldest, today);
  renderCampaignByDay_(days);
  renderOpenAI_(days, oldest, today);
}

function isAds_(ch)    { return ADS_CHANNELS.indexOf(ch) !== -1; }
function isOpenAi_(ch) { return OPENAI_CHANNELS.indexOf(ch) !== -1; }

// All store rows within [from..to] whose channel passes `pred`.
function rowsInRange_(days, from, to, pred) {
  var out = [];
  Object.keys(days).forEach(function (d) {
    if (d < from || d > to) return;
    days[d].forEach(function (r) { if (pred(r.channel)) out.push(r); });
  });
  return out;
}

function recordToRow_(rec, cols) {
  return cols.map(function (c) { var v = rec[c[1]]; return (v === undefined || v === null || v === '') ? (v === 0 ? 0 : '') : v; });
}

function applyFormats_(sheet, cols, startRow, numRows) {
  if (numRows < 1) return;
  cols.forEach(function (c, idx) {
    var fmt = FORMATS[c[1]];
    if (fmt) sheet.getRange(startRow, idx + 1, numRows, 1).setNumberFormat(fmt);
  });
}

function headerRow_(sheet, header) {
  sheet.getRange(1, 1, 1, header.length).setValues([header])
    .setFontWeight('bold').setBackground(HEAD_BG).setFontColor(HEAD_FG);
  sheet.setFrozenRows(1);
}

function stamp_(sheet, col, text) {
  var s = Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm');
  sheet.getRange(1, col + 2).setValue('Updated ' + s + '  |  model: ' + modelLabel_() + '  |  ' + text);
}

function modelLabel_() { return (MODEL || 'default') + ' / ' + (ATTR_WINDOW || 'default'); }

// ---- Campaigns (last CAMPAIGNS_DAYS full days) ----
function renderCampaigns_(days) {
  var to = dateStr_(-1), from = dateStr_(-CAMPAIGNS_DAYS);   // yesterday back
  var rows = rowsInRange_(days, from, to, isAds_);
  var recs = groupByCampaign_(rows).map(deriveMetrics_);
  recs.sort(function (a, b) { return num_(b.total_spend) - num_(a.total_spend); });
  writeGrid_(CAMPAIGNS_SHEET, COLUMNS, recs, from + ' → ' + to, false);
}

// ---- Today (partial, TOTAL pinned on top) ----
function renderToday_(days, today) {
  var rows = (days[today] || []).filter(function (r) { return isAds_(r.channel); });
  var recs = groupByCampaign_(rows).map(deriveMetrics_);
  recs.sort(function (a, b) { return num_(b.total_spend) - num_(a.total_spend); });
  var total = deriveMetrics_(sumComponents_(rows, { campaign: 'TOTAL', channel: adsLabel_() }));
  writeGrid_(TODAY_SHEET, COLUMNS, [total].concat(recs), today + ' (today, partial)', true);
}

// ---- Yesterday (New-Customer roll-up + by-campaign) ----
function renderYesterday_(days) {
  var y = dateStr_(-1);
  var rows = (days[y] || []).filter(function (r) { return isAds_(r.channel); });
  var recs = groupByCampaign_(rows).map(deriveMetrics_);

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(YESTERDAY_SHEET) || ss.insertSheet(YESTERDAY_SHEET);
  sheet.clearContents();

  var nc = 0, ncRev = 0, twRev = 0;
  recs.forEach(function (c) { nc += num_(c.nc_purchases); ncRev += num_(c.nc_cv); twRev += num_(c.pixel_cv); });

  var head = function (rng) { rng.setFontWeight('bold').setBackground(HEAD_BG).setFontColor(HEAD_FG); };
  sheet.getRange(1, 1).setValue('Yesterday — ' + adsLabel_() + ' — ' + y + '  (' + modelLabel_() + ')').setFontWeight('bold');
  sheet.getRange(2, 1).setValue('Total TW Revenue (' + adsLabel_() + ')').setFontWeight('bold');
  sheet.getRange(2, 2).setValue(twRev).setFontWeight('bold').setFontSize(14).setNumberFormat('$#,##0.00');

  head(sheet.getRange(4, 1, 1, 3).setValues([['New Customers', 'NC Revenue', 'TW Revenue (Total)']]));
  sheet.getRange(5, 1, 1, 3).setValues([[nc, ncRev, twRev]]);
  sheet.getRange(5, 1).setNumberFormat('#,##0');
  sheet.getRange(5, 2, 1, 2).setNumberFormat('$#,##0.00');

  sheet.getRange(7, 1).setValue('By Campaign').setFontWeight('bold');
  head(sheet.getRange(8, 1, 1, 5).setValues([['Campaign', 'Channel', 'New Customers', 'NC Revenue', 'TW Revenue']]));

  recs.sort(function (a, b) { return num_(b.pixel_cv) - num_(a.pixel_cv); });
  var body = recs.map(function (c) { return [c.campaign, c.channel, num_(c.nc_purchases), num_(c.nc_cv), num_(c.pixel_cv)]; });
  if (body.length) {
    sheet.getRange(9, 1, body.length, 5).setValues(body);
    sheet.getRange(9, 3, body.length, 1).setNumberFormat('#,##0');
    sheet.getRange(9, 4, body.length, 2).setNumberFormat('$#,##0.00');
  } else {
    sheet.getRange(9, 1).setValue('No rows for ' + y + '.');
  }
  sheet.autoResizeColumns(1, 5);
}

// ---- By Day (one row per day, ads channels combined) ----
function renderByDay_(days, oldest, today) {
  var cols = byDayCols_();
  var out = [];
  eachDateDesc_(oldest, today, function (d) {
    var rows = (days[d] || []).filter(function (r) { return isAds_(r.channel); });
    var rec = deriveMetrics_(sumComponents_(rows, { date: d }));
    out.push(recordToRow_(rec, cols));
  });
  writeRows_(BYDAY_SHEET, cols, out, (out.length ? out[out.length - 1][0] + ' → ' + out[0][0] : ''), false);
}

// ---- By Day - Campaign (one row per campaign per day) ----
function renderCampaignByDay_(days) {
  var cols = campaignDayCols_();
  var out = [];
  datesDesc_(days).forEach(function (d) {
    var recs = (days[d] || []).filter(function (r) { return isAds_(r.channel); }).map(deriveMetrics_);
    recs.sort(function (a, b) { return num_(b.total_spend) - num_(a.total_spend); });
    recs.forEach(function (rec) { rec.date = d; out.push(recordToRow_(rec, cols)); });
  });
  writeRows_(CAMPAIGN_DAY_SHEET, cols, out, out.length + ' rows', false);
}

// ---- By Day - OpenAI (channel level) ----
function renderOpenAI_(days, oldest, today) {
  var cols = byDayCols_();
  var out = [];
  eachDateDesc_(oldest, today, function (d) {
    var rows = (days[d] || []).filter(function (r) { return isOpenAi_(r.channel); });
    if (!rows.length) return;                       // OpenAI is sparse — skip empty days
    out.push(recordToRow_(deriveMetrics_(sumComponents_(rows, { date: d })), cols));
  });
  writeRows_(OPENAI_SHEET, cols, out, (out.length ? out[out.length - 1][0] + ' → ' + out[0][0] : 'no data'), false);
}

// Group ads store rows by channel+campaign into component bags.
function groupByCampaign_(rows) {
  var groups = {};
  rows.forEach(function (r) {
    var key = r.channel + '||' + r.campaign;
    var g = groups[key] || (groups[key] = seedComponents_({ campaign: r.campaign, channel: r.channel }));
    STORE_FIELDS.forEach(function (f) { g[f] += Number(r[f]) || 0; });
  });
  return Object.keys(groups).map(function (k) { return groups[k]; });
}

function byDayCols_()      { return [['Date', 'date']].concat(COLUMNS.slice(2)); }
function campaignDayCols_(){ return [['Date', 'date'], ['Campaign', 'campaign'], ['Channel', 'channel']].concat(COLUMNS.slice(2)); }

// Generic writer for a record-based grid (Campaigns / Today).
function writeGrid_(name, cols, recs, periodText, pinFirst) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clearContents();
  var header = cols.map(function (c) { return c[0]; });
  headerRow_(sheet, header);
  if (!recs.length) { sheet.getRange(2, 1).setValue('No rows for ' + periodText + '.'); stamp_(sheet, header.length, periodText); return; }
  var body = recs.map(function (r) { return recordToRow_(r, cols); });
  sheet.getRange(2, 1, body.length, header.length).setValues(body);
  applyFormats_(sheet, cols, 2, body.length);
  if (pinFirst) sheet.getRange(2, 1, 1, header.length).setFontWeight('bold').setBackground('#eef2f9');
  sheet.autoResizeColumns(1, header.length);
  stamp_(sheet, header.length, periodText);
}

// Generic writer for a pre-built 2D grid (By Day / By Day - Campaign / OpenAI).
// Column 1 is always Date on these tabs, and it is written as a REAL date value
// (not text) so downstream IMPORTRANGE + SUMIFS date comparisons work. (The
// hidden _store keeps text date keys — that's separate and internal.)
function writeRows_(name, cols, rows2d, periodText, pinFirst) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  var f = sheet.getFilter(); if (f) f.remove();
  sheet.clearContents();
  var header = cols.map(function (c) { return c[0]; });
  headerRow_(sheet, header);
  if (name === CAMPAIGN_DAY_SHEET) sheet.setFrozenColumns(2);
  if (!rows2d.length) { sheet.getRange(2, 1).setValue('No data.'); stamp_(sheet, header.length, periodText); return; }
  var body = rows2d.map(function (r) { var c = r.slice(); c[0] = parseYmd_(c[0]); return c; });
  sheet.getRange(2, 1, body.length, header.length).setValues(body);
  applyFormats_(sheet, cols, 2, body.length);
  sheet.getRange(2, 1, body.length, 1).setNumberFormat('yyyy-mm-dd');   // real dates
  // autoResize is slow on huge tabs — only for modest ones.
  if (body.length <= 2000) sheet.autoResizeColumns(1, header.length);
  if (name === CAMPAIGN_DAY_SHEET) sheet.getRange(1, 1, body.length + 1, header.length).createFilter();
  stamp_(sheet, header.length, periodText);
}

function adsLabel_() { return 'Google + Microsoft'; }

// ============================== HTTP =======================================

function postSql_(body, attempt) {
  attempt = attempt || 0;
  var res = UrlFetchApp.fetch(SQL_ENDPOINT, {
    method: 'post', contentType: 'application/json',
    headers: { 'x-api-key': getApiKey_() },
    payload: JSON.stringify(body), muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code === 429) {
    if (attempt >= 5) throw new Error('TW SQL API 429: still rate limited after ' + (attempt + 1) + ' attempts.');
    Utilities.sleep((parseInt(res.getHeaders()['Retry-After'] || '10', 10) + 1) * 1000);
    return postSql_(body, attempt + 1);
  }
  if (code === 400 && /timeout/i.test(text) && attempt < 2) {
    Utilities.sleep(3000);
    return postSql_(body, attempt + 1);
  }
  if (code !== 200) throw new Error('TW SQL API ' + code + ': ' + text.slice(0, 600));
  return JSON.parse(text);
}

function extractRows_(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.data)) return json.data;
  return [];
}

// ============================== SLACK ======================================

// Aggregate store rows for a period into totals + per-channel spend split.
function totalsFromRows_(rows) {
  var byChan = {};
  rows.forEach(function (r) { byChan[r.channel] = (byChan[r.channel] || 0) + (Number(r.spend) || 0); });
  var g = sumComponents_(rows, {});
  return {
    spend: g.spend, pixelRev: g.order_revenue,
    roas: g.spend ? g.order_revenue / g.spend : 0, byChannel: byChan,
  };
}

function channelSplit_(byChan) {
  var keys = Object.keys(byChan).sort();
  if (!keys.length) return 'no channel rows';
  return keys.map(function (k) { return k + ' ' + money_(byChan[k]); }).join(' · ');
}

function money_(v) {
  var p = (Number(v) || 0).toFixed(2).split('.');
  p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return '$' + p.join('.');
}

function slackYesterday() {
  assertShop_();
  var y = dateStr_(-1);
  var days = readStore_();
  var rows = (days[y] || []).filter(function (r) { return isAds_(r.channel); });
  var t = totalsFromRows_(rows);
  postSlack_(':sunny: *Yesterday — ' + adsLabel_() + '*  (' + y + ')\n' +
    '• Spend: ' + money_(t.spend) + '   _(' + channelSplit_(t.byChannel) + ')_\n' +
    '• Pixel Revenue: ' + money_(t.pixelRev) + '\n' +
    '• ROAS: ' + t.roas.toFixed(2));
  progress_('Slack: sent yesterday summary.');
}

function slackToday() {
  assertShop_();
  var today = todayStr_();
  var rows = fetchDayRows_(today).filter(function (r) { return isAds_(r.channel); });   // live, partial
  var t = totalsFromRows_(rows);
  var now = Utilities.formatDate(new Date(), 'America/New_York', 'h:mm a');
  postSlack_(':bar_chart: *Today so far — ' + adsLabel_() + '*  (' + today + ', ' + now + ' ET)\n' +
    '• Spend: ' + money_(t.spend) + '   _(' + channelSplit_(t.byChannel) + ')_\n' +
    '• Pixel Revenue: ' + money_(t.pixelRev) + '\n' +
    '• ROAS: ' + t.roas.toFixed(2));
  progress_('Slack: sent today pacing.');
}

function getSlackWebhook_() {
  var url = PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_URL') || SLACK_WEBHOOK_URL;
  if (!url) throw new Error('Set Script Property "SLACK_WEBHOOK_URL".');
  return url;
}

function postSlack_(text) {
  var res = UrlFetchApp.fetch(getSlackWebhook_(), {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ text: text }), muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Slack post failed ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  }
}

// ============================== AUTOMATION =================================
// One daily sync (which also drives the backfill until it's caught up), plus the
// Slack sends. Idempotent — running it repeatedly converges rather than stacking.

var MANAGED_HANDLERS = ['sync', 'resumeSync', 'fullResync', 'slackYesterday', 'slackToday'];

// Trigger handlers from the OLD version of this script. Their functions no
// longer exist, so any leftover trigger for them fails on every run (and emails
// a failure notice). ensureAutomation() and removeAllAutomation() purge these.
var LEGACY_HANDLERS = ['refreshAll', 'pullAttributed', 'pullToday', 'pullYesterday',
  'pullByDay', 'pullByDayRecent', 'pullByDayOpenAI', 'pullByDayOpenAIRecent',
  'pullCampaignByDay', 'pullCampaignByDayRecent', 'pullCampaignByDayFull',
  'backfillCampaignByDay'];
var RESUME_HANDLER   = 'resumeSync';   // distinct handler so we never delete the daily 'sync'

function automationPlan_() {
  return [
    { fn: 'sync',          count: 1, build: function () { ScriptApp.newTrigger('sync').timeBased().everyDays(1).atHour(6).create(); } },
    { fn: 'slackYesterday',count: 1, build: function () { ScriptApp.newTrigger('slackYesterday').timeBased().everyDays(1).atHour(8).create(); } },
    { fn: 'slackToday',    count: 3, build: function () { [11, 13, 16].forEach(function (h) { ScriptApp.newTrigger('slackToday').timeBased().everyDays(1).atHour(h).create(); }); } },
  ];
}

function setupAutomation() {
  var report = ensureAutomation(true);
  SpreadsheetApp.getUi().alert('Automation\n\n' + report.join('\n'));
}

function ensureAutomation(verbose) {
  var report = [];
  var existing = {};
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    (existing[f] = existing[f] || []).push(t);
  });
  // Purge leftover triggers from the OLD script (missing functions failing hourly).
  var purged = 0;
  (ScriptApp.getProjectTriggers()).forEach(function (t) {
    if (LEGACY_HANDLERS.indexOf(t.getHandlerFunction()) !== -1) { ScriptApp.deleteTrigger(t); purged++; }
  });
  if (purged) report.push('🧹 removed ' + purged + ' leftover trigger(s) from the old script');

  automationPlan_().forEach(function (w) {
    var have = (existing[w.fn] || []).length;
    if (have === w.count) { report.push('✓ ' + w.fn + ' — ok'); return; }
    (existing[w.fn] || []).forEach(function (t) { ScriptApp.deleteTrigger(t); });
    w.build();
    report.push('↻ ' + w.fn + ' — rebuilt (' + have + ' → ' + w.count + ')');
  });

  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(PROP_DATA_START) === 'true') {
    report.push('✓ backfill — complete (oldest ' + (props.getProperty(PROP_OLDEST) || '?') + ')');
  } else {
    report.push('… backfill — not complete yet; the daily sync keeps extending it.');
  }

  var tz = tz_();
  if (tz !== 'America/New_York') {
    report.push('⚠ project time zone is ' + tz + ' — set it to America/New_York (Project Settings) ' +
      'or Slack sends and day boundaries will be off.');
  }
  report.forEach(function (l) { console.log(l); });
  if (verbose !== true) progress_('Weekly automation check: ' + report.length + ' item(s) — see the log.');
  return report;
}

function automationStatus() {
  var props = PropertiesService.getScriptProperties();
  var lines = ['Project time zone: ' + tz_(), ''];
  var triggers = ScriptApp.getProjectTriggers();
  if (!triggers.length) lines.push('No triggers installed. Run "Set up / repair automation".');
  else {
    var byFn = {};
    triggers.forEach(function (t) { var f = t.getHandlerFunction(); byFn[f] = (byFn[f] || 0) + 1; });
    Object.keys(byFn).sort().forEach(function (f) {
      lines.push(byFn[f] + ' × ' + f + (MANAGED_HANDLERS.indexOf(f) === -1 ? '   (not managed here)' : ''));
    });
  }
  lines.push('', 'Backfill oldest: ' + (props.getProperty(PROP_OLDEST) || '(none yet)'),
    'Start of data reached: ' + (props.getProperty(PROP_DATA_START) === 'true' ? 'yes' : 'no'));
  SpreadsheetApp.getUi().alert('Automation status\n\n' + lines.join('\n'));
}

function removeAllAutomation() {
  var ui = SpreadsheetApp.getUi();
  if (ui.alert('Remove all automation?', 'Deletes the sync + Slack triggers. Sheet data is untouched.',
      ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (MANAGED_HANDLERS.indexOf(f) !== -1 || LEGACY_HANDLERS.indexOf(f) !== -1) { ScriptApp.deleteTrigger(t); n++; }
  });
  ui.alert('Removed ' + n + ' trigger(s).');
}

// Trigger target for the transient "resume soon" one-shot (its own handler so
// clearing it can never touch the daily 'sync' trigger).
function resumeSync() { sync(); }

// One-shot "resume soon" trigger used only while the backfill is mid-flight.
function scheduleResume_() {
  clearResumeTriggers_();                 // clear the fired-but-lingering one first
  ScriptApp.newTrigger(RESUME_HANDLER).timeBased().after(60 * 1000).create();
}
function clearResumeTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === RESUME_HANDLER) ScriptApp.deleteTrigger(t);
  });
}

// ============================== DIAGNOSTICS ================================

function validateKey() {
  var res = UrlFetchApp.fetch(WHOAMI, { method: 'get', headers: { 'x-api-key': getApiKey_() }, muteHttpExceptions: true });
  SpreadsheetApp.getUi().alert('API key check:\n\nHTTP ' + res.getResponseCode() + '\n' + res.getContentText().slice(0, 400));
}

// List channel + provider_id values so you can set ADS_CHANNELS / OPENAI_CHANNELS.
function listChannels() {
  assertShop_();
  var q = "SELECT * FROM pixel_joined_tvf() WHERE event_date BETWEEN @startDate AND @endDate AND spend > 0 LIMIT 2000";
  var rows = extractRows_(postSql_({ shopId: SHOP_ID, currency: CURRENCY, query: q,
    period: { startDate: dateStr_(-14), endDate: dateStr_(-1) } }));
  var counts = {};
  rows.forEach(function (r) {
    var k = (r.channel || '(blank)') + '  |  provider_id: ' + (r.provider_id || '(blank)');
    counts[k] = (counts[k] || 0) + 1;
  });
  var out = [['channel  |  provider_id', 'rows']];
  Object.keys(counts).sort().forEach(function (k) { out.push([k, counts[k]]); });
  dumpDiag_('_channels', out);
  SpreadsheetApp.getUi().alert('See the _channels tab — confirm the Microsoft/OpenAI ids.');
}

function diagnoseDayPrompt() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Diagnose a day', 'Enter a date (yyyy-MM-dd) to inspect revenue coverage:', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  diagnoseDay(r.getResponseText().trim());
}

// For one day: how much order_revenue sits on rows whose channel is in
// ADS_CHANNELS vs rows tagged only by provider_id vs neither. This is how you
// confirm the single-query fetch isn't missing (or over-counting) revenue.
function diagnoseDay(ds) {
  assertShop_();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ds)) { SpreadsheetApp.getUi().alert('Bad date: ' + ds); return; }
  var q = "SELECT * FROM pixel_joined_tvf() WHERE event_date BETWEEN @startDate AND @endDate" +
    " AND (order_revenue > 0 OR spend > 0)" + attrFilter_();
  var rows = extractRows_(postSql_({ shopId: SHOP_ID, currency: CURRENCY, query: q, period: { startDate: ds, endDate: ds } }));
  var bucket = {};   // label -> {rows, spend, revenue}
  rows.forEach(function (r) {
    var byChan = ADS_CHANNELS.indexOf(r.channel) !== -1 || OPENAI_CHANNELS.indexOf(r.channel) !== -1;
    var byProv = ADS_CHANNELS.indexOf(r.provider_id) !== -1 || OPENAI_CHANNELS.indexOf(r.provider_id) !== -1;
    var label = byChan ? ('channel=' + r.channel) : byProv ? ('provider_id=' + r.provider_id + ' (channel=' + (r.channel || 'blank') + ')') : 'OTHER (channel=' + (r.channel || 'blank') + ')';
    var b = bucket[label] || (bucket[label] = { rows: 0, spend: 0, revenue: 0 });
    b.rows++; b.spend += Number(r.spend) || 0; b.revenue += Number(r.order_revenue) || 0;
  });
  var out = [['bucket', 'rows', 'spend', 'order_revenue']];
  Object.keys(bucket).sort().forEach(function (k) { out.push([k, bucket[k].rows, bucket[k].spend, bucket[k].revenue]); });
  dumpDiag_('_diag_day', out);
  SpreadsheetApp.getUi().alert('See _diag_day for ' + ds + '. Revenue under OTHER is what a channel-only ' +
    'filter would miss; revenue under provider_id=… is what this script now captures that the old one dropped.');
}

function probeRevenuePrompt() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Probe revenue', 'Enter a date (yyyy-MM-dd) with known sales to locate the pixel revenue:', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  probeRevenue(r.getResponseText().trim());
}

// Definitive revenue probe for one day. Runs several WHERE variants and reports
// rows / summed spend / summed order_revenue / summed orders for each, so we can
// see (a) whether pixel revenue exists for the day at all, (b) whether the
// model/window filter is what's zeroing it out, and (c) which channel/provider/
// model tags the revenue rows actually carry. Also dumps the full column list of
// one revenue row next to one spend row so we can spot the real field names.
function probeRevenue(ds) {
  assertShop_();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ds)) { SpreadsheetApp.getUi().alert('Bad date: ' + ds); return; }
  var period = { startDate: ds, endDate: ds };
  var run = function (where) {
    var q = "SELECT * FROM pixel_joined_tvf() WHERE event_date BETWEEN @startDate AND @endDate " + where + " LIMIT 5000";
    return extractRows_(postSql_({ shopId: SHOP_ID, currency: CURRENCY, query: q, period: period }));
  };
  var summarize = function (label, rows) {
    var sp = 0, rv = 0, od = 0, tags = {};
    rows.forEach(function (r) {
      sp += Number(r.spend) || 0; rv += Number(r.order_revenue) || 0; od += Number(r.orders_quantity) || 0;
      if ((Number(r.order_revenue) || 0) > 0) {
        var k = [r.channel || 'blank', r.provider_id || 'blank', r.model || 'blank', r.attribution_window || 'blank'].join(' | ');
        tags[k] = (tags[k] || 0) + 1;
      }
    });
    var sample = Object.keys(tags).slice(0, 8).map(function (k) { return k + ' ×' + tags[k]; }).join('   ;   ');
    return [label, rows.length, round2_(sp), round2_(rv), round2_(od), sample];
  };
  var inAds = sqlList_(ADS_CHANNELS);
  var matrix = [['query (event_date = ' + ds + ')', 'rows', 'sum spend', 'sum order_revenue', 'sum orders', 'revenue-row tags: channel|provider_id|model|attribution_window']];
  matrix.push(summarize('1. order_revenue>0  (no model filter)',        run('AND order_revenue > 0')));
  matrix.push(summarize('2. order_revenue>0  + model/window filter',    run('AND order_revenue > 0' + attrFilter_())));
  matrix.push(summarize('3. channel IN ads',                            run('AND channel IN ' + inAds)));
  matrix.push(summarize('4. channel IN ads  AND order_revenue>0',       run('AND channel IN ' + inAds + ' AND order_revenue > 0')));
  matrix.push(summarize('5. channel IN ads  + model/window filter',     run('AND channel IN ' + inAds + attrFilter_())));
  dumpDiag_('_probe_revenue', matrix);

  // Full columns: one revenue row vs one spend row.
  var revRow = run('AND order_revenue > 0')[0] || null;
  var spendRow = run('AND channel IN ' + inAds + ' AND spend > 0')[0] || null;
  var keys = {};
  [revRow, spendRow].forEach(function (r) { if (r) Object.keys(r).forEach(function (k) { keys[k] = 1; }); });
  var cols = [['column', 'revenue_row value', 'spend_row value']];
  Object.keys(keys).sort().forEach(function (k) {
    cols.push([k, revRow ? String(revRow[k]) : '(no revenue row)', spendRow ? String(spendRow[k]) : '(no spend row)']);
  });
  dumpDiag_('_probe_cols', cols);

  SpreadsheetApp.getUi().alert('Done. Send me the _probe_revenue and _probe_cols tabs.\n\n' +
    'Row 1 vs 2 shows whether the model filter zeroes revenue; rows 3–5 show whether ' +
    'channel-matched rows carry any revenue; _probe_cols shows the real column names.');
}

function round2_(v) { return Math.round((Number(v) || 0) * 100) / 100; }

function discoverPixel() {
  assertShop_();
  var q = "SELECT * FROM pixel_joined_tvf() WHERE event_date BETWEEN @startDate AND @endDate AND channel = 'google-ads' LIMIT 5";
  var data = extractRows_(postSql_({ shopId: SHOP_ID, currency: CURRENCY, query: q, period: { startDate: dateStr_(-7), endDate: dateStr_(-1) } }));
  if (!data.length) { dumpDiag_('_pixel_sample', [['no rows', '']]); return; }
  var out = [['column', 'sample_value']];
  Object.keys(data[0]).forEach(function (k) { out.push([k, String(data[0][k]).slice(0, 80)]); });
  dumpDiag_('_pixel_sample', out);
}

function backfillState() {
  var props = PropertiesService.getScriptProperties();
  var days = readStore_();
  var have = Object.keys(days).length;
  SpreadsheetApp.getUi().alert('Backfill state\n\n' +
    'Oldest covered: ' + (props.getProperty(PROP_OLDEST) || '(none)') + '\n' +
    'Start of data reached: ' + (props.getProperty(PROP_DATA_START) === 'true' ? 'yes' : 'no') + '\n' +
    'Days in store: ' + have);
}

function dumpDiag_(name, rows2d) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clearContents();
  sheet.getRange(1, 1, rows2d.length, rows2d[0].length).setValues(rows2d);
  sheet.autoResizeColumns(1, rows2d[0].length);
}

// ============================== HELPERS ====================================

function assertShop_() {
  if (!SHOP_ID || SHOP_ID === 'YOUR_SHOP.myshopify.com') {
    throw new Error('SHOP_ID is still the placeholder — set your real myshopify domain.');
  }
}

function getApiKey_() {
  var key = PropertiesService.getScriptProperties().getProperty('TW_API_KEY');
  if (!key) throw new Error('Set Script Property "TW_API_KEY".');
  return key;
}

function sqlList_(channels) {
  return '(' + channels.map(function (c) { return "'" + c + "'"; }).join(', ') + ')';
}

function tz_() { return Session.getScriptTimeZone(); }
function num_(v) { var x = Number(v); return isNaN(x) ? 0 : x; }
function todayStr_() { return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'); }

// A date string N days from today (N negative = past).
function dateStr_(offset) {
  var d = new Date(); d.setDate(d.getDate() + offset);
  return Utilities.formatDate(d, tz_(), 'yyyy-MM-dd');
}

// Add days to a 'yyyy-MM-dd' string (UTC math — safe for date-only keys).
function dateAdd_(ds, delta) {
  var p = ds.split('-');
  var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
  d.setUTCDate(d.getUTCDate() + delta);
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

// 'yyyy-MM-dd' -> a real Date (local midnight). Non-date / blank values pass
// through unchanged so header/placeholder cells aren't mangled.
function parseYmd_(s) {
  if (s instanceof Date) return s;
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : s;
}

// Whole days from a to b (both 'yyyy-MM-dd'); positive when b is later.
function daysBetween_(a, b) {
  var pa = a.split('-'), pb = b.split('-');
  var da = Date.UTC(+pa[0], +pa[1] - 1, +pa[2]);
  var db = Date.UTC(+pb[0], +pb[1] - 1, +pb[2]);
  return Math.round((db - da) / 86400000);
}

function datesDesc_(days) {
  return Object.keys(days).sort(function (a, b) { return a < b ? 1 : (a > b ? -1 : 0); });
}
function minKey_(days) {
  var ks = Object.keys(days); if (!ks.length) return null;
  return ks.sort()[0];
}

// Iterate every date in [from..to] newest-first, calling fn(dateStr).
function eachDateDesc_(from, to, fn) {
  var d = to;
  while (d >= from) { fn(d); d = dateAdd_(d, -1); }
}

var _statusLog = [];

function progress_(msg) {
  console.log(msg);
  try { SpreadsheetApp.getActiveSpreadsheet().toast(msg, 'Triple Whale', 8); } catch (e) {}
  try { setStatus_(msg); } catch (e) {}
}

// Persistent, live-updating status tab. Toasts vanish after a few seconds; this
// stays and refreshes in place, so a long rebuild's progress is visible in the
// sheet (and readable after the fact, including for automated runs).
function setStatus_(msg) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('_status') || ss.insertSheet('_status', 0);
  var ts = Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm:ss');
  _statusLog.unshift(ts + '   ' + msg);
  if (_statusLog.length > 50) _statusLog.length = 50;
  sheet.getRange(1, 1).setValue('Triple Whale — status').setFontWeight('bold').setFontSize(12);
  sheet.getRange(2, 1).setValue(msg);
  sheet.getRange(3, 1).setValue('as of ' + ts);
  sheet.getRange(5, 1).setValue('Recent activity (newest first):').setFontWeight('bold');
  sheet.getRange(6, 1, 55, 1).clearContent();
  var rows = _statusLog.map(function (l) { return [l]; });
  if (rows.length) sheet.getRange(6, 1, rows.length, 1).setValues(rows);
  SpreadsheetApp.flush();                        // push updates so they show live
}
