'use strict';

/* ============================================================
 * MarkyScan - scan every wallet in a Polymarket event and rank
 * them by profitability (7d / 30d / all-time).
 *
 * Uses only Polymarket public APIs (all CORS-enabled):
 *   gamma-api.polymarket.com     event/market metadata
 *   data-api.polymarket.com      holders + trades per market
 *   user-pnl-api.polymarket.com  per-wallet PnL time series
 * ============================================================ */

const GAMMA = 'https://gamma-api.polymarket.com';
const DATA = 'https://data-api.polymarket.com';
const PNL_API = 'https://user-pnl-api.polymarket.com';
const LB_API = 'https://lb-api.polymarket.com';

const TRADES_PAGE_SIZE = 500;
const ACTIVITY_PAGE_SIZE = 500;
const ACTIVITY_MAX_PAGES = 4; // bulk scans: up to 2,000 recent activity events per wallet
const DEEP_ACTIVITY_MAX_PAGES = 60; // on-demand "full history": up to 30,000 events
const DEAD_POSITION_PCT = -99; // open position down ≥99% = scored as a loss (anti win-rate gaming)
const MARKET_CONCURRENCY = 5;
const PNL_CONCURRENCY = 8;

const $ = (s) => document.querySelector(s);

const CATEGORY_LABELS = {
  sports: 'Sports', politics: 'Politics', crypto: 'Crypto', esports: 'Esports',
  'pop-culture': 'Pop culture', business: 'Business', economy: 'Economy', tech: 'Tech',
  science: 'Science', world: 'World', elections: 'Elections', geopolitics: 'Geopolitics',
};
const CAT_MARKETS_PER_EVENT = 12; // per event, keep category scans bounded (top by volume)

const MAX_BTC_MARKETS = 300; // hard cap per BTC time-frame scan
const SLUG_BATCH = 20; // gamma /events accepts repeated slug params - batch lookups

/** ET calendar parts for a unix ts (BTC hourly/daily slugs are ET-based). */
function etParts(ts) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', hour12: true,
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(ts * 1000)).map((x) => [x.type, x.value]));
  return { month: p.month.toLowerCase(), day: p.day, year: p.year, hour: p.hour, ap: p.dayPeriod.toLowerCase() };
}

const BTC_TIMEFRAMES = {
  '5m': { step: 300, label: '5-minute', slug: (ts) => `btc-updown-5m-${ts}` },
  '15m': { step: 900, label: '15-minute', slug: (ts) => `btc-updown-15m-${ts}` },
  '1h': {
    step: 3600, label: 'hourly',
    slug: (ts) => { const e = etParts(ts); return `bitcoin-up-or-down-${e.month}-${e.day}-${e.year}-${e.hour}${e.ap}-et`; },
  },
  '4h': { step: 14400, label: '4-hour', slug: (ts) => `btc-updown-4h-${ts}` },
  '1d': {
    step: 86400, label: 'daily',
    slug: (ts) => { const e = etParts(ts); return `bitcoin-up-or-down-on-${e.month}-${e.day}-${e.year}`; },
  },
};

const els = {
  input: $('#url-input'),
  mainTabs: $('#main-tabs'),
  panelEvent: $('#panel-event'),
  panelCategory: $('#panel-category'),
  panelBtc: $('#panel-btc'),
  categorySelect: $('#category-select'),
  catEventsN: $('#cat-events'),
  btcTf: $('#btc-tf'),
  btcHours: $('#btc-hours'),
  marketsDetails: $('#markets-details'),
  scanBtn: $('#scan-btn'),
  cancelBtn: $('#cancel-btn'),
  topN: $('#top-n'),
  maxViews: $('#max-views'),
  depth: $('#depth'),
  exRedD7: $('#ex-red-d7'),
  exRedD30: $('#ex-red-d30'),
  exRedAll: $('#ex-red-all'),
  minD7: $('#min-d7'),
  maxD7: $('#max-d7'),
  minD30: $('#min-d30'),
  maxD30: $('#max-d30'),
  minAll: $('#min-all'),
  maxAll: $('#max-all'),
  maxArb: $('#max-arb'),
  winMetrics: $('#win-metrics'),
  walletType: $('#wallet-type'),
  minRoi: $('#min-roi'),
  minWinRate: $('#min-winrate'),
  minAvgWin: $('#min-avgwin'),
  minPlRatio: $('#min-plratio'),
  headRow: $('#head-row'),
  status: $('#status'),
  statusText: $('#status-text'),
  progress: $('#progress-fill'),
  error: $('#error'),
  eventCard: $('#event-card'),
  eventIcon: $('#event-icon'),
  eventTitle: $('#event-title'),
  eventMeta: $('#event-meta'),
  marketsSummary: $('#markets-summary'),
  marketChips: $('#market-chips'),
  rerankBtn: $('#rerank-btn'),
  resultsCard: $('#results-card'),
  resultsBody: $('#results-body'),
  resultsCount: $('#results-count'),
  tabs: $('#tabs'),
  csvBtn: $('#csv-btn'),
  table: $('#results-table'),
};

const state = {
  running: false,
  cancelled: false,
  event: null,
  markets: [], // [{conditionId, question, closed, selected}]
  marketWallets: new Map(), // conditionId -> Map(addr -> {vol, trades, shares, name, img})
  pnlCache: new Map(), // addr -> {d7, d30, all} (numbers or null)
  statsCache: new Map(), // addr -> {views, trades, joinDate} or null
  hedgeCache: new Map(), // addr -> hedged-shares % (number) or null
  winCache: new Map(), // addr -> {volume, closedBets, winRate, avgWinPct} or null fields
  winMetricsOn: false, // were win metrics computed for the current rows?
  rows: [], // ranked result rows
  sortKey: 'd7',
  activeWindow: 'd7',
  mode: 'trades', // 'trades' | 'holders' - how wallets were discovered/ranked
  scanMode: 'event', // 'event' | 'category' - which main tab drives the scan
  betsSortMode: null, // null = auto from filters; 'pct' | 'usd' once the user picks
};

/* ---------------- fetch helpers ---------------- */

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    if (state.cancelled) throw new Error('cancelled');
    try {
      const resp = await fetch(url);
      if (resp.status === 429 || resp.status >= 500) {
        await sleep(800 * (i + 1) + Math.random() * 400);
        continue;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (e) {
      if (e.message === 'cancelled') throw e;
      if (i === tries - 1) {
        // last resort: public CORS proxy (in case a network/CORS hiccup)
        try {
          const resp = await fetch('https://corsproxy.io/?url=' + encodeURIComponent(url));
          if (resp.ok) return await resp.json();
        } catch (_) { /* ignore */ }
        return null;
      }
      await sleep(500 * (i + 1));
    }
  }
  return null;
}

/** Run tasks with limited concurrency. */
async function pool(items, limit, worker) {
  const queue = [...items.entries()];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      if (state.cancelled) return;
      const [idx, item] = queue.shift();
      await worker(item, idx);
    }
  });
  await Promise.all(runners);
}

/* ---------------- UI helpers ---------------- */

function setStatus(text, pct) {
  els.status.classList.remove('hidden');
  els.statusText.textContent = text;
  if (pct != null) els.progress.style.width = `${Math.min(100, pct)}%`;
}

function hideStatus() {
  els.status.classList.add('hidden');
  els.progress.style.width = '0%';
}

function showError(msg) {
  els.error.textContent = msg;
  els.error.classList.remove('hidden');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtUsd(n) {
  if (n == null || Number.isNaN(n)) return '-';
  const abs = Math.abs(n);
  const s =
    abs >= 1e6 ? (abs / 1e6).toFixed(2) + 'M' :
    abs >= 1e3 ? (abs / 1e3).toFixed(1) + 'K' :
    abs.toFixed(abs < 10 ? 2 : 0);
  return (n < 0 ? '-$' : '$') + s;
}

function shortAddr(a) {
  return a.slice(0, 6) + '…' + a.slice(-4);
}

function fmtCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

/* ---------------- input parsing ---------------- */

function parseInput(text) {
  const t = text.trim();
  if (!t) return null;

  // bare slug
  if (!t.includes('/') && /^[a-z0-9_-]+$/i.test(t)) return { type: 'auto', slug: t };

  // any polymarket.com URL: /event/<slug>, /market/<slug>, /<locale>/event/<slug>,
  // /sports/<league>/<slug>, /pt/sports/world-cup/<slug>, etc.
  let path;
  try {
    const url = new URL(t.startsWith('http') ? t : 'https://' + t);
    if (!/polymarket\.com$/i.test(url.hostname)) return null;
    path = url.pathname;
  } catch (_) {
    return null;
  }
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  const isMarket = segments.includes('market');
  const slug = segments[segments.length - 1]; // slug is always the last segment
  if (!/^[a-z0-9_-]+$/i.test(slug)) return null;
  return { type: isMarket ? 'market' : 'auto', slug };
}

/* ---------------- data loading ---------------- */

async function eventBySlug(slug) {
  const arr = await fetchJson(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`);
  return arr && arr[0] ? arr[0] : null;
}

async function loadEvent(parsed) {
  let event = null;

  if (parsed.type !== 'market') {
    event = await eventBySlug(parsed.slug);
  }
  if (!event) {
    // market link (or slug that isn't an event) → find its parent event so we
    // also grab sibling markets for the same game
    const arr = await fetchJson(`${GAMMA}/markets?slug=${encodeURIComponent(parsed.slug)}`);
    const market = arr && arr[0] ? arr[0] : null;
    if (market) {
      const parent = Array.isArray(market.events) && market.events[0];
      if (parent) {
        const evArr = await fetchJson(`${GAMMA}/events?id=${parent.id}`);
        if (evArr && evArr[0] && Array.isArray(evArr[0].markets)) event = evArr[0];
      }
      if (!event) {
        event = { title: market.question, icon: market.icon, slug: parsed.slug, markets: [market], volume: market.volumeNum };
      }
    }
  }
  if (!event) return null;

  // Sports games split props into a sibling "<slug>-more-markets" event
  // (spreads, over/under, both-teams-to-score, corners, etc.) - merge them in.
  const slug = event.slug || parsed.slug;
  const siblingSlug = slug.endsWith('-more-markets')
    ? slug.replace(/-more-markets$/, '')
    : slug + '-more-markets';
  event.scanEventIds = [event.id].filter(Boolean);
  const sibling = await eventBySlug(siblingSlug);
  if (sibling && Array.isArray(sibling.markets)) {
    // main game event first (title/icon), props appended after
    const primary = slug.endsWith('-more-markets') ? sibling : event;
    const secondary = primary === event ? sibling : event;
    const seen = new Set();
    const merged = [];
    for (const m of [...(primary.markets || []), ...(secondary.markets || [])]) {
      if (m.conditionId && !seen.has(m.conditionId)) {
        seen.add(m.conditionId);
        merged.push(m);
      }
    }
    event = { ...primary, markets: merged, scanEventIds: [primary.id, secondary.id].filter(Boolean) };
  }
  return event;
}

/** Category mode: pull the category's top open events (by 24h volume) and
 *  flatten their highest-volume markets into one event-shaped scan target. */
async function loadCategoryEvent() {
  const slug = els.categorySelect.value;
  const label = CATEGORY_LABELS[slug] || slug;
  const nEv = Math.min(30, Math.max(1, parseInt(els.catEventsN.value, 10) || 10));
  const evs = await fetchJson(
    `${GAMMA}/events?tag_slug=${encodeURIComponent(slug)}&closed=false&order=volume24hr&ascending=false&limit=${nEv}`
  );
  if (!Array.isArray(evs) || evs.length === 0) return null;

  const markets = [];
  for (const ev of evs) {
    const ms = (ev.markets || [])
      .filter((m) => m.conditionId)
      .sort((a, b) => (b.volumeNum || 0) - (a.volumeNum || 0))
      .slice(0, CAT_MARKETS_PER_EVENT);
    for (const m of ms) markets.push({ ...m, evTitle: ev.title || 'Event' });
  }
  return {
    title: `Top wallets - ${label}`,
    icon: evs[0].icon || evs[0].image,
    volume24h: evs.reduce((s, e) => s + (e.volume24hr || 0), 0),
    scanEventIds: evs.map((e) => e.id).filter(Boolean),
    markets,
    isCategory: true,
    eventCount: evs.length,
  };
}

/** BTC mode: enumerate every Bitcoin Up/Down market of one time-frame in the
 *  lookback window (slugs are deterministic - timestamps or ET dates), resolve
 *  them in batched gamma lookups, and flatten into one scan target. */
async function loadBtcEvent() {
  const tf = BTC_TIMEFRAMES[els.btcTf.value] || BTC_TIMEFRAMES['5m'];
  const hours = Math.min(720, Math.max(1, parseInt(els.btcHours.value, 10) || 24));
  const now = Math.floor(Date.now() / 1000);

  // period starts, newest (current, still-trading) first
  const slugs = [];
  const seen = new Set();
  let ts = Math.floor(now / tf.step) * tf.step;
  const oldest = now - hours * 3600;
  while (ts >= oldest - (tf.step === 86400 ? 86400 : 0) && slugs.length < MAX_BTC_MARKETS) {
    const s = tf.slug(ts);
    if (!seen.has(s)) { seen.add(s); slugs.push(s); }
    ts -= tf.step;
  }

  const events = [];
  const chunks = [];
  for (let i = 0; i < slugs.length; i += SLUG_BATCH) chunks.push(slugs.slice(i, i + SLUG_BATCH));
  let done = 0;
  await pool(chunks, 5, async (chunk) => {
    const qs = chunk.map((s) => `slug=${encodeURIComponent(s)}`).join('&');
    const arr = await fetchJson(`${GAMMA}/events?limit=${SLUG_BATCH}&${qs}`);
    if (Array.isArray(arr)) events.push(...arr);
    done++;
    setStatus(`Resolving ${tf.label} BTC markets… ${Math.min(done * SLUG_BATCH, slugs.length)}/${slugs.length}`, 2 + (done / chunks.length) * 3);
  });
  if (events.length === 0) return null;

  const markets = [];
  for (const ev of events) {
    for (const m of ev.markets || []) {
      if (!m.conditionId) continue;
      // "Bitcoin Up or Down - July 8, 8:05PM-8:10PM ET" → keep the time part
      const short = (ev.title || '').split(' - ')[1] || ev.title || 'Market';
      markets.push({ ...m, evTitle: short });
    }
  }
  return {
    title: `BTC Up or Down - ${tf.label} markets, last ${hours}h`,
    icon: events[0].icon || events[0].image,
    volume24h: events.reduce((s, e) => s + (Number(e.volume) || 0), 0),
    scanEventIds: [], // too many events for per-event position lookups (holders arb check inert)
    markets,
    isCategory: true, // reuse category-style meta/chips rendering
    isBtc: true,
    eventCount: events.length,
  };
}

/** Collect wallets active in one market.
 *  mode 'trades'  → recent trade history (paginated), tracks buy/sell stance
 *                   per outcome so we can detect arb/hedge behavior.
 *  mode 'holders' → top current holders of each outcome token. */
async function scanMarket(market, tradePages, mode) {
  const wallets = new Map();
  const touch = (addr, patch) => {
    let w = wallets.get(addr);
    if (!w) {
      w = { vol: 0, trades: 0, shares: 0, pos: 0, neg: 0, name: '', img: '' };
      wallets.set(addr, w);
    }
    if (patch.vol) w.vol += patch.vol;
    if (patch.trades) w.trades += patch.trades;
    if (patch.shares) w.shares += patch.shares;
    if (patch.pos) w.pos += patch.pos;
    if (patch.neg) w.neg += patch.neg;
    if (patch.name && !w.name) w.name = patch.name;
    if (patch.img && !w.img) w.img = patch.img;
  };

  if (mode === 'holders') {
    const holders = await fetchJson(`${DATA}/holders?market=${market.conditionId}&limit=100`);
    if (Array.isArray(holders)) {
      for (const tokenGroup of holders) {
        for (const h of tokenGroup.holders || []) {
          if (!h.proxyWallet) continue;
          touch(h.proxyWallet.toLowerCase(), {
            shares: h.amount || 0,
            name: h.name || h.pseudonym,
            img: h.profileImage,
          });
        }
      }
    }
    return wallets;
  }

  for (let page = 0; page < tradePages; page++) {
    if (state.cancelled) break;
    const trades = await fetchJson(
      `${DATA}/trades?market=${market.conditionId}&limit=${TRADES_PAGE_SIZE}&offset=${page * TRADES_PAGE_SIZE}`
    );
    if (!Array.isArray(trades) || trades.length === 0) break;
    for (const t of trades) {
      if (!t.proxyWallet) continue;
      // stance: buying outcome 0 ≡ selling outcome 1 → sign +1 / -1.
      // A wallet trading both signs in the same market is hedging/arbing
      // (e.g. Over AND Under 2.5, crypto Up AND Down).
      const sign =
        typeof t.outcomeIndex === 'number'
          ? (t.outcomeIndex === 0 ? 1 : -1) * (t.side === 'BUY' ? 1 : -1)
          : 0;
      touch(t.proxyWallet.toLowerCase(), {
        vol: (t.size || 0) * (t.price || 0),
        trades: 1,
        pos: sign > 0 ? 1 : 0,
        neg: sign < 0 ? 1 : 0,
        name: t.name || t.pseudonym,
        img: t.profileImage,
      });
    }
    if (trades.length < TRADES_PAGE_SIZE) break;
  }

  return wallets;
}

/** Fetch a wallet's profile stats (views, trades, join date). */
async function fetchWalletStats(addr) {
  if (state.statsCache.has(addr)) return state.statsCache.get(addr);
  const data = await fetchJson(`${DATA}/v1/user-stats?proxyAddress=${addr}`);
  const stats = data && typeof data.views === 'number' ? data : null;
  state.statsCache.set(addr, stats);
  return stats;
}

/** Holders mode: % of the wallet's shares in this event that are hedged,
 *  i.e. it holds BOTH outcomes of the same market (Over+Under, Up+Down…).
 *  Reads the wallet's own positions, so it isn't limited to top-100 lists. */
async function fetchWalletHedgePct(addr) {
  if (state.hedgeCache.has(addr)) return state.hedgeCache.get(addr);

  const eventIds = state.event?.scanEventIds || [];
  const positions = [];
  for (const id of eventIds) {
    const arr = await fetchJson(`${DATA}/positions?user=${addr}&eventId=${id}&limit=500`);
    if (Array.isArray(arr)) positions.push(...arr);
  }

  let pct = null;
  if (positions.length > 0) {
    const byMarket = new Map(); // conditionId -> [sizeOutcome0, sizeOutcome1]
    let total = 0;
    for (const p of positions) {
      const size = p.size || 0;
      total += size;
      const sides = byMarket.get(p.conditionId) || [0, 0];
      sides[p.outcomeIndex === 0 ? 0 : 1] += size;
      byMarket.set(p.conditionId, sides);
    }
    let hedged = 0;
    for (const [s0, s1] of byMarket.values()) hedged += 2 * Math.min(s0, s1);
    pct = total > 0 ? (hedged / total) * 100 : null;
  }
  state.hedgeCache.set(addr, pct);
  return pct;
}

/** Fetch a wallet's global PnL for the three windows. */
async function fetchWalletPnl(addr) {
  if (state.pnlCache.has(addr)) return state.pnlCache.get(addr);

  const series = async (interval, fidelity) => {
    const data = await fetchJson(
      `${PNL_API}/user-pnl?user_address=${addr}&interval=${interval}&fidelity=${fidelity}`
    );
    if (!Array.isArray(data) || data.length === 0) return null;
    return data;
  };

  const [w7, w30, wAll] = [
    await series('1w', '1h'),
    await series('1m', '1d'),
    await series('max', '1d'),
  ];

  const delta = (s) => (s ? s[s.length - 1].p - s[0].p : null);
  const result = {
    d7: delta(w7),
    d30: delta(w30),
    all: wAll ? wAll[wAll.length - 1].p : null, // cumulative series → last point = lifetime PnL
  };
  state.pnlCache.set(addr, result);
  return result;
}

/** Win metrics, reconstructed from the wallet's global trade/redeem history:
 *  - volume     lifetime traded USD (leaderboard API) → ROI = all-time PnL / volume
 *  - winRate    % of closed bets that ended profitable
 *  - avgWinPct  mean % return on the winning bets (500%+ ⇒ longshot hunter)
 *
 *  A "bet" = all activity in one market: cost = buys, proceeds = sells + redeems
 *  (REDEEM events carry no outcome, so market-level books are the reliable unit -
 *  this also nets out hedged wallets correctly). A bet is closed when it was fully
 *  traded out, redeemed, or is no longer among the wallet's open positions
 *  (resolved worthless). Still-open bets are ignored. History is capped at
 *  ACTIVITY_MAX_PAGES pages; with a truncated history, dangling positions are
 *  skipped instead of guessed. */
async function fetchWalletWinMetrics(addr, deep = false, onProgress = null) {
  const cached = state.winCache.get(addr);
  // a deep request only reuses the cache if it already covers the full history
  if (cached && (!deep || cached.complete)) return cached;

  const lb = await fetchJson(`${LB_API}/volume?window=all&limit=1&address=${addr}`);
  const volume = Array.isArray(lb) && lb[0] && typeof lb[0].amount === 'number' ? lb[0].amount : null;

  // walk history newest→oldest with an end-timestamp cursor (the offset param
  // is capped at 3,000 by the API; the cursor has no such limit)
  const maxPages = deep ? DEEP_ACTIVITY_MAX_PAGES : ACTIVITY_MAX_PAGES;
  const acts = [];
  const seenEv = new Set();
  let cursor = null;
  let exhausted = false;
  for (let p = 0; p < maxPages; p++) {
    if (state.cancelled) break;
    const page = await fetchJson(
      `${DATA}/activity?user=${addr}&limit=${ACTIVITY_PAGE_SIZE}` + (cursor != null ? `&end=${cursor}` : '')
    );
    if (!Array.isArray(page) || page.length === 0) {
      exhausted = true;
      break;
    }
    for (const a of page) {
      // the cursor is inclusive, so boundary events repeat across pages
      const k = `${a.type}|${a.transactionHash || ''}|${a.asset || ''}|${a.conditionId}|${a.timestamp}|${a.size}`;
      if (!seenEv.has(k)) {
        seenEv.add(k);
        acts.push(a);
      }
    }
    if (onProgress) onProgress(acts.length);
    if (page.length < ACTIVITY_PAGE_SIZE) {
      exhausted = true;
      break;
    }
    const oldest = page[page.length - 1].timestamp;
    cursor = oldest === cursor ? oldest - 1 : oldest; // same-second flood guard
  }
  const truncated = !exhausted;

  // markets the wallet currently holds a position in, with enough detail to
  // spot "decided but unclaimed" bets: dead losers held open to dodge the
  // win-rate hit, and resolved wins that just haven't been redeemed yet
  const posByMarket = new Map(); // conditionId -> {value, redeemable, allDead}
  const positions = await fetchJson(`${DATA}/positions?user=${addr}&limit=500`);
  if (Array.isArray(positions)) {
    for (const p of positions) {
      let m = posByMarket.get(p.conditionId);
      if (!m) {
        m = { value: 0, redeemable: false, allDead: true };
        posByMarket.set(p.conditionId, m);
      }
      m.value += p.currentValue || 0;
      if (p.redeemable) m.redeemable = true;
      if (!(typeof p.percentPnl === 'number' && p.percentPnl <= DEAD_POSITION_PCT)) m.allDead = false;
    }
  }

  const books = new Map(); // conditionId -> {cost, proceeds, shares, redeemed}
  const dirty = new Set(); // markets with split/merge/convert → cost basis unreliable
  for (const a of acts) {
    if (a.type !== 'TRADE' && a.type !== 'REDEEM') {
      if (a.conditionId) dirty.add(a.conditionId);
      continue;
    }
    let b = books.get(a.conditionId);
    if (!b) {
      b = { cost: 0, proceeds: 0, shares: 0, redeemed: false, oldest: null, title: '', eventSlug: '', ts: 0 };
      books.set(a.conditionId, b);
    }
    // acts stream newest→oldest, so the last event written is the oldest seen
    b.oldest = a;
    if (!b.title && a.title) b.title = a.title;
    if (!b.eventSlug && a.eventSlug) b.eventSlug = a.eventSlug;
    if (a.timestamp > b.ts) b.ts = a.timestamp;
    if (a.type === 'REDEEM') {
      b.proceeds += a.usdcSize || a.size || 0; // winning shares pay $1 each
      b.shares -= a.size || 0;
      b.redeemed = true;
    } else if (a.side === 'BUY') {
      b.cost += a.usdcSize || 0;
      b.shares += a.size || 0;
    } else {
      b.proceeds += a.usdcSize || 0;
      b.shares -= a.size || 0;
    }
  }

  let wins = 0, closed = 0, winPctSum = 0;
  let grossGain = 0, grossLoss = 0; // for the gain/loss (profit factor) ratio
  const bets = []; // closed bets kept for the per-trader detail view
  for (const [market, b] of books) {
    if (b.cost <= 0 || dirty.has(market)) continue;
    // guards against truncated history understating the cost basis:
    // negative net shares = we missed buys; and with a truncated window only
    // score markets whose oldest visible event is a BUY (position opened in-window)
    if (b.shares < -0.01) continue;
    if (truncated && !(b.oldest && b.oldest.type === 'TRADE' && b.oldest.side === 'BUY')) continue;
    const open = posByMarket.get(market);
    const exited = b.shares < 0.01; // fully sold/redeemed (hhedgers' dead side handled below)
    // resolved: a redeem happened, or the wallet no longer lists this market
    // among its open positions (leftover shares expired worthless)
    const resolved = b.redeemed || (!open && !truncated);
    // decided but unclaimed: still held, but either every position is ~worthless
    // (win-rate gaming: losers left open forever) or it's a resolved, redeemable win
    const decided = !!open && (open.allDead || open.redeemable);
    if (!exited && !resolved && !decided) continue; // genuinely open - not scored
    closed++;
    const residual = !exited && open ? open.value : 0; // ≈0 for dead, ≈$1/share for unclaimed wins
    const retPct = ((b.proceeds + residual - b.cost) / b.cost) * 100;
    if (retPct > 0) {
      wins++;
      winPctSum += retPct;
    }
    const profit = b.proceeds + residual - b.cost;
    if (profit > 0) grossGain += profit;
    else grossLoss += -profit;
    bets.push({
      title: b.title || 'Market',
      eventSlug: b.eventSlug,
      cost: b.cost,
      profit: b.proceeds + residual - b.cost,
      retPct,
      // note: losing positions in resolved markets are also flagged redeemable
      // (claimable for $0), so "win" needs actual residual value, not the flag
      status: b.redeemed
        ? 'redeemed'
        : exited
          ? 'traded out'
          : open
            ? (open.value > Math.max(1, 0.01 * b.cost) ? 'unclaimed win' : 'held at ~0')
            : 'expired',
      ts: b.ts,
    });
  }
  bets.sort((x, y) => y.retPct - x.retPct);
  // cap kept bets but preserve the extremes of BOTH sort orders (% and $),
  // or big wallets lose their losses / their big-$-small-% wins
  let kept = bets;
  if (bets.length > 200) {
    const pick = new Set([...bets.slice(0, 100), ...bets.slice(-100)]);
    const byProfit = [...bets].sort((x, y) => y.profit - x.profit);
    for (const b of [...byProfit.slice(0, 50), ...byProfit.slice(-50)]) pick.add(b);
    kept = [...pick];
  }

  const metrics = {
    volume,
    closedBets: closed,
    wonBets: wins,
    winRate: closed >= 3 ? (wins / closed) * 100 : null, // need a minimal sample
    avgWinPct: wins > 0 ? winPctSum / wins : null,
    grossGain,
    grossLoss,
    // gain/loss ratio (profit factor): 1.11 = gives back 90% of gains; ∞ = no losses yet
    plRatio: closed >= 3 ? (grossLoss > 0 ? grossGain / grossLoss : grossGain > 0 ? Infinity : null) : null,
    bets: kept,
    eventsScanned: acts.length,
    complete: exhausted, // pagination ended naturally → this IS the full history
  };
  state.winCache.set(addr, metrics);
  return metrics;
}

/* ---------------- main scan flow ---------------- */

async function runScan() {
  els.error.classList.add('hidden');
  let parsed = null;
  if (state.scanMode === 'event') {
    parsed = parseInput(els.input.value);
    if (!parsed) {
      showError('Please paste a valid Polymarket link, e.g. https://polymarket.com/event/some-event');
      return;
    }
  }

  state.running = true;
  state.cancelled = false;
  state.marketWallets.clear();
  state.rows = [];
  els.scanBtn.disabled = true;
  els.cancelBtn.classList.remove('hidden');
  els.resultsCard.classList.add('hidden');
  els.eventCard.classList.add('hidden');
  els.rerankBtn.classList.add('hidden');

  try {
    // 1. resolve scan target: one event, a category's top events, or a BTC time-frame series
    const isCat = state.scanMode === 'category';
    const isBtc = state.scanMode === 'btc';
    setStatus(
      isBtc ? 'Resolving BTC up/down markets…' : isCat ? 'Loading the category’s top events…' : 'Resolving event…',
      2
    );
    const event = isBtc ? await loadBtcEvent() : isCat ? await loadCategoryEvent() : await loadEvent(parsed);
    if (!event) {
      throw new Error(
        isBtc
          ? 'No BTC up/down markets found for this time-frame and lookback.'
          : isCat
            ? 'No open events found for this category right now.'
            : 'Event or market not found. Check the link and try again.'
      );
    }

    const markets = (event.markets || [])
      .filter((m) => m.conditionId)
      .map((m) => ({
        conditionId: m.conditionId,
        question: m.question || m.groupItemTitle || 'Market',
        closed: !!m.closed,
        selected: true,
        evTitle: m.evTitle || '',
      }));
    if (markets.length === 0) throw new Error('No tradable markets found in this event.');

    state.event = event;
    state.markets = markets;
    renderEvent();

    // 2. scan every market for wallets
    state.mode = els.depth.value === 'holders' ? 'holders' : 'trades';
    const tradePages = state.mode === 'holders' ? 0 : parseInt(els.depth.value, 10);
    let done = 0;
    await pool(markets, MARKET_CONCURRENCY, async (m) => {
      const wallets = await scanMarket(m, tradePages, state.mode);
      state.marketWallets.set(m.conditionId, wallets);
      done++;
      setStatus(
        `Scanning markets… ${done}/${markets.length}  (${m.question.slice(0, 60)})`,
        5 + (done / markets.length) * 35
      );
    });
    if (state.cancelled) throw new Error('cancelled');

    // 3. aggregate + rank by activity, then fetch PnL
    await rankAndFetchPnl();
    els.rerankBtn.classList.remove('hidden');
  } catch (e) {
    if (e.message !== 'cancelled') showError(e.message || 'Something went wrong.');
    hideStatus();
  } finally {
    state.running = false;
    els.scanBtn.disabled = false;
    els.cancelBtn.classList.add('hidden');
  }
}

function aggregateWallets() {
  const agg = new Map(); // addr -> {vol, trades, markets:Set, name, img}
  for (const m of state.markets) {
    if (!m.selected) continue;
    const wallets = state.marketWallets.get(m.conditionId);
    if (!wallets) continue;
    for (const [addr, w] of wallets) {
      let a = agg.get(addr);
      if (!a) {
        a = { vol: 0, trades: 0, shares: 0, opp: 0, markets: new Set(), name: '', img: '' };
        agg.set(addr, a);
      }
      a.vol += w.vol;
      a.trades += w.trades;
      a.shares += w.shares;
      // hedged pairs in this market: each pos/neg pair = 2 opposite-side trades
      a.opp += 2 * Math.min(w.pos, w.neg);
      a.markets.add(m.conditionId);
      if (w.name && !a.name) a.name = w.name;
      if (w.img && !a.img) a.img = w.img;
    }
  }
  return agg;
}

function readFilters() {
  const num = (el) => (el.value.trim() === '' ? null : parseFloat(el.value));
  const minRoi = num(els.minRoi);
  const minWinRate = num(els.minWinRate);
  const minAvgWin = num(els.minAvgWin);
  const minPlRatio = num(els.minPlRatio);
  return {
    maxViews: els.maxViews.value.trim() === '' ? null : Math.max(0, parseInt(els.maxViews.value, 10) || 0),
    exRed: { d7: els.exRedD7.checked, d30: els.exRedD30.checked, all: els.exRedAll.checked },
    bounds: {
      d7: { min: num(els.minD7), max: num(els.maxD7) },
      d30: { min: num(els.minD30), max: num(els.maxD30) },
      all: { min: num(els.minAll), max: num(els.maxAll) },
    },
    maxArb: num(els.maxArb),
    minRoi,
    minWinRate,
    minAvgWin,
    minPlRatio,
    // a threshold implies the metrics even if the checkbox is off
    winMetricsOn: els.winMetrics.checked || minRoi != null || minWinRate != null || minAvgWin != null || minPlRatio != null,
  };
}

/** Does this wallet's PnL pass the red-exclusions and min/max bounds?
 *  Windows with an active rule require a known (non-null) PnL. */
function pnlPasses(pnl, f) {
  for (const k of ['d7', 'd30', 'all']) {
    const v = pnl[k];
    const { min, max } = f.bounds[k];
    if (f.exRed[k] && (v == null || v < 0)) return false;
    if (min != null && (v == null || v < min)) return false;
    if (max != null && (v == null || v > max)) return false;
  }
  return true;
}

async function rankAndFetchPnl() {
  const agg = aggregateWallets();
  const topN = Math.min(1000, Math.max(5, parseInt(els.topN.value, 10) || 100));
  const f = readFilters();
  const pnlFilterOn =
    f.exRed.d7 || f.exRed.d30 || f.exRed.all ||
    Object.values(f.bounds).some((b) => b.min != null || b.max != null);
  const winFilterOn = f.minRoi != null || f.minWinRate != null || f.minAvgWin != null || f.minPlRatio != null;
  const anyFilter = f.maxViews != null || f.maxArb != null || pnlFilterOn || winFilterOn;
  state.winMetricsOn = f.winMetricsOn;

  // rank: traded USD volume (trades mode) or shares held (holders mode)
  const ranked = [...agg.entries()]
    .map(([addr, a]) => ({
      addr,
      ...a,
      score: state.mode === 'holders' ? a.shares : a.vol,
      arbPct: a.trades > 0 ? (a.opp / a.trades) * 100 : null,
    }))
    .sort((x, y) => y.score - x.score || y.trades - x.trades);

  // With filters on we walk further down the ranking, skipping rejected
  // wallets, until the quota is filled (checking up to 5× topN candidates).
  const candidates = ranked.slice(0, anyFilter ? Math.min(ranked.length, Math.max(topN * 5, 300)) : topN);

  setStatus(`Found ${agg.size.toLocaleString()} wallets - analyzing top ${Math.min(topN, candidates.length)}…`, 42);

  let accepted = 0;
  let skipped = 0;
  const rows = [];
  const progress = () => {
    setStatus(
      anyFilter
        ? `Analyzing wallets… ${accepted}/${topN} kept · ${skipped} skipped by filters`
        : `Analyzing wallet PnL… ${accepted}/${Math.min(topN, candidates.length)}`,
      42 + (accepted / Math.min(topN, candidates.length)) * 58
    );
  };

  await pool(candidates, PNL_CONCURRENCY, async (w) => {
    if (accepted >= topN) return; // quota already filled

    // 1. arb/hedger gate - trades mode: free (trade stances already counted)
    if (f.maxArb != null && w.arbPct != null && w.arbPct > f.maxArb) {
      skipped++;
      progress();
      return;
    }

    // 2. profile views gate - 1 cheap call before the 3 PnL calls
    const stats = await fetchWalletStats(w.addr);
    const views = stats ? stats.views : null;
    if (f.maxViews != null && (views == null || views > f.maxViews)) {
      skipped++;
      progress();
      return;
    }

    // 2b. arb/hedger gate - holders mode: check the wallet's own positions
    // for both-sides holdings in this event (1 call per wallet)
    if (state.mode === 'holders' && f.maxArb != null) {
      w.arbPct = await fetchWalletHedgePct(w.addr);
      if (w.arbPct != null && w.arbPct > f.maxArb) {
        skipped++;
        progress();
        return;
      }
    }

    // 3. PnL gates (red exclusions + min/max bounds)
    const pnl = await fetchWalletPnl(w.addr);
    if (pnlFilterOn && !pnlPasses(pnl, f)) {
      skipped++;
      progress();
      return;
    }

    // 4. win-metric gates (ROI / win rate / avg win %) - opt-in, extra calls
    let win = null;
    if (f.winMetricsOn) {
      win = await fetchWalletWinMetrics(w.addr);
      win.roi = win.volume > 0 && pnl.all != null ? (pnl.all / win.volume) * 100 : null;
      const rejected =
        (f.minRoi != null && (win.roi == null || win.roi < f.minRoi)) ||
        (f.minWinRate != null && (win.winRate == null || win.winRate < f.minWinRate)) ||
        (f.minAvgWin != null && (win.avgWinPct == null || win.avgWinPct < f.minAvgWin)) ||
        (f.minPlRatio != null && (win.plRatio == null || win.plRatio < f.minPlRatio));
      if (rejected) {
        skipped++;
        progress();
        return;
      }
    }

    if (accepted >= topN) return;
    accepted++;
    rows.push({
      addr: w.addr,
      name: w.name,
      img: w.img,
      vol: w.vol,
      trades: w.trades,
      shares: w.shares,
      arbPct: w.arbPct,
      markets: w.markets.size,
      views,
      d7: pnl.d7,
      d30: pnl.d30,
      all: pnl.all,
      roi: win ? win.roi : null,
      winRate: win ? win.winRate : null,
      avgWin: win ? win.avgWinPct : null,
      plRatio: win ? win.plRatio : null,
      closedBets: win ? win.closedBets : null,
    });
    progress();
  });
  if (state.cancelled) throw new Error('cancelled');

  state.rows = rows;
  hideStatus();
  renderResults();
}

/* ---------------- rendering ---------------- */

function renderEvent() {
  const ev = state.event;
  els.eventCard.classList.remove('hidden');
  els.eventTitle.textContent = ev.title || 'Event';
  if (ev.icon || ev.image) {
    els.eventIcon.src = ev.icon || ev.image;
    els.eventIcon.classList.remove('hidden');
  } else {
    els.eventIcon.classList.add('hidden');
  }
  els.marketsDetails.classList.toggle('hidden', !!ev.isBtc); // 100s of 5m chips = noise
  if (ev.isCategory) {
    const vol = ev.volume24h ? `$${Math.round(ev.volume24h).toLocaleString()} ${ev.isBtc ? '' : '24h '}volume · ` : '';
    els.eventMeta.textContent = `${vol}${ev.eventCount} ${ev.isBtc ? 'markets scanned' : 'events'}${ev.isBtc ? '' : ` · ${state.markets.length} markets`}`;
    els.marketsSummary.textContent = `Events scanned (${ev.eventCount}) - untick to exclude`;
  } else {
    const vol = ev.volume ? `$${Math.round(ev.volume).toLocaleString()} volume · ` : '';
    els.eventMeta.textContent = `${vol}${state.markets.length} market${state.markets.length === 1 ? '' : 's'}`;
    els.marketsSummary.textContent = `Markets in this event (${state.markets.length}) - untick to exclude`;
  }

  els.marketChips.innerHTML = '';
  if (ev.isBtc) return; // details section hidden - don't build hundreds of chips
  if (ev.isCategory) {
    // one chip per event; unticking excludes all of that event's markets
    const groups = new Map(); // evTitle -> [market idx]
    state.markets.forEach((m, i) => {
      if (!groups.has(m.evTitle)) groups.set(m.evTitle, []);
      groups.get(m.evTitle).push(i);
    });
    for (const [title, idxs] of groups) {
      const label = document.createElement('label');
      label.className = 'chip';
      label.innerHTML = `<input type="checkbox" checked />
        <span>${esc(title)} (${idxs.length})</span>`;
      label.querySelector('input').addEventListener('change', (e) => {
        for (const i of idxs) state.markets[i].selected = e.target.checked;
      });
      els.marketChips.appendChild(label);
    }
    return;
  }
  state.markets.forEach((m, i) => {
    const label = document.createElement('label');
    label.className = 'chip' + (m.closed ? ' closed' : '');
    label.innerHTML = `<input type="checkbox" ${m.selected ? 'checked' : ''} data-idx="${i}" />
      <span>${esc(m.question)}${m.closed ? ' (closed)' : ''}</span>`;
    label.querySelector('input').addEventListener('change', (e) => {
      state.markets[i].selected = e.target.checked;
    });
    els.marketChips.appendChild(label);
  });
}

function pnlCell(v) {
  if (v == null) return '<td class="num na">-</td>';
  const cls = v >= 0 ? 'pos' : 'neg';
  return `<td class="num ${cls}">${v >= 0 ? '+' : ''}${fmtUsd(v)}</td>`;
}

function pctCell(v, signed) {
  if (v == null) return '<td class="num na">-</td>';
  const cls = signed ? (v >= 0 ? 'pos' : 'neg') : '';
  const s = Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'K' : v.toFixed(Math.abs(v) < 10 ? 1 : 0);
  return `<td class="num ${cls}">${signed && v > 0 ? '+' : ''}${s}%</td>`;
}

function columnsForMode() {
  const common = [
    { key: 'd7', label: '7D PnL' },
    { key: 'd30', label: '30D PnL' },
    { key: 'all', label: 'All-time PnL' },
    ...(state.winMetricsOn
      ? [
          { key: 'roi', label: 'ROI %' },
          { key: 'winRate', label: 'Win %' },
          { key: 'avgWin', label: 'Avg win %' },
          { key: 'plRatio', label: 'G/L' },
        ]
      : []),
    { key: 'views', label: 'Views' },
  ];
  return state.mode === 'holders'
    ? [...common,
        { key: 'arbPct', label: 'Hedged %' },
        { key: 'shares', label: 'Shares held' },
        { key: 'markets', label: 'Markets' }]
    : [...common,
        { key: 'arbPct', label: 'Arb %' },
        { key: 'vol', label: 'Vol. in event' },
        { key: 'trades', label: 'Trades' },
        { key: 'markets', label: 'Markets' }];
}

function renderResults() {
  const key = state.sortKey;
  const cols = columnsForMode();
  if (!cols.some((c) => c.key === key)) state.sortKey = state.activeWindow; // mode switch reset
  const sortBy = state.sortKey;

  els.headRow.innerHTML =
    '<th class="rank-col">#</th><th class="trader-col">Trader</th>' +
    cols.map((c) => `<th class="num sortable" data-key="${c.key}">${c.label}</th>`).join('');

  const rows = [...state.rows].sort((a, b) => {
    const av = a[sortBy], bv = b[sortBy];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return bv - av;
  });

  const cell = (r, c) => {
    switch (c.key) {
      case 'd7': case 'd30': case 'all': return pnlCell(r[c.key]);
      case 'roi': return pctCell(r.roi, true);
      case 'winRate': return pctCell(r.winRate, false);
      case 'avgWin': return pctCell(r.avgWin, false);
      case 'plRatio':
        return r.plRatio == null
          ? '<td class="num na">-</td>'
          : `<td class="num ${r.plRatio < 1 ? 'neg' : ''}">${r.plRatio === Infinity ? '∞' : r.plRatio.toFixed(1) + '×'}</td>`;
      case 'views': return `<td class="num">${r.views == null ? '-' : fmtCount(r.views)}</td>`;
      case 'arbPct': return `<td class="num">${r.arbPct == null ? '-' : r.arbPct.toFixed(0) + '%'}</td>`;
      case 'vol': return `<td class="num">${fmtUsd(r.vol)}</td>`;
      case 'trades': return `<td class="num">${r.trades.toLocaleString()}</td>`;
      case 'shares': return `<td class="num">${fmtCount(Math.round(r.shares))}</td>`;
      case 'markets': return `<td class="num">${r.markets}</td>`;
      default: return '<td class="num">-</td>';
    }
  };

  els.resultsBody.innerHTML = rows
    .map((r, i) => {
      const display = r.name || shortAddr(r.addr);
      const avatar = r.img
        ? `<img class="avatar" src="${esc(r.img)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />`
        : `<span class="avatar placeholder" style="background:hsl(${(parseInt(r.addr.slice(2, 8), 16) % 360)},55%,45%)">${esc(display.slice(0, 2).toUpperCase())}</span>`;
      return `<tr>
        <td class="rank ${i < 3 ? 'top3' : ''}">${i + 1}</td>
        <td><div class="trader">
          <button class="expand-btn" data-addr="${r.addr}" title="Show this trader's relevant closed bets">▸</button>
          ${avatar}
          <a href="https://polymarket.com/profile/${r.addr}" target="_blank" rel="noopener">
            ${esc(display)}<span class="addr">${shortAddr(r.addr)}</span>
          </a></div></td>
        ${cols.map((c) => cell(r, c)).join('')}
      </tr>`;
    })
    .join('');

  els.resultsCount.textContent = `${rows.length} wallets`;
  els.resultsCard.classList.remove('hidden');

  // header sort indicators
  els.table.querySelectorAll('th.sortable').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.key === sortBy);
  });
}

/* ---------------- per-trader detail (closed bets) ---------------- */

/** Detail table for one trader: their closed bets, ordered by whatever the
 *  active filters care about - % return by default (longshot view), $ profit
 *  when only the ROI filter is set. */
function renderBets(win, addr) {
  const bets = win.bets || [];
  if (bets.length === 0) {
    return '<span class="muted">No scoreable closed bets in this wallet\'s recent history (last ~2,000 events; still-open and split/merge markets are excluded).</span>';
  }
  const f = readFilters();
  // explicit user choice wins; otherwise ROI-filter context implies the $ view
  const byDollar = state.betsSortMode
    ? state.betsSortMode === 'usd'
    : f.minRoi != null && f.minAvgWin == null;
  const wins = bets
    .filter((b) => b.retPct > 0)
    .sort((x, y) => (byDollar ? y.profit - x.profit : y.retPct - x.retPct))
    .slice(0, 10);
  const losses = bets
    .filter((b) => b.retPct <= 0)
    .sort((x, y) => (byDollar ? x.profit - y.profit : x.retPct - y.retPct))
    .slice(0, 5);

  const fmtWhen = (ts) =>
    ts ? new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) : '';
  const betRow = (b) => `<tr>
      <td class="bet-title">${
        b.eventSlug
          ? `<a href="https://polymarket.com/event/${esc(b.eventSlug)}" target="_blank" rel="noopener">${esc(b.title)}</a>`
          : esc(b.title)
      } <span class="badge ${b.status === 'held at ~0' ? 'bad' : b.retPct > 0 && (b.status === 'redeemed' || b.status === 'unclaimed win') ? '' : 'dim'}">${b.status}</span>
      <span class="bet-when">${fmtWhen(b.ts)}</span></td>
      <td class="num">${fmtUsd(b.cost)}</td>
      <td class="num ${b.profit >= 0 ? 'pos' : 'neg'}">${b.profit >= 0 ? '+' : ''}${fmtUsd(b.profit)}</td>
      <td class="num ${b.retPct >= 0 ? 'pos' : 'neg'}">${b.retPct >= 0 ? '+' : ''}${
        Math.abs(b.retPct) >= 1000 ? (b.retPct / 1000).toFixed(1) + 'K' : b.retPct.toFixed(0)
      }%</td>
    </tr>`;

  const section = (label, arr) =>
    arr.length
      ? `<div class="bets-label">${label}</div>
         <table class="bets-table">
           <thead><tr><th>Market</th><th class="num">Cost</th><th class="num">Profit</th><th class="num">Return</th></tr></thead>
           <tbody>${arr.map(betRow).join('')}</tbody>
         </table>`
      : '';

  const nWins = win.wonBets ?? bets.filter((b) => b.retPct > 0).length;
  const nBets = win.closedBets ?? bets.length;
  const gl =
    win.plRatio == null
      ? ''
      : ` · gained ${fmtUsd(win.grossGain)} / lost ${fmtUsd(win.grossLoss)} (${win.plRatio === Infinity ? '∞' : win.plRatio.toFixed(1) + '×'})`;
  const scope = win.complete
    ? `<span class="muted">full history · ${win.eventsScanned.toLocaleString()} events</span>`
    : `<button class="secondary small deep-btn" data-addr="${addr}">Load full history (last ${win.eventsScanned.toLocaleString()} events scanned - slower)</button>`;
  return `
    <div class="bets-head">
      <span class="muted bets-summary">${nBets.toLocaleString()} closed bets · ${nWins.toLocaleString()} won${gl}</span>
      <span class="bets-sort" role="group" aria-label="Sort bets by">
        <button class="bets-sort-btn ${byDollar ? '' : 'active'}" data-mode="pct" data-addr="${addr}">% return</button>
        <button class="bets-sort-btn ${byDollar ? 'active' : ''}" data-mode="usd" data-addr="${addr}">$ profit</button>
      </span>
    </div>
    ${section(byDollar ? 'Biggest wins ($)' : 'Biggest wins (%)', wins)}
    ${section(byDollar ? 'Worst losses ($)' : 'Worst losses (%)', losses)}
    <div class="bets-foot">${scope}</div>`;
}

els.resultsBody.addEventListener('click', async (e) => {
  const sortBtn = e.target.closest('.bets-sort-btn');
  if (sortBtn) {
    state.betsSortMode = sortBtn.dataset.mode; // remembered for every panel this session
    const win = state.winCache.get(sortBtn.dataset.addr);
    if (win) sortBtn.closest('td').innerHTML = renderBets(win, sortBtn.dataset.addr);
    return;
  }
  const deepBtn = e.target.closest('.deep-btn');
  if (deepBtn) {
    const cell = deepBtn.closest('td');
    const addr = deepBtn.dataset.addr;
    deepBtn.disabled = true;
    deepBtn.textContent = 'Loading full history…';
    try {
      const win = await fetchWalletWinMetrics(addr, true, (n) => {
        deepBtn.textContent = `Loading full history… ${n.toLocaleString()} events`;
      });
      state.winCache.set(addr, win);
      cell.innerHTML = renderBets(win, addr);
    } catch (_) {
      deepBtn.textContent = 'Failed - try again';
      deepBtn.disabled = false;
    }
    return;
  }
  const btn = e.target.closest('.expand-btn');
  if (!btn) return;
  const tr = btn.closest('tr');
  const next = tr.nextElementSibling;
  if (next && next.classList.contains('detail-row')) {
    next.remove();
    btn.classList.remove('open');
    return;
  }
  btn.classList.add('open');
  const detail = document.createElement('tr');
  detail.className = 'detail-row';
  detail.innerHTML = `<td colspan="${2 + columnsForMode().length}" class="detail-cell"><span class="muted">Loading trade history…</span></td>`;
  tr.after(detail);
  try {
    const win = await fetchWalletWinMetrics(btn.dataset.addr); // cached if already computed
    detail.firstElementChild.innerHTML = renderBets(win, btn.dataset.addr);
  } catch (_) {
    detail.firstElementChild.innerHTML = '<span class="muted">Failed to load trade history - try again.</span>';
  }
});

/* ---------------- CSV export ---------------- */

function exportCsv() {
  const key = state.sortKey;
  const rows = [...state.rows].sort((a, b) => (b[key] ?? -Infinity) - (a[key] ?? -Infinity));
  const lines = [
    'rank,address,name,pnl_7d,pnl_30d,pnl_all_time,roi_pct,win_rate_pct,avg_win_pct,gain_loss_ratio,closed_bets,profile_views,arb_pct,volume_in_event,trades_in_event,shares_held,markets_in_event,profile_url',
    ...rows.map((r, i) =>
      [
        i + 1,
        r.addr,
        `"${(r.name || '').replace(/"/g, '""')}"`,
        r.d7 ?? '',
        r.d30 ?? '',
        r.all ?? '',
        r.roi == null ? '' : r.roi.toFixed(1),
        r.winRate == null ? '' : r.winRate.toFixed(1),
        r.avgWin == null ? '' : r.avgWin.toFixed(1),
        r.plRatio == null ? '' : r.plRatio === Infinity ? 'inf' : r.plRatio.toFixed(2),
        r.closedBets ?? '',
        r.views ?? '',
        r.arbPct == null ? '' : r.arbPct.toFixed(1),
        r.vol.toFixed(2),
        r.trades,
        Math.round(r.shares),
        r.markets,
        `https://polymarket.com/profile/${r.addr}`,
      ].join(',')
    ),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'markyscan-wallets.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------------- events ---------------- */

els.mainTabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.main-tab');
  if (!btn || state.running || btn.dataset.mode === state.scanMode) return;
  state.scanMode = btn.dataset.mode;
  els.mainTabs.querySelectorAll('.main-tab').forEach((t) => t.classList.toggle('active', t === btn));
  els.panelEvent.classList.toggle('hidden', state.scanMode !== 'event');
  els.panelCategory.classList.toggle('hidden', state.scanMode !== 'category');
  els.panelBtc.classList.toggle('hidden', state.scanMode !== 'btc');
});

els.scanBtn.addEventListener('click', runScan);
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !state.running) runScan();
});
els.cancelBtn.addEventListener('click', () => {
  state.cancelled = true;
  setStatus('Cancelling…');
});

els.tabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  els.tabs.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  btn.classList.add('active');
  state.activeWindow = btn.dataset.window;
  state.sortKey = btn.dataset.window;
  renderResults();
});

els.table.querySelector('thead').addEventListener('click', (e) => {
  const th = e.target.closest('th.sortable');
  if (!th) return;
  state.sortKey = th.dataset.key;
  renderResults();
});

els.csvBtn.addEventListener('click', exportCsv);

// wallet-type presets just fill the win-metric thresholds (still editable)
els.walletType.addEventListener('change', (e) => {
  const presets = {
    longshot: { minAvgWin: 500 },
    grinder: { minWinRate: 70, minRoi: 0 },
    roi: { minRoi: 30 },
  };
  els.minRoi.value = '';
  els.minWinRate.value = '';
  els.minAvgWin.value = '';
  const p = presets[e.target.value];
  if (p) {
    if (p.minRoi != null) els.minRoi.value = p.minRoi;
    if (p.minWinRate != null) els.minWinRate.value = p.minWinRate;
    if (p.minAvgWin != null) els.minAvgWin.value = p.minAvgWin;
    els.winMetrics.checked = true;
  }
});

els.rerankBtn.addEventListener('click', async () => {
  if (state.running) return;
  state.running = true;
  state.cancelled = false;
  els.scanBtn.disabled = true;
  els.cancelBtn.classList.remove('hidden');
  try {
    await rankAndFetchPnl();
  } catch (e) {
    if (e.message !== 'cancelled') showError(e.message);
    hideStatus();
  } finally {
    state.running = false;
    els.scanBtn.disabled = false;
    els.cancelBtn.classList.add('hidden');
  }
});
