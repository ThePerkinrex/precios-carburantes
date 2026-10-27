"""Measures how fast product price rises and falls reach the pump ("rockets and feathers").

Usage: python3 passthrough.py <db> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--lags DAYS]

Regresses the daily change of the pre-tax pump price (Spain, general taxes) on the daily product
price changes of the last --lags days, split into rises and falls, and prints the cumulative
pass-through of each: the share of a product move that has reached the pump k days later.
Product prices are taken without delay: this measures stations, not what a forecast can know.
"""

import argparse
import datetime as dt
import sqlite3

import numpy as np

import backtest as B

DAY = B.DAY
SHOWN = (1, 3, 5, 7, 10, 14, 21, 28)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("db")
    p.add_argument("--from", dest="start", type=dt.date.fromisoformat, default=dt.date.min)
    p.add_argument("--to", dest="end", type=dt.date.fromisoformat, default=dt.date.max)
    p.add_argument("--lags", type=int, default=35)
    args = p.parse_args()

    db = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    market = {name: B.load_market(db, name) for name in ("ecb:USD", *B.PRODUCT.values())}
    print("| Fuel | Days | " + " | ".join(f"{k} d" for k in SHOWN if k < args.lags) + " |")
    print("|---|---|" + "---|" * sum(k < args.lags for k in SHOWN))
    for fuel in ("gasolina_95", "gasoleo_a"):
        s = B.Series(B.load_regions(db, fuel), fuel, "ES", market, 0, 0)
        days = [d for d in sorted(s.net) if args.start <= d <= args.end]
        change = {}
        for d in days:
            a, b = s.product_eur(d, 0), s.product_eur(d - DAY, 0)
            if a is not None and b is not None:
                change[d] = a - b
        X, y = [], []
        for t in days:
            lags = [change.get(t - k * DAY) for k in range(args.lags)]
            if t - DAY not in s.net or None in lags:
                continue
            X.append([max(c, 0) for c in lags] + [min(c, 0) for c in lags])
            y.append(s.net[t] - s.net[t - DAY])
        if len(y) < 4 * args.lags:
            print(f"| {fuel} | {len(y)} | too few days |")
            continue
        beta = np.linalg.lstsq(np.c_[np.ones(len(y)), X], y, rcond=None)[0][1:]
        rises, falls = np.cumsum(beta[:args.lags]), np.cumsum(beta[args.lags:])
        print(f"| {fuel} | {len(y)} | " + " | ".join(f"{rises[k]:.2f} / {falls[k]:.2f}" for k in SHOWN if k < args.lags) + " |")
    print("\nCells: share of a product rise / fall passed to the pump after k days.")


if __name__ == "__main__":
    main()
