"""Finds tax steps in the price history, to date the changes in data/fuel_taxes_es.csv.

Usage: python3 detect_tax_steps.py <db> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--min 0.012] [--pin]

A regional tax change moves one region's prices on one day while the rest of Spain doesn't
move. For each region, it takes the daily average (last snapshot of each day) minus the
average of every other region under the general taxes, and reports the days where the mean of
the next week differs from the mean of the week before by at least --min €/L. "ES" is all of
them against Canarias, for national changes (Canarias has its own taxes).

Next to each step it prints the step the tax table predicts there (with full pass-through), so
the dates marked "year" or "month" in the CSV can be pinned, and wrong values found.
"""

import argparse
import collections
import datetime as dt
import sqlite3

import taxes

WINDOW = 7
FUELS = {"gasolina_95": ("suma_gasolina_95", "n_gasolina_95"), "gasoleo_a": ("suma_gasoleo_a", "n_gasoleo_a")}


def daily_sums(db, fuel, start, end):
    """{day: {ccaa: (sum, n)}} at the last snapshot of each day."""
    s, n = FUELS[fuel]
    out = collections.defaultdict(dict)
    rows = db.execute(
        f"""
        WITH picked AS (
            SELECT MAX(fecha) AS fecha FROM snapshots
            WHERE fecha >= strftime('%s', ?1) AND fecha < strftime('%s', ?2)
            GROUP BY date(fecha, 'unixepoch', 'localtime')
        )
        SELECT date(pp.fecha, 'unixepoch', 'localtime'), id_ccaa, SUM({s}), SUM({n})
        FROM picked CROSS JOIN precios_provincia pp ON pp.fecha = picked.fecha
        GROUP BY pp.fecha, id_ccaa
        """,
        (start, end),
    )
    for day, ccaa, total, count in rows:
        if count:
            out[dt.date.fromisoformat(day)][ccaa] = (total, count)
    return out


def series(sums, region):
    """{day: region average - comparison average}."""
    out = {}
    for day, by in sums.items():
        if region == "ES":
            mine = [v for c, v in by.items() if c not in taxes.OWN_TAXES]
            rest = [v for c, v in by.items() if c == "05"]
        else:
            mine = [v for c, v in by.items() if c == region]
            rest = [v for c, v in by.items() if c != region and c not in taxes.OWN_TAXES]
        if not mine or not rest:
            continue
        avg = lambda vs: sum(v[0] for v in vs) / sum(v[1] for v in vs)
        out[day] = (avg(mine), avg(rest))
    return out


def expected_step(region, fuel, day, price):
    """The predicted change of the region's price relative to the rest on `day`."""
    def tax_effect(ccaa):
        before = taxes.components(day - dt.timedelta(days=1), ccaa, fuel)
        after = taxes.components(day, ccaa, fuel)
        if before is None or after is None:
            return 0.0
        return taxes.pump_price(taxes.net_price(price, before), after) - price

    if region == "ES":
        # Every common-tax region moves alike nationally; Canarias isn't modelled.
        return tax_effect("13")
    others = [c for c in ("01", "02", "03", "04", "06", "07", "08", "09", "10", "11", "12", "13", "14", "15", "16", "17") if c != region]
    return tax_effect(region) - sum(tax_effect(c) for c in others) / len(others)


def steps(rel, minimum):
    days = sorted(rel)
    diff = {d: rel[d][0] - rel[d][1] for d in days}
    found = []
    for i in range(WINDOW, len(days) - WINDOW + 1):
        before = [diff[d] for d in days[i - WINDOW:i]]
        after = [diff[d] for d in days[i:i + WINDOW]]
        # Only consecutive days: a gap in the data would look like a step.
        if (days[i + WINDOW - 1] - days[i - WINDOW]).days != 2 * WINDOW - 1:
            continue
        step = sum(after) / WINDOW - sum(before) / WINDOW
        found.append((days[i], step))
    # Keep the local extremes over ±WINDOW days.
    peaks = []
    for i, (day, step) in enumerate(found):
        if abs(step) < minimum:
            continue
        near = found[max(0, i - WINDOW):i + WINDOW + 1]
        if all(abs(step) >= abs(s) for _, s in near):
            peaks.append((day, step))
    return peaks


def pin(db):
    """For each CSV row dated only to the year or month, the steps that best fit it."""
    import csv

    with open(taxes.DATA, newline="") as f:
        rows = [r for r in csv.DictReader(f) if r["confidence"] in ("year", "month")]
    cache = {}
    for r in rows:
        start = dt.date.fromisoformat(r["from"])
        # A yearly report's table can reflect a change from late in the year before.
        window = (start - dt.timedelta(days=60), start + dt.timedelta(days=366 if r["confidence"] == "year" else 46))
        fuels = list(FUELS) if r["fuel"] == "both" else [r["fuel"]]
        for fuel in fuels:
            before = taxes.components(start - dt.timedelta(days=1), r["region"], fuel)
            if before is None:
                continue
            delta = (float(r["value"]) / 1000 - before["regional"]) * (1 + before["iva"])
            key = (fuel, window)
            if key not in cache:
                cache[key] = daily_sums(db, fuel, (window[0] - dt.timedelta(days=WINDOW)).isoformat(), (window[1] + dt.timedelta(days=WINDOW)).isoformat())
            rel = series(cache[key], r["region"])
            if len(rel) < 3 * WINDOW:
                print(f"{r['region']} {fuel:12} {r['from']} expected {delta:+.4f}: not enough data")
                continue
            found = [(d, s) for d, s in steps(rel, 0.0) if window[0] <= d < window[1]]
            best = sorted(found, key=lambda x: abs(x[1] - delta))[:3]
            shown = ", ".join(f"{d} {s:+.4f}" for d, s in best)
            print(f"{r['region']} {fuel:12} {r['from']} ({r['confidence']}) expected {delta:+.4f}: {shown}")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("db")
    p.add_argument("--from", dest="start", default="2007-01-01")
    p.add_argument("--to", dest="end", default="2100-01-01")
    p.add_argument("--min", type=float, default=0.012)
    p.add_argument("--pin", action="store_true", help="date the CSV rows marked year or month instead")
    args = p.parse_args()

    db = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    if args.pin:
        pin(db)
        return
    regions = ["ES"] + [r[0] for r in db.execute("SELECT DISTINCT id_ccaa FROM precios_provincia ORDER BY 1") if r[0] not in taxes.OWN_TAXES]
    for fuel in FUELS:
        sums = daily_sums(db, fuel, args.start, args.end)
        for region in regions:
            rel = series(sums, region)
            for day, step in steps(rel, args.min):
                predicted = sum(expected_step(region, fuel, day + dt.timedelta(days=k), rel[day][0]) for k in range(-WINDOW, WINDOW))
                print(f"{fuel:12} {region:3} {day}  step {step:+.4f}  table predicts {predicted:+.4f} within ±{WINDOW} days")


if __name__ == "__main__":
    main()
