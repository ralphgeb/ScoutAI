"""Scout — prices for as many stocks as possible, for free.

Called by scripts/update-news.mjs as:  python3 scripts/universe.py data/symbols.json result.json

Picks about 3,500 symbols from the stock list (the larger companies on the main US, UK, European,
Canadian and Asian exchanges, plus indices, currencies and crypto) and fetches their last few
daily prices in bulk: one request per batch of 200, rather than one per stock, so the whole list
takes a few minutes on GitHub every 30 minutes. No AI is involved.

result.json: {"updated": iso, "q": {"AAPL": [price, prevClose, unixTime], ...},
              "movers": {"day": "2026-10-27", "up": [[sym, name, pct, price], ...], "down": [...]}}
"Movers" are the biggest risers and fallers of the last complete trading day ("yesterday"), among
companies big and busy enough to matter.
"""
import json
import math
import sys
import time
from datetime import datetime, timezone

import yfinance as yf

MAIN = {"NYSE", "Nasdaq", "NYSE American", "London", "XETRA", "Paris", "Amsterdam", "Swiss", "Milan",
        "Madrid", "Stockholm", "Copenhagen", "Helsinki", "Brussels", "Dublin", "Lisbon", "Oslo", "Toronto",
        "Tokyo", "Hong Kong", "Sydney", "Korea", "Taiwan", "India NSE", "Singapore"}
BATCH = 200
MOVERS = 10
MIN_TURNOVER = 5_000_000      # price × volume in a day, so tiny, thinly traded shares don't top the list


def num(v):
    try:
        f = float(v)
        return None if math.isnan(f) or math.isinf(f) else f
    except Exception:
        return None


def pick(directory):
    ex = directory.get("exchanges", [])
    out = []
    for r in directory.get("s", []):
        sym, name, ei, rank, kind = r[0], r[1], r[2], r[3], r[4]
        exch = ex[ei] if isinstance(ei, int) and ei < len(ex) else ""
        if kind in ("I", "C", "X") or (kind == "E" and (rank >= 5 or (rank >= 4 and exch in MAIN))):
            out.append((sym, name, kind))
    return out


def main():
    directory = json.load(open(sys.argv[1]))
    chosen = pick(directory)
    names = {s: n for s, n, _ in chosen}
    kinds = {s: k for s, _, k in chosen}
    symbols = [s for s, _, _ in chosen]
    today = datetime.now(timezone.utc).date()
    q, day_moves = {}, []

    for i in range(0, len(symbols), BATCH):
        part = symbols[i:i + BATCH]
        for attempt in range(3):
            try:
                df = yf.download(part, period="5d", interval="1d", group_by="ticker", threads=True,
                                 progress=False, auto_adjust=False)
                break
            except Exception:
                df = None
                time.sleep(5 * (attempt + 1))
        if df is None or df.empty:
            continue
        for sym in part:
            try:
                sub = df[sym] if len(part) > 1 else df
                closes = sub["Close"].dropna()
                if len(closes) < 2:
                    continue
                price, prev = num(closes.iloc[-1]), num(closes.iloc[-2])
                if price is None or not prev:
                    continue
                q[sym] = [round(price, 4), round(prev, 4), int(closes.index[-1].timestamp())]
                # "yesterday": the last complete day, so not today's session while it's still running
                complete = closes if closes.index[-1].date() < today else closes.iloc[:-1]
                vols = sub["Volume"].reindex(complete.index).fillna(0)
                if len(complete) >= 2 and kinds.get(sym) == "E":
                    a, b = num(complete.iloc[-2]), num(complete.iloc[-1])
                    turnover = (b or 0) * (num(vols.iloc[-1]) or 0)
                    if a and b and turnover >= MIN_TURNOVER:
                        day_moves.append((sym, (b - a) / a * 100, b, complete.index[-1].date().isoformat()))
            except Exception:
                continue
        time.sleep(1)

    day = max((d for *_, d in day_moves), default=None)
    moves = [m for m in day_moves if m[3] == day]
    def top(ordered):
        # one line per company, even when it's listed on several exchanges
        seen, out = set(), []
        for m in ordered:
            key = names.get(m[0], m[0]).lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(m)
            if len(out) == MOVERS:
                break
        return out

    up = top(sorted(moves, key=lambda m: -m[1]))
    down = top(sorted(moves, key=lambda m: m[1]))
    row = lambda m: [m[0], names.get(m[0], m[0]), round(m[1], 2), round(m[2], 4)]
    result = {
        "updated": datetime.now(timezone.utc).isoformat(),
        "q": q,
        "movers": {"day": day, "up": [row(m) for m in up if m[1] > 0], "down": [row(m) for m in down if m[1] < 0]},
    }
    json.dump(result, open(sys.argv[2], "w"), separators=(",", ":"))
    print(f"[universe] prices for {len(q)} of {len(symbols)} symbols; movers from {day}")


if __name__ == "__main__":
    main()
