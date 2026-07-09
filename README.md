# MarkyScan - Polymarket Wallet Profitability Scanner

Three scan modes (main tabs):

- **Event scan** - paste a Polymarket event/market link, scan that event's wallets.
- **Best of category** - pick a category (Sports, Politics, Crypto, Esports, Pop culture, …) and MarkyScan pulls the category's top N open events by 24h volume (default 10, max 30), takes up to 12 highest-volume markets per event, and runs the exact same wallet pipeline and filters across all of them. The markets list shows one chip per event - untick to exclude that whole event and re-rank.
- **BTC up/down** - scans *every* Bitcoin Up-or-Down market of a chosen time-frame (5m / 15m / 1h / 4h / daily) in the lookback window (default 24h → 288 five-minute markets; capped at 300 markets). Slugs are deterministic (`btc-updown-5m-{unix}`, `btc-updown-4h-{unix}`, ET-date slugs for hourly/daily), resolved in batched gamma lookups, then the standard pipeline runs. The "Markets" column becomes a regularity signal - how many time-slots the wallet traded. Tip: the **Arb % filter** matters most here; the top of the board is usually hedge bots trading both Up and Down.

For an event scan, MarkyScan will:

1. Resolve the full event and **all** its markets (for a soccer game: moneyline, over/under, corners, cards, etc. - everything under the event).
2. Collect every wallet that **traded** in those markets (recent trade history, paginated).
3. Rank them by traded volume in the event (or by **position size** using the "Top holders" scan mode), then fetch each one's **global PnL** and let you sort by **7D / 30D / All-time** profitability.

Filters (all combinable; rejected wallets don't count toward the quota - the scanner keeps walking down the ranking until it fills it):

- **Max profile views** - surface under-the-radar wallets
- **Exclude red PnL** - drop wallets negative on 7D, 30D and/or all-time
- **PnL bounds** - min/max $ per window
- **Wallet type / win metrics** - opt-in (extra lookups per wallet). Computes three global metrics per wallet and adds them as sortable columns, each with a min-threshold filter:
  - **ROI %** - all-time PnL ÷ lifetime traded volume (leaderboard API)
  - **Win rate %** - share of *decided* bets that ended profitable. A bet = all activity in one market (cost = buys, proceeds = sells + redeems, reconstructed from the wallet's last ~2,000 activity events). Decided = fully traded out, redeemed, resolved worthless (no longer in the wallet's open positions), **or still held but effectively dead** - every position in the market down ≥99% and unclaimed. That last case defeats the classic win-rate gaming trick of never selling losers so they stay "open" forever. Unredeemed *wins* (resolved, redeemable, not yet claimed) count too, credited at current value. Needs ≥3 decided bets, else "-".
  - **Avg win %** - mean % return on the winning bets only. 500%+ ⇒ longshot hunter.
  - **Gain/loss ratio (G/L)** - gross gains ÷ gross losses across decided bets (profit factor). A wallet that gains $100K but gives $90K back scores 1.11× - profitable on paper, but risky/churny. 2× keeps twice what it loses back; ∞ = no losing bets yet. Needs ≥3 decided bets, else "-". Shown red below 1× (net loser).

  Every result row has a **▸ expand arrow** that opens the trader's receipts: their biggest closed wins and worst losses, with cost / profit / % return and a link to each market. The sort adapts to the active filters - % return by default (longshot view), $ profit when only the ROI filter is set. Loads lazily on click, so it works even when the win-metrics checkbox is off.

  Presets: Longshot hunters (avg win ≥ 500%) · Steady grinders (win rate ≥ 70%, ROI ≥ 0) · High ROI (≥ 30%). Presets just fill the threshold inputs - tweak them freely. Caveats: history is capped at ~2,000 events, so for hyper-active wallets older bets are ignored (bets whose opening buy falls outside the window are skipped rather than mis-scored); markets with split/merge/convert activity are skipped (cost basis unreliable).
- **Arb/edger filter** - exclude wallets with more than X% hedged activity on opposite sides of the same market (Over↔Under, Up↔Down). In trades mode this is measured from trade direction (each matched opposite pair = 2 hedged trades). In holders mode the scanner fetches each candidate wallet's own positions in the event and measures hedged *shares* (holding both outcomes of one market) - not limited to top-100 holder lists, but it can't see hedges that were already closed/redeemed.

100% static - plain HTML/CSS/JS calling Polymarket's public, CORS-enabled APIs directly from the browser. No backend, no API keys, no build step.

## Files

| File         | Purpose                        |
|--------------|--------------------------------|
| `index.html` | Page structure                 |
| `styles.css` | Dark theme styling             |
| `app.js`     | All scanning / ranking logic   |

## Deploying

Upload the three files to any static host:

- **Netlify**: drag the folder into https://app.netlify.com/drop
- **Vercel**: `vercel` in this folder
- **GitHub Pages**: push to a repo, enable Pages
- **Any cPanel/FTP host**: upload to `public_html/`

No server-side configuration required.

## Running locally

Just open `index.html` in a browser, or:

```sh
python3 -m http.server 8000
# → http://localhost:8000
```

## How it works / APIs used

| API | Used for |
|-----|----------|
| `gamma-api.polymarket.com/events?slug=…` | Event metadata + full list of its markets |
| `gamma-api.polymarket.com/markets?slug=…` | Resolving a market link back to its parent event |
| `data-api.polymarket.com/trades?market=…` | Recent trade history (paginated) |
| `data-api.polymarket.com/v1/user-stats?proxyAddress=…` | Profile stats (views, join date) for the max-views filter |
| `user-pnl-api.polymarket.com/user-pnl?user_address=…` | Per-wallet PnL time series (1w / 1m / max) |
| `data-api.polymarket.com/activity?user=…` | Trade/redeem history for win rate & avg win % |
| `data-api.polymarket.com/positions?user=…` | Open positions (win metrics + holders-mode hedge check) |
| `lb-api.polymarket.com/volume?window=all&address=…` | Lifetime traded volume for ROI % |

Notes & limitations:

- **PnL is the wallet's global Polymarket PnL** (across all their markets), not just this event - that's what the 7D/30D/All-time windows measure. "Vol. in event", "Trades" and "Markets" columns show their activity inside the scanned event.
- 7D/30D PnL = change over the window (last − first point of the series); All-time = last point of the lifetime series.
- Wallet discovery covers the most recent 500–4,000 trades per market (configurable via "Trade scan depth"). The trades feed is taker-side fills, so in very high-volume markets older traders may fall outside the window - use a deeper scan depth there.
- The public APIs are rate-limited; the scanner throttles itself (5 markets / 8 wallets in parallel) and retries with backoff on 429s. Big events with "Top 400" can take a couple of minutes.
