'use strict';

/* ============================================================
 * MarkyScan - scan every wallet in a Polymarket event and rank
 * them by profitability (7d / 30d / all-time).
 *
 * This file is the browser UI. All the scanning / ranking logic
 * lives in core.js (shared with the CLI in cli.js).
 * ============================================================ */

const {
  WALLET_PRESETS,
  parseAddresses,
  parseInput,
  fmtUsd,
  shortAddr,
  fmtCount,
  marketsFromEvent,
  aggregateWallets,
  pickBets,
  rowsToCsv,
  createScanner,
} = MarkyCore;

const $ = (s) => document.querySelector(s);

const els = {
  input: $('#url-input'),
  mainTabs: $('#main-tabs'),
  panelEvent: $('#panel-event'),
  panelCategory: $('#panel-category'),
  panelBtc: $('#panel-btc'),
  panelGamble: $('#panel-gamble'),
  degenBtn: $('#degen-btn'),
  panelCsv: $('#panel-csv'),
  csvText: $('#csv-text'),
  csvFile: $('#csv-file'),
  csvCount: $('#csv-count'),
  panelCopier: $('#panel-copier'),
  copierInput: $('#copier-input'),
  copierWindow: $('#copier-window'),
  copierTrades: $('#copier-trades'),
  categorySelect: $('#category-select'),
  catEventsN: $('#cat-events'),
  catWindow: $('#cat-window'),
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
  minTrades: $('#min-trades'),
  maxTrades: $('#max-trades'),
  minAge: $('#min-age'),
  maxAge: $('#max-age'),
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

const scanner = createScanner({ onStatus: setStatus });

const state = {
  running: false,
  event: null,
  markets: [], // [{conditionId, question, closed, selected}]
  marketWallets: new Map(), // conditionId -> Map(addr -> {vol, trades, shares, name, img})
  winMetricsOn: false, // were win metrics computed for the current rows?
  rows: [], // ranked result rows
  sortKey: 'd7',
  activeWindow: 'd7',
  mode: 'trades', // 'trades' | 'holders' | 'hybrid' | 'csv' | 'copier' - how wallets were discovered/ranked
  scanMode: 'category', // which main tab drives the scan (category is the default)
  betsSortMode: null, // null = auto from filters; 'pct' | 'usd' once the user picks
  degenRoll: false, // gamble tab: next roll digs outside the top 100 by volume
  csvAddrs: [], // wallet-list tab: addresses parsed from the pasted CSV/text
  copierStats: new Map(), // copier tab: addr -> {follows, before, markets, medDelay}
};

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
  if (state.scanMode === 'csv') {
    state.csvAddrs = parseAddresses(els.csvText.value);
    if (state.csvAddrs.length === 0) {
      showError('No wallet addresses found. Paste a CSV or a list containing 0x… addresses.');
      return;
    }
  }

  state.running = true;
  scanner.reset();
  state.marketWallets.clear();
  state.rows = [];
  els.scanBtn.disabled = true;
  els.cancelBtn.classList.remove('hidden');
  els.resultsCard.classList.add('hidden');
  els.eventCard.classList.add('hidden');
  els.rerankBtn.classList.add('hidden');

  try {
    // 1. resolve scan target. The wallet-list tab skips discovery entirely -
    // the addresses are the input, so it goes straight to analysis.
    if (state.scanMode === 'csv') {
      state.mode = 'csv';
      state.event = { title: 'Your wallet list', isCsv: true, walletCount: state.csvAddrs.length };
      state.markets = [];
      renderEvent();
      await rankAndFetchPnl();
      els.rerankBtn.classList.remove('hidden');
      return;
    }

    if (state.scanMode === 'copier') {
      state.mode = 'copier';
      const res = await scanner.loadCopierScan({
        wallet: els.copierInput.value,
        windowS: els.copierWindow.value,
        maxTrades: els.copierTrades.value,
      });
      if (!res) throw new Error('Paste a wallet address (0x…) or a Polymarket profile link.');
      if (res.empty) throw new Error('That wallet has no recent trades to analyse.');
      state.copierStats = res.stats;
      state.event = res;
      state.markets = [];
      renderEvent();
      if (state.copierStats.size === 0) {
        hideStatus();
        els.resultsCard.classList.add('hidden');
        showError('No repeat followers found - nobody appears to be copying this wallet.');
        return;
      }
      await rankAndFetchPnl();
      els.rerankBtn.classList.remove('hidden');
      return;
    }

    // one event, a category's top events, a BTC time-frame series, or a random roll
    const isCat = state.scanMode === 'category';
    const isBtc = state.scanMode === 'btc';
    const isGamble = state.scanMode === 'gamble';
    setStatus(
      isGamble ? 'Rolling the dice…'
        : isBtc ? 'Resolving BTC up/down markets…'
          : isCat ? 'Loading the category’s top events…'
            : 'Resolving event…',
      2
    );
    const event = isGamble
      ? await scanner.loadGambleEvent({ degen: state.degenRoll })
      : isBtc
        ? await scanner.loadBtcEvent({ tf: els.btcTf.value, hours: els.btcHours.value })
        : isCat
          ? await scanner.loadCategoryEvent({
              category: els.categorySelect.value,
              events: els.catEventsN.value,
              window: els.catWindow.value,
            })
          : await scanner.loadEvent(parsed);
    if (!event) {
      throw new Error(
        isGamble
          ? 'Bad roll - could not find a random market. Spin again.'
          : isBtc
            ? 'No BTC up/down markets found for this time-frame and lookback.'
            : isCat
              ? 'No open events found for this category right now.'
              : 'Event or market not found. Check the link and try again.'
      );
    }

    const markets = marketsFromEvent(event);
    if (markets.length === 0) throw new Error('No tradable markets found in this event.');

    state.event = event;
    state.markets = markets;
    renderEvent();

    // 2. scan every market for wallets
    const { mode, marketWallets } = await scanner.scanMarkets(markets, els.depth.value);
    state.mode = mode;
    state.marketWallets = marketWallets;

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

function readFilters() {
  const num = (el) => (el.value.trim() === '' ? null : parseFloat(el.value));
  return {
    maxViews: els.maxViews.value.trim() === '' ? null : Math.max(0, parseInt(els.maxViews.value, 10) || 0),
    exRed: { d7: els.exRedD7.checked, d30: els.exRedD30.checked, all: els.exRedAll.checked },
    bounds: {
      d7: { min: num(els.minD7), max: num(els.maxD7) },
      d30: { min: num(els.minD30), max: num(els.maxD30) },
      all: { min: num(els.minAll), max: num(els.maxAll) },
    },
    maxArb: num(els.maxArb),
    minTrades: num(els.minTrades),
    maxTrades: num(els.maxTrades),
    minAge: num(els.minAge),
    maxAge: num(els.maxAge),
    minRoi: num(els.minRoi),
    minWinRate: num(els.minWinRate),
    minAvgWin: num(els.minAvgWin),
    minPlRatio: num(els.minPlRatio),
    winMetrics: els.winMetrics.checked,
  };
}

async function rankAndFetchPnl() {
  const f = MarkyCore.normalizeFilters(readFilters());
  state.winMetricsOn = f.winMetricsOn;
  const agg = aggregateWallets({
    mode: state.mode,
    markets: state.markets,
    marketWallets: state.marketWallets,
    csvAddrs: state.csvAddrs,
    copierStats: state.copierStats,
  });
  state.rows = await scanner.rankWallets({
    agg,
    mode: state.mode,
    topN: els.topN.value,
    filters: f,
    eventIds: state.event?.scanEventIds || [],
    copierStats: state.copierStats,
  });
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
  els.marketsDetails.classList.toggle('hidden', !!ev.isBtc || !!ev.isCsv); // 100s of 5m chips = noise
  if (ev.isCsv) {
    els.eventIcon.classList.add('hidden');
    els.eventMeta.textContent = `${ev.walletCount.toLocaleString()} wallet${ev.walletCount === 1 ? '' : 's'} pasted`;
    els.marketChips.innerHTML = '';
    return;
  }
  if (ev.isCopier) {
    els.eventIcon.classList.add('hidden');
    const asym = ev.asymmetry === Infinity ? '∞' : ev.asymmetry.toFixed(1);
    els.eventMeta.textContent =
      `${ev.confident} likely copier${ev.confident === 1 ? '' : 's'} · ` +
      `${ev.candidates} repeat follower${ev.candidates === 1 ? '' : 's'} · ` +
      `${asym}× follow/lead ratio · ${ev.tradesChecked} trades across ${ev.marketsChecked} markets, ${ev.windowS}s window`;
    els.marketChips.innerHTML = '';
    return;
  }
  if (ev.isCategory) {
    const winLabel = ev.isBtc ? '' : `${ev.volLabel || '24h'} `;
    const vol = ev.volume24h ? `$${Math.round(ev.volume24h).toLocaleString()} ${winLabel}volume · ` : '';
    els.eventMeta.textContent = `${vol}${ev.eventCount} ${ev.isBtc ? 'markets scanned' : 'events'}${ev.isBtc ? '' : ` · ${state.markets.length} markets`}`;
    els.marketsSummary.textContent = `Events scanned (${ev.eventCount}) - untick to exclude`;
  } else {
    const roll = ev.gambleTag ? `${ev.degen ? 'DEGEN' : 'Random'} ${ev.gambleTag} roll · ` : '';
    const vol = ev.volume ? `$${Math.round(ev.volume).toLocaleString()} volume · ` : '';
    els.eventMeta.textContent = `${roll}${vol}${state.markets.length} market${state.markets.length === 1 ? '' : 's'}`;
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
    { key: 'lifeTrades', label: 'All trades' },
    { key: 'ageDays', label: 'Age' },
  ];
  if (state.mode === 'csv') return common; // no event context to report
  if (state.mode === 'copier') {
    return [
      { key: 'follows', label: 'Follows' },
      { key: 'leadBefore', label: 'Before' },
      { key: 'markets', label: 'Markets' },
      { key: 'medDelay', label: 'Delay' },
      ...common,
    ];
  }
  if (state.mode === 'holders') {
    return [...common,
      { key: 'arbPct', label: 'Hedged %' },
      { key: 'shares', label: 'Shares held' },
      { key: 'markets', label: 'Markets' }];
  }
  if (state.mode === 'hybrid') {
    return [...common,
      { key: 'arbPct', label: 'Arb %' },
      { key: 'vol', label: 'Vol. in event' },
      { key: 'trades', label: 'Trades' },
      { key: 'shares', label: 'Shares held' },
      { key: 'markets', label: 'Markets' }];
  }
  return [...common,
    { key: 'arbPct', label: 'Arb %' },
    { key: 'vol', label: 'Vol. in event' },
    { key: 'trades', label: 'Trades' },
    { key: 'markets', label: 'Markets' }];
}

function renderResults() {
  const cols = columnsForMode();
  // copier scans are about who follows most, not PnL, so default to that
  if (state.mode === 'copier' && !cols.some((c) => c.key === state.sortKey)) state.sortKey = 'follows';
  else if (state.mode === 'copier' && state.sortKey === state.activeWindow) state.sortKey = 'follows';
  const key = state.sortKey;
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
      case 'lifeTrades': return `<td class="num">${r.lifeTrades == null ? '-' : fmtCount(r.lifeTrades)}</td>`;
      case 'follows':
        return `<td class="num">${r.follows}${r.confident ? ' <span class="badge">copier</span>' : ''}</td>`;
      case 'leadBefore': return `<td class="num ${r.leadBefore > 0 ? 'na' : ''}">${r.leadBefore}</td>`;
      case 'medDelay': return `<td class="num">${r.medDelay == null ? '-' : r.medDelay + 's'}</td>`;
      case 'ageDays':
        return `<td class="num">${
          r.ageDays == null ? '-' : r.ageDays < 365 ? Math.round(r.ageDays) + 'd' : (r.ageDays / 365).toFixed(1) + 'y'
        }</td>`;
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
            ${esc(display)}${r.name ? `<span class="addr">${shortAddr(r.addr)}</span>` : ''}
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
  const { wins, losses } = pickBets(win, byDollar);

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
    : `<button class="secondary small deep-btn" data-addr="${addr}">${
        win.deepRan
          ? `Load 30,000 more (${win.eventsScanned.toLocaleString()} so far)`
          : `Load full history (last ${win.eventsScanned.toLocaleString()} events scanned - slower)`
      }</button>`;
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
    const win = scanner.state.winCache.get(sortBtn.dataset.addr);
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
      const win = await scanner.fetchWalletWinMetrics(addr, true, (n) => {
        deepBtn.textContent = `Loading full history… ${n.toLocaleString()} events`;
      });
      scanner.state.winCache.set(addr, win);
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
    const win = await scanner.fetchWalletWinMetrics(btn.dataset.addr); // cached if already computed
    detail.firstElementChild.innerHTML = renderBets(win, btn.dataset.addr);
  } catch (_) {
    detail.firstElementChild.innerHTML = '<span class="muted">Failed to load trade history - try again.</span>';
  }
});

/* ---------------- CSV export ---------------- */

function exportCsv() {
  const blob = new Blob([rowsToCsv(state.rows, state.sortKey)], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'markyscan-wallets.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------------- events ---------------- */

// Max depth is pointless on 5-minute BTC markets: they rarely exceed the
// normal trade window, and the extra holders lookups just slow the scan
function updateDepthAvailability() {
  const hybridOpt = els.depth.querySelector('option[value="hybrid"]');
  const disable = state.scanMode === 'btc' && els.btcTf.value === '5m';
  hybridOpt.disabled = disable;
  if (disable && els.depth.value === 'hybrid') els.depth.value = '2';
}

// info icons sit inside <label>s - without this, tapping one activates the
// label and focuses its input (mobile keyboard pops up) instead of the tooltip
document.querySelectorAll('.info').forEach((el) => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (document.activeElement === el) el.blur(); // second tap closes
    else el.focus();
  });
});

els.mainTabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.main-tab');
  if (!btn || state.running || btn.dataset.mode === state.scanMode) return;
  state.scanMode = btn.dataset.mode;
  els.mainTabs.querySelectorAll('.main-tab').forEach((t) => t.classList.toggle('active', t === btn));
  els.panelEvent.classList.toggle('hidden', state.scanMode !== 'event');
  els.panelCategory.classList.toggle('hidden', state.scanMode !== 'category');
  els.panelBtc.classList.toggle('hidden', state.scanMode !== 'btc');
  els.panelGamble.classList.toggle('hidden', state.scanMode !== 'gamble');
  els.panelCsv.classList.toggle('hidden', state.scanMode !== 'csv');
  els.panelCopier.classList.toggle('hidden', state.scanMode !== 'copier');
  // no market discovery in these modes, so its knobs do not apply
  const noDiscovery = state.scanMode === 'csv' || state.scanMode === 'copier';
  els.depth.closest('.option').classList.toggle('hidden', noDiscovery);
  els.topN.closest('.option').classList.toggle('hidden', state.scanMode === 'csv');
  updateDepthAvailability();
});

// wallet list: live address count + CSV file loading
function refreshCsvCount() {
  const n = parseAddresses(els.csvText.value).length;
  els.csvCount.textContent = n === 0 ? 'no addresses yet' : `${n.toLocaleString()} address${n === 1 ? '' : 'es'} found`;
}
els.csvText.addEventListener('input', refreshCsvCount);
els.csvFile.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    els.csvText.value = String(reader.result || '');
    refreshCsvCount();
  };
  reader.readAsText(file);
  e.target.value = ''; // let the same file be picked again
});

els.btcTf.addEventListener('change', updateDepthAvailability);

els.scanBtn.addEventListener('click', () => {
  state.degenRoll = false;
  runScan();
});
els.degenBtn.addEventListener('click', () => {
  if (state.running) return;
  state.degenRoll = true;
  runScan();
});
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !state.running) {
    state.degenRoll = false;
    runScan();
  }
});
els.cancelBtn.addEventListener('click', () => {
  scanner.cancel();
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
  els.minRoi.value = '';
  els.minWinRate.value = '';
  els.minAvgWin.value = '';
  const p = WALLET_PRESETS[e.target.value];
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
  scanner.reset();
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
