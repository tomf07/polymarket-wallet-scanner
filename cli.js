#!/usr/bin/env node
'use strict';

/* ============================================================
 * MarkyScan CLI - the same scans as the web app, in a terminal.
 * Runs on the shared engine in core.js. Node 18+, no dependencies.
 *
 *   node cli.js --help
 * ============================================================ */

const fs = require('fs');
const path = require('path');

const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  console.error(`MarkyScan needs Node 18 or newer (you have ${process.versions.node}).`);
  process.exit(1);
}
const { parseArgs } = require('util');
const core = require('./core.js');

const {
  CATEGORY_LABELS, BTC_TIMEFRAMES, WALLET_PRESETS,
  parseAddresses, parseInput, fmtUsd, shortAddr, fmtCount,
  marketsFromEvent, normalizeFilters, aggregateWallets, pickBets, rowsToCsv, createScanner,
} = core;

/* ---------------- help ---------------- */

const HELP = `MarkyScan - find the most profitable wallets on Polymarket

Usage
  markyscan <command> [target] [options]

Commands
  category <name>          Top open events of a category by volume
                           (sports, politics, crypto, esports, pop-culture, business,
                            economy, tech, science, world, elections, geopolitics)
  event <link|slug>        Every wallet in one event (all of its markets)
  btc                      Every Bitcoin Up-or-Down market of one time-frame
  random                   Roll a random market and scan it (wallet gambling)
  wallets [file|addr...]   Analyse your own list of wallets (CSV / text / stdin)
  copiers <wallet|link>    Find wallets that copy-trade a wallet
  bets <wallet|link>       Show one trader's biggest closed wins and worst losses

Target options
  --events <n>             category: how many events (1-30, default 10)
  --window <w>             category: rank events by 1h, 4h, 6h, 12h (measured live),
                           24h (default), 7d, 30d, 1y or all volume
  --tf <tf>                btc: 5m (default), 15m, 1h, 4h, 1d
  --hours <n>              btc: lookback in hours (1-720, default 24)
  --degen                  random: dig outside the top 100 events by volume
  --window <s>             copiers: seconds after a trade that counts as copying
                           (default 5)
  --trades <n>             copiers: how many of the wallet's recent trades to check
                           (default 40)
  --exclude <text>         skip markets/events whose title contains <text>
                           (repeatable, case-insensitive)
  --list-markets           print the markets that would be scanned and stop

Scan options
  --top <n>                wallets to return (5-100, default 100)
  --depth <d>              fast | normal (default) | deep | max | holders
                           fast/normal/deep = 500/1,000/2,000 trades per market,
                           max = all available trades + top holders,
                           holders = rank by position size

Filters (rejected wallets don't count toward --top)
  --max-views <n>          skip wallets with more profile views than this
  --exclude-red <w>        drop wallets with negative PnL in 7d, 30d and/or all
                           (comma separated, e.g. --exclude-red 7d,all)
  --min-7d / --max-7d <$>  PnL bounds per window, also --min-30d, --max-30d,
  --min-all / --max-all    (use --min-7d=-500 for negative values)
  --min-age / --max-age    wallet age in days (since first trade)
  --min-trades / --max-trades  lifetime trade count
  --max-arb <pct>          skip hedgers/arbers above this % of two-sided activity

Win metrics (slower - extra lookups per wallet)
  --win-metrics            compute ROI %, win rate, avg win %, gain/loss ratio
  --preset <p>             longshot (avg win >= 500%), grinder (win rate >= 70%,
                           ROI >= 0), roi (ROI >= 30%)
  --min-roi <pct>  --min-winrate <pct>  --min-avgwin <pct>  --min-gl <x>
                           any of these turns win metrics on

Output
  --sort <key>             7d (default), 30d, all, roi, winrate, avgwin, gl, views,
                           trades, age, arb, vol, event-trades, shares, markets,
                           follows, before, delay
  --csv <file>             write results as CSV (same columns as the web export);
                           use - for stdout
  --json                   print results as JSON
  --bets <n>               after the table, show receipts for the top n wallets
  --by <pct|usd>           order receipts by % return or $ profit
  --full                   load up to 30,000 history events per wallet instead
                           of the last ~2,000 (like the web app's "Load full
                           history" button)
  --max-events <n>         with --full, keep loading 30,000-event chunks until
                           n events are in (default 30000)
  --wide                   show full wallet addresses in the table
  --no-color               plain output (also honours NO_COLOR)
  -q, --quiet              no progress output
  -h, --help               this help

Examples
  markyscan category sports --events 5 --exclude-red all
  markyscan event https://polymarket.com/event/some-event --depth max --top 50
  markyscan btc --tf 15m --hours 48 --max-arb 20
  markyscan wallets list.csv --preset grinder --csv ranked.csv
  markyscan copiers 0xabc...123 --window 10
  markyscan bets 0xabc...123 --full --by usd
`;

/* ---------------- args ---------------- */

const OPTIONS = {
  events: { type: 'string' },
  window: { type: 'string' },
  tf: { type: 'string' },
  hours: { type: 'string' },
  degen: { type: 'boolean' },
  trades: { type: 'string' },
  exclude: { type: 'string', multiple: true },
  'list-markets': { type: 'boolean' },
  top: { type: 'string' },
  depth: { type: 'string' },
  'max-views': { type: 'string' },
  'exclude-red': { type: 'string', multiple: true },
  'min-7d': { type: 'string' }, 'max-7d': { type: 'string' },
  'min-30d': { type: 'string' }, 'max-30d': { type: 'string' },
  'min-all': { type: 'string' }, 'max-all': { type: 'string' },
  'min-age': { type: 'string' }, 'max-age': { type: 'string' },
  'min-trades': { type: 'string' }, 'max-trades': { type: 'string' },
  'max-arb': { type: 'string' },
  'win-metrics': { type: 'boolean' },
  preset: { type: 'string' },
  'min-roi': { type: 'string' },
  'min-winrate': { type: 'string' },
  'min-avgwin': { type: 'string' },
  'min-gl': { type: 'string' },
  sort: { type: 'string' },
  csv: { type: 'string' },
  json: { type: 'boolean' },
  bets: { type: 'string' },
  by: { type: 'string' },
  full: { type: 'boolean' },
  'max-events': { type: 'string' },
  wide: { type: 'boolean' },
  'no-color': { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  help: { type: 'boolean', short: 'h' },
};

const DEPTHS = { fast: '1', normal: '2', deep: '4', max: 'hybrid', holders: 'holders' };
const CAT_WINDOW_ARGS = {
  '1h': 'live1h', '4h': 'live4h', '6h': 'live6h', '12h': 'live12h',
  '24h': 'volume24hr', '1d': 'volume24hr', '7d': 'volume1wk', '1w': 'volume1wk',
  '30d': 'volume1mo', '1m': 'volume1mo', '1y': 'volume1yr', all: 'volume', 'all-time': 'volume',
};
const SORT_KEYS = {
  '7d': 'd7', '30d': 'd30', all: 'all', roi: 'roi', winrate: 'winRate', avgwin: 'avgWin', gl: 'plRatio',
  views: 'views', trades: 'lifeTrades', age: 'ageDays', arb: 'arbPct', hedged: 'arbPct', vol: 'vol',
  'event-trades': 'trades', shares: 'shares', markets: 'markets', follows: 'follows', before: 'leadBefore',
  delay: 'medDelay',
};
const COMMANDS = ['category', 'event', 'btc', 'random', 'wallets', 'copiers', 'bets'];

class UsageError extends Error {}

function num(v, name) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/[$,_%x×]/g, ''));
  if (Number.isNaN(n)) throw new UsageError(`--${name} expects a number, got "${v}"`);
  return n;
}

function buildFilters(o) {
  const red = new Set(
    (o['exclude-red'] || []).flatMap((s) => s.split(',')).map((s) => s.trim().toLowerCase()).filter(Boolean)
  );
  for (const w of red) {
    if (!['7d', '30d', 'all'].includes(w)) throw new UsageError(`--exclude-red takes 7d, 30d or all (got "${w}")`);
  }
  const f = {
    maxViews: o['max-views'] == null ? null : Math.max(0, Math.round(num(o['max-views'], 'max-views'))),
    exRed: { d7: red.has('7d'), d30: red.has('30d'), all: red.has('all') },
    bounds: {
      d7: { min: num(o['min-7d'], 'min-7d'), max: num(o['max-7d'], 'max-7d') },
      d30: { min: num(o['min-30d'], 'min-30d'), max: num(o['max-30d'], 'max-30d') },
      all: { min: num(o['min-all'], 'min-all'), max: num(o['max-all'], 'max-all') },
    },
    maxArb: num(o['max-arb'], 'max-arb'),
    minTrades: num(o['min-trades'], 'min-trades'),
    maxTrades: num(o['max-trades'], 'max-trades'),
    minAge: num(o['min-age'], 'min-age'),
    maxAge: num(o['max-age'], 'max-age'),
    minRoi: num(o['min-roi'], 'min-roi'),
    minWinRate: num(o['min-winrate'], 'min-winrate'),
    minAvgWin: num(o['min-avgwin'], 'min-avgwin'),
    minPlRatio: num(o['min-gl'], 'min-gl'),
    winMetrics: !!o['win-metrics'],
  };
  if (o.preset) {
    const p = WALLET_PRESETS[o.preset.toLowerCase()];
    if (!p) throw new UsageError(`unknown --preset "${o.preset}" (longshot, grinder, roi)`);
    // presets fill the thresholds; anything typed explicitly wins
    for (const [k, v] of Object.entries(p)) if (f[k] == null) f[k] = v;
    f.winMetrics = true;
  }
  return normalizeFilters(f);
}

/* ---------------- terminal output ---------------- */

const useColor =
  !process.argv.includes('--no-color') && !('NO_COLOR' in process.env) && process.stdout.isTTY;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = { green: paint('32'), red: paint('31'), dim: paint('2'), bold: paint('1'), cyan: paint('36'), yellow: paint('33') };
const visLen = (s) => [...String(s).replace(/\x1b\[[0-9;]*m/g, '')].length;
const padL = (s, n) => ' '.repeat(Math.max(0, n - visLen(s))) + s;
const padR = (s, n) => s + ' '.repeat(Math.max(0, n - visLen(s)));
function trunc(s, n) {
  const chars = [...String(s)];
  return chars.length > n ? chars.slice(0, Math.max(1, n - 1)).join('') + '…' : chars.join('');
}
const termWidth = () => process.stdout.columns || 140;

let quiet = false;
let lastStatusLen = 0;
function status(text) {
  if (quiet || !process.stderr.isTTY) return;
  const line = trunc(text, (process.stderr.columns || 100) - 1);
  process.stderr.write('\r' + line + ' '.repeat(Math.max(0, lastStatusLen - visLen(line))));
  lastStatusLen = visLen(line);
}
function clearStatus() {
  if (lastStatusLen && process.stderr.isTTY) process.stderr.write('\r' + ' '.repeat(lastStatusLen) + '\r');
  lastStatusLen = 0;
}
function note(text) {
  if (quiet) return;
  clearStatus();
  process.stderr.write(text + '\n');
}

const signedUsd = (v) => (v == null ? c.dim('-') : v >= 0 ? c.green('+' + fmtUsd(v)) : c.red(fmtUsd(v)));
function pct(v, signed) {
  if (v == null) return c.dim('-');
  const s = (Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'K' : v.toFixed(Math.abs(v) < 10 ? 1 : 0)) + '%';
  if (!signed) return s;
  return v >= 0 ? c.green((v > 0 ? '+' : '') + s) : c.red(s);
}
const fmtAge = (d) => (d == null ? c.dim('-') : d < 365 ? Math.round(d) + 'd' : (d / 365).toFixed(1) + 'y');

/** Same column sets as the web table, per discovery mode. */
function columnsForMode(mode, winMetricsOn) {
  const common = [
    { key: 'd7', label: '7D PnL', fmt: (r) => signedUsd(r.d7) },
    { key: 'd30', label: '30D PnL', fmt: (r) => signedUsd(r.d30) },
    { key: 'all', label: 'All-time', fmt: (r) => signedUsd(r.all) },
    ...(winMetricsOn
      ? [
          { key: 'roi', label: 'ROI', fmt: (r) => pct(r.roi, true) },
          { key: 'winRate', label: 'Win', fmt: (r) => pct(r.winRate) },
          { key: 'avgWin', label: 'Avg win', fmt: (r) => pct(r.avgWin) },
          {
            key: 'plRatio', label: 'G/L',
            fmt: (r) => r.plRatio == null ? c.dim('-')
              : r.plRatio === Infinity ? '∞'
                : r.plRatio < 1 ? c.red(r.plRatio.toFixed(1) + '×') : r.plRatio.toFixed(1) + '×',
          },
        ]
      : []),
    { key: 'views', label: 'Views', fmt: (r) => (r.views == null ? c.dim('-') : fmtCount(r.views)) },
    { key: 'lifeTrades', label: 'Trades', fmt: (r) => (r.lifeTrades == null ? c.dim('-') : fmtCount(r.lifeTrades)) },
    { key: 'ageDays', label: 'Age', fmt: (r) => fmtAge(r.ageDays) },
  ];
  const arb = (label) => ({ key: 'arbPct', label, fmt: (r) => (r.arbPct == null ? c.dim('-') : r.arbPct.toFixed(0) + '%') });
  const vol = { key: 'vol', label: 'Vol (evt)', fmt: (r) => fmtUsd(r.vol) };
  const trades = { key: 'trades', label: 'Trd (evt)', fmt: (r) => r.trades.toLocaleString() };
  const shares = { key: 'shares', label: 'Shares', fmt: (r) => fmtCount(Math.round(r.shares)) };
  const markets = { key: 'markets', label: 'Mkts', fmt: (r) => String(r.markets) };
  if (mode === 'csv') return common;
  if (mode === 'copier') {
    return [
      { key: 'follows', label: 'Follows', fmt: (r) => `${r.follows}${r.confident ? ' ' + c.yellow('★') : ''}` },
      { key: 'leadBefore', label: 'Before', fmt: (r) => (r.leadBefore > 0 ? c.dim(String(r.leadBefore)) : '0') },
      markets,
      { key: 'medDelay', label: 'Delay', fmt: (r) => (r.medDelay == null ? c.dim('-') : r.medDelay + 's') },
      ...common,
    ];
  }
  if (mode === 'holders') return [...common, arb('Hedged'), shares, markets];
  if (mode === 'hybrid') return [...common, arb('Arb'), vol, trades, shares, markets];
  return [...common, arb('Arb'), vol, trades, markets];
}

function sortRows(rows, key) {
  return [...rows].sort((a, b) => {
    const av = a[key], bv = b[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return bv - av;
  });
}

function printTable(rows, cols, { wide }) {
  const traderW = wide ? 62 : 32;
  const header = [padL('#', 3), padR('Trader', traderW), ...cols.map((col) => col.label)];
  const body = rows.map((r, i) => {
    const addr = wide ? r.addr : shortAddr(r.addr);
    const name = r.name ? trunc(r.name, traderW - visLen(addr) - 1) + ' ' + c.dim(addr) : addr;
    return [padL(String(i + 1), 3), padR(name, traderW), ...cols.map((col) => col.fmt(r))];
  });
  const widths = header.map((h, i) => Math.max(visLen(h), ...body.map((b) => visLen(b[i]))));
  const line = (cells) =>
    cells.map((cell, i) => (i === 1 ? padR(cell, widths[i]) : padL(cell, widths[i]))).join('  ');
  console.log(c.bold(line(header)));
  for (const b of body) console.log(line(b));
}

function fmtWhen(ts) {
  return ts ? new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) : '';
}

function printBets(win, row, byDollar, { addr }) {
  const who = row && row.name ? `${row.name} ${c.dim(addr)}` : addr;
  console.log('');
  console.log(c.bold(who) + '  ' + c.dim(`https://polymarket.com/profile/${addr}`));
  if (!win.bets || win.bets.length === 0) {
    console.log(c.dim('  No scoreable closed bets in this history (still-open and split/merge markets are excluded).'));
  }
  const gl = win.plRatio == null ? ''
    : ` · gained ${fmtUsd(win.grossGain)} / lost ${fmtUsd(win.grossLoss)} (${win.plRatio === Infinity ? '∞' : win.plRatio.toFixed(1) + '×'})`;
  const scope = win.complete
    ? `full history, ${win.eventsScanned.toLocaleString()} events`
    : win.deepRan
      ? `last ${win.eventsScanned.toLocaleString()} events - raise --max-events to go further back`
      : `last ${win.eventsScanned.toLocaleString()} events - add --full to go further back`;
  console.log(c.dim(`  ${win.closedBets.toLocaleString()} closed bets · ${win.wonBets.toLocaleString()} won${gl} · ${scope}`));
  const { wins, losses } = pickBets(win, byDollar);
  const titleW = Math.max(20, termWidth() - 52);
  const betLine = (b) => {
    const ret = (b.retPct >= 0 ? '+' : '') + (Math.abs(b.retPct) >= 1000 ? (b.retPct / 1000).toFixed(1) + 'K' : b.retPct.toFixed(0)) + '%';
    return '    ' + [
      padL(b.retPct >= 0 ? c.green(ret) : c.red(ret), 8),
      padL(b.profit >= 0 ? c.green('+' + fmtUsd(b.profit)) : c.red(fmtUsd(b.profit)), 9),
      padL(c.dim('cost ') + fmtUsd(b.cost), 13),
      padR(b.status === 'held at ~0' ? c.red(b.status) : c.dim(b.status), 14),
      padR(c.dim(fmtWhen(b.ts)), 10),
      trunc(b.title, titleW),
    ].join(' ');
  };
  const section = (label, arr) => {
    if (!arr.length) return;
    console.log('  ' + c.cyan(label));
    arr.forEach((b) => console.log(betLine(b)));
  };
  section(byDollar ? 'Biggest wins ($)' : 'Biggest wins (%)', wins);
  section(byDollar ? 'Worst losses ($)' : 'Worst losses (%)', losses);
}

/** Header lines describing what was scanned (the web app's event card). */
function describeEvent(ev, markets) {
  const lines = [c.bold(ev.title || 'Event')];
  if (ev.isCsv) {
    lines.push(`${ev.walletCount.toLocaleString()} wallet${ev.walletCount === 1 ? '' : 's'} in your list`);
  } else if (ev.isCopier) {
    const asym = ev.asymmetry === Infinity ? '∞' : ev.asymmetry.toFixed(1);
    lines.push(
      `${ev.confident} likely copier${ev.confident === 1 ? '' : 's'} · ` +
      `${ev.candidates} repeat follower${ev.candidates === 1 ? '' : 's'} · ` +
      `${asym}× follow/lead ratio · ${ev.tradesChecked} trades across ${ev.marketsChecked} markets, ${ev.windowS}s window`
    );
  } else if (ev.isCategory) {
    const winLabel = ev.isBtc ? '' : `${ev.volLabel || '24h'} `;
    const vol = ev.volume24h ? `$${Math.round(ev.volume24h).toLocaleString()} ${winLabel}volume · ` : '';
    lines.push(`${vol}${ev.eventCount} ${ev.isBtc ? 'markets scanned' : 'events'}${ev.isBtc ? '' : ` · ${markets.length} markets`}`);
  } else {
    const roll = ev.gambleTag ? `${ev.degen ? 'DEGEN' : 'Random'} ${ev.gambleTag} roll · ` : '';
    const vol = ev.volume ? `$${Math.round(ev.volume).toLocaleString()} volume · ` : '';
    lines.push(`${roll}${vol}${markets.length} market${markets.length === 1 ? '' : 's'}`);
  }
  return lines;
}

function printMarkets(ev, markets) {
  if (ev.isCategory && !ev.isBtc) {
    const groups = new Map();
    for (const m of markets) groups.set(m.evTitle, (groups.get(m.evTitle) || 0) + 1);
    for (const [title, n] of groups) console.log(`  ${title} ${c.dim(`(${n} markets)`)}`);
    return;
  }
  for (const m of markets) {
    const label = ev.isBtc ? `${m.evTitle} - ${m.question}` : m.question;
    console.log(`  ${label}${m.closed ? c.dim(' (closed)') : ''}`);
  }
}

/* ---------------- input helpers ---------------- */

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function walletListText(positionals) {
  const parts = [];
  for (const p of positionals) {
    if (p === '-') parts.push(await readStdin());
    else if (fs.existsSync(p) && fs.statSync(p).isFile()) parts.push(fs.readFileSync(p, 'utf8'));
    else parts.push(p);
  }
  if (positionals.length === 0 && !process.stdin.isTTY) parts.push(await readStdin());
  return parts.join('\n');
}

/** Win metrics for one wallet; with --full, keep resuming the deep walk
 *  until the history runs out or maxEvents is reached. */
async function loadHistory(scanner, addr, o) {
  let win = await scanner.fetchWalletWinMetrics(addr);
  const maxEvents = o['max-events'] == null ? 30000 : Math.max(1, num(o['max-events'], 'max-events'));
  while (o.full && !win.complete && !(win.deepRan && win.eventsScanned >= maxEvents) && !scanner.state.cancelled) {
    const before = win.eventsScanned;
    win = await scanner.fetchWalletWinMetrics(addr, true, (n) => status(`Loading history… ${n.toLocaleString()} events`));
    if (win.eventsScanned === before) break; // nothing new came back
  }
  return win;
}

function jsonReplacer(_, v) {
  if (v === Infinity) return 'inf';
  if (v instanceof Set) return [...v];
  if (v instanceof Map) return Object.fromEntries(v);
  return v;
}

/* ---------------- commands ---------------- */

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError(e.message);
  }
  const o = parsed.values;
  const [cmdIn, ...rest] = parsed.positionals;
  if (o.help || !cmdIn) {
    process.stdout.write(HELP);
    return;
  }
  const cmd = cmdIn.toLowerCase();
  if (!COMMANDS.includes(cmd)) throw new UsageError(`unknown command "${cmdIn}". Try: ${COMMANDS.join(', ')}`);
  quiet = !!o.quiet;

  const scanner = createScanner({ onStatus: (text) => status(text) });
  process.on('SIGINT', () => {
    scanner.cancel();
    clearStatus();
    process.stderr.write('Cancelled.\n');
    process.exit(130);
  });

  const filters = buildFilters(o);
  const sortArg = o.sort ? SORT_KEYS[o.sort.toLowerCase()] : null;
  if (o.sort && !sortArg) throw new UsageError(`unknown --sort "${o.sort}" (${Object.keys(SORT_KEYS).join(', ')})`);
  const byArg = o.by ? o.by.toLowerCase() : null;
  if (byArg && !['pct', 'usd', '%', '$'].includes(byArg)) throw new UsageError('--by takes pct or usd');
  // same default as the web app: ROI context implies the $ view
  const byDollar = byArg ? byArg === 'usd' || byArg === '$' : filters.minRoi != null && filters.minAvgWin == null;

  /* ----- bets: one trader's receipts ----- */
  if (cmd === 'bets') {
    const m = rest.join(' ').match(/0x[a-fA-F0-9]{40}/);
    if (!m) throw new UsageError('bets needs a wallet address (0x…) or a Polymarket profile link');
    const addr = m[0].toLowerCase();
    status('Loading trade history…');
    const win = await loadHistory(scanner, addr, o);
    clearStatus();
    if (o.json) {
      const { acts, ...out } = win;
      console.log(JSON.stringify({ address: addr, ...out }, jsonReplacer, 2));
      return;
    }
    const stats = await scanner.fetchWalletStats(addr);
    printBets(win, stats && stats.name ? { name: stats.name } : null, byDollar, { addr });
    return;
  }

  /* ----- resolve the scan target ----- */
  let event;
  let mode;
  let markets = [];
  let marketWallets = new Map();
  let csvAddrs = [];
  let copierStats = new Map();

  if (cmd === 'wallets') {
    csvAddrs = parseAddresses(await walletListText(rest));
    if (csvAddrs.length === 0) throw new UsageError('no wallet addresses found - pass a CSV file, addresses, or pipe a list in');
    mode = 'csv';
    event = { title: 'Your wallet list', isCsv: true, walletCount: csvAddrs.length };
  } else if (cmd === 'copiers') {
    mode = 'copier';
    const res = await scanner.loadCopierScan({
      wallet: rest.join(' '),
      windowS: o.window || 5,
      maxTrades: o.trades || 40,
    });
    if (!res) throw new UsageError('copiers needs a wallet address (0x…) or a Polymarket profile link');
    if (res.empty) throw new Error('That wallet has no recent trades to analyse.');
    copierStats = res.stats;
    event = res;
  } else {
    let depth = DEPTHS[(o.depth || 'normal').toLowerCase()];
    if (!depth) throw new UsageError(`unknown --depth "${o.depth}" (fast, normal, deep, max, holders)`);

    if (cmd === 'event') {
      const input = rest.join(' ');
      const target = parseInput(input);
      if (!target) throw new UsageError('event needs a Polymarket link or slug, e.g. https://polymarket.com/event/some-event');
      status('Resolving event…');
      event = await scanner.loadEvent(target);
      if (!event) throw new Error('Event or market not found. Check the link and try again.');
    } else if (cmd === 'category') {
      const raw = (rest.join('-') || 'sports').toLowerCase().replace(/\s+/g, '-');
      const category = Object.keys(CATEGORY_LABELS).find((k) => k === raw || CATEGORY_LABELS[k].toLowerCase().replace(/\s+/g, '-') === raw);
      if (!category) throw new UsageError(`unknown category "${raw}". Pick one of: ${Object.keys(CATEGORY_LABELS).join(', ')}`);
      const windowKey = CAT_WINDOW_ARGS[(o.window || '24h').toLowerCase()];
      if (!windowKey) throw new UsageError(`unknown --window "${o.window}" (1h, 4h, 6h, 12h, 24h, 7d, 30d, 1y, all)`);
      status('Loading the category’s top events…');
      event = await scanner.loadCategoryEvent({ category, events: o.events || 10, window: windowKey });
      if (!event) throw new Error('No open events found for this category right now.');
    } else if (cmd === 'btc') {
      const tf = (o.tf || '5m').toLowerCase().replace(/^daily$/, '1d').replace(/^hourly$/, '1h');
      if (!BTC_TIMEFRAMES[tf]) throw new UsageError(`unknown --tf "${o.tf}" (${Object.keys(BTC_TIMEFRAMES).join(', ')})`);
      // Max depth is pointless on 5-minute markets (same rule as the web app)
      if (tf === '5m' && depth === 'hybrid') {
        note(c.dim('--depth max does nothing useful on 5m markets, using normal'));
        depth = '2';
      }
      status('Resolving BTC up/down markets…');
      event = await scanner.loadBtcEvent({ tf, hours: o.hours || 24 });
      if (!event) throw new Error('No BTC up/down markets found for this time-frame and lookback.');
    } else if (cmd === 'random') {
      status('Rolling the dice…');
      event = await scanner.loadGambleEvent({ degen: !!o.degen });
      if (!event) throw new Error('Bad roll - could not find a random market. Spin again.');
    }

    markets = marketsFromEvent(event);
    // --exclude is the CLI's version of unticking market/event chips
    const excludes = (o.exclude || []).map((s) => s.toLowerCase());
    if (excludes.length) {
      const before = markets.length;
      markets = markets.filter((m) => !excludes.some((x) => m.question.toLowerCase().includes(x) || m.evTitle.toLowerCase().includes(x)));
      note(c.dim(`--exclude dropped ${before - markets.length} of ${before} markets`));
    }
    if (markets.length === 0) throw new Error('No tradable markets left to scan.');

    if (o['list-markets']) {
      clearStatus();
      for (const l of describeEvent(event, markets)) console.log(l);
      printMarkets(event, markets);
      return;
    }

    const res = await scanner.scanMarkets(markets, depth);
    mode = res.mode;
    marketWallets = res.marketWallets;
  }

  if (mode === 'copier' && copierStats.size === 0) {
    clearStatus();
    for (const l of describeEvent(event, markets)) console.error(l);
    throw new Error('No repeat followers found - nobody appears to be copying this wallet.');
  }

  /* ----- rank + filter ----- */
  const agg = aggregateWallets({ mode, markets, marketWallets, csvAddrs, copierStats });
  const rows = await scanner.rankWallets({
    agg,
    mode,
    topN: o.top || 100,
    filters,
    eventIds: event.scanEventIds || [],
    copierStats,
  });
  clearStatus();

  const cols = columnsForMode(mode, filters.winMetricsOn);
  let sortKey = mode === 'copier' ? 'follows' : 'd7';
  if (sortArg) {
    sortKey = sortArg;
    if (!cols.some((col) => col.key === sortKey)) {
      note(c.dim(`--sort ${o.sort} isn't a column in this scan, sorting by ${mode === 'copier' ? 'follows' : '7d'}`));
      sortKey = mode === 'copier' ? 'follows' : 'd7';
    }
  }
  const sorted = sortRows(rows, sortKey);

  /* ----- output ----- */
  const toStdout = o.json || o.csv === '-';
  const header = describeEvent(event, markets);
  if (toStdout) {
    if (!quiet) header.forEach((l) => console.error(l));
  } else {
    header.forEach((l) => console.log(l));
    console.log('');
  }

  if (o.csv) {
    const text = rowsToCsv(rows, sortKey) + '\n';
    if (o.csv === '-') process.stdout.write(text);
    else {
      fs.writeFileSync(o.csv, text);
      note(`Saved ${rows.length} wallets to ${path.resolve(o.csv)}`);
    }
  }
  if (o.json) {
    console.log(JSON.stringify(sorted.map(({ img, ...r }) => r), jsonReplacer, 2));
  }
  if (toStdout) return;

  if (rows.length === 0) {
    console.log(c.dim('No wallets made it through the filters.'));
    return;
  }
  printTable(sorted, cols, { wide: !!o.wide });
  const label = cols.find((col) => col.key === sortKey)?.label || sortKey;
  console.log(c.dim(`\n${rows.length} wallets · sorted by ${label}`));

  const nBets = o.bets == null ? 0 : Math.max(0, parseInt(o.bets, 10) || 0);
  for (const r of sorted.slice(0, nBets)) {
    status(`Loading trade history for ${r.name || shortAddr(r.addr)}…`);
    const win = await loadHistory(scanner, r.addr, o);
    clearStatus();
    printBets(win, r, byDollar, { addr: r.addr });
  }
}

main().catch((e) => {
  clearStatus();
  if (e.message === 'cancelled') process.exit(130);
  if (e instanceof UsageError) {
    console.error(`markyscan: ${e.message}\nRun "markyscan --help" for usage.`);
    process.exit(2);
  }
  console.error(`markyscan: ${e.message || e}`);
  process.exit(1);
});
