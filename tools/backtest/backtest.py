"""Backtests forecasts of the average pump price 1-14 days ahead (issue #11).

Usage: python3 backtest.py <db> [--area ES|<IDCCAA>] [--holdout DAYS] [--final]
                            [--eia-lag weekly|DAYS] [--fresh-lag DAYS] [--futures]

Prices are end-of-day (the last snapshot of each day), as the backfill stores them. An area is
Spain (ES: every region under the general taxes) or one region; its price is the average over
its regions' stations, and taxes are handled region by region (regional rates differed until
2018).

Every model predicts y = pump(T + h) - pump(T) at origin T for horizon h, using only what was
known at T: the tax schedule as published by then, ECB rates from day T and EIA prices as
published by T. By default (--eia-lag weekly) that follows EIA's schedule: the daily spot prices
come out with the Weekly Petroleum Status Report on Wednesday, through the Tuesday before, after
10:30 ET (evening in Spain), so they are used from Thursday on, 2 to 8 days late. A number
instead delays every price by that many days. The tax effect Δtax is the pump price change the
scheduled taxes would cause with full pass-through.

Models:
- today: y = 0.
- tax: y = Δtax.
- tax+trend: Δtax plus the damped 7-day trend of the pre-tax price, spread over the target days
  by weekday activity (how much the price moved on each weekday over the ACTIVITY_DAYS before
  the origin's month: little on Sundays). On 2007-2015 a week with damping 0.8 beat 3, 14 and 28
  days and damping 0.7-1.0 at 3-14 days ahead.
- tax+weekday: Δtax plus the pre-tax change since the same weekday last week.
- linear: Δtax plus a ridge regression of the rest (y - Δtax) on Δtax again (so it learns how
  far pass-through falls short of full), the tax change of the last few days (stations still
  adjusting), the pre-tax price minus the product price (margin), product price changes over
  0-7, 7-14 and 14-28 days split into rises and falls, own changes and the target's weekday.
- pump: the same ridge regression on pump prices alone: Δtax, the recent tax change, the
  pre-tax price's daily changes over the last 7 days, its weekly changes over 7-28 days and the
  target's weekday. With EIA on its schedule, adding product prices to it made it worse.
- pump+trend: the mean of pump and tax+trend.
- pump+futures (only with --futures): the pump model plus the linear model's product inputs
  (margin, rises and falls over 0-7, 7-14 and 14-28 days), taken from the front-month futures'
  close of the day before (Yahoo's RB=F for gasoline, HO=F for diesel, which `downloader
  markets` stores). On 2007-2015 it beat pump+trend by 2-2.5x at 3-7 days.
- pump+futures+trend: the mean of pump+futures and tax+trend.
- linear-fresh (only with --fresh-lag): the linear model with product prices --fresh-lag days
  late, as a daily feed (a futures close) would give them. Pump prices follow product prices
  within days, so what the EIA delay costs is the gap between linear and linear-fresh.

Validation: walk-forward over non-overlapping VALIDATION_DAYS blocks of origins. Each block
trains on the samples whose target date is at least GAP_DAYS before the block (the gap is at
least the horizon plus the longest feature lag), so no training target overlaps the block. The
last --holdout days of origins are left out unless --final, which scores only them, once.

Reports, per fuel and horizon: mean absolute error, its 90th percentile, bias, and how often
the actual value fell in the 80 % interval (the 10-90 % quantiles of the training residuals),
over all origins and split by whether a tax change falls between T - SETTLE_DAYS and T + h.
The intervals scale with volatility: the residual quantiles are of residuals divided by the
standard deviation of daily pump changes over the VOL_DAYS before the origin (leaving out a tax
change's day and the SETTLE_DAYS after it), and are multiplied back by the one at the test origin. Trend reversals, from 3 days ahead: on the
origins every model forecasts (but today and tax, which have no direction), whether the change to the target goes against the last
REVERSAL_DAYS' change, and how often each model saw it coming (the reversals it called, and how
many of its reversal calls were right). Moves under FLAT €/L a week count as flat and are left
out. For the regressions, how much the fitted coefficients move across blocks.
"""

import argparse
import bisect
import collections
import datetime as dt
import math
import sqlite3

import numpy as np

import taxes

HORIZONS = (1, 3, 7, 14)
VALIDATION_DAYS = 28
GAP_DAYS = 28
MIN_TRAIN = 90
SETTLE_DAYS = 4
TREND_DAYS = 7
DAMPING = 0.8
VOL_DAYS = 28
ACTIVITY_DAYS = 365
REVERSAL_DAYS = 7
FLAT = 0.003
RIDGE = 1.0
GAL = 3.785411784
PRODUCT = {"gasoleo_a": "eia:EER_EPD2DXL0_PF4_Y35NY_DPG", "gasolina_95": "eia:EER_EPMRU_PF4_Y35NY_DPG"}
FUTURES = {"gasoleo_a": "yf:HO=F", "gasolina_95": "yf:RB=F"}
FUTURES_LAG = 1  # the previous day's close: it settles at 14:30 ET, 20:30 in Spain
COLUMNS = {"gasoleo_a": ("suma_gasoleo_a", "n_gasoleo_a"), "gasolina_95": ("suma_gasolina_95", "n_gasolina_95")}
DAY = dt.timedelta(days=1)


# ---------- Data ----------

def load_regions(db, fuel):
    """{day: {ccaa: (average, stations)}} at the last snapshot of each day, general-tax regions."""
    s, n = COLUMNS[fuel]
    out = collections.defaultdict(dict)
    for day, ccaa, total, count in db.execute(f"""
        WITH picked AS (SELECT MAX(fecha) AS fecha FROM snapshots GROUP BY date(fecha, 'unixepoch', 'localtime'))
        SELECT date(pp.fecha, 'unixepoch', 'localtime'), id_ccaa, SUM({s}), SUM({n})
        FROM picked CROSS JOIN precios_provincia pp ON pp.fecha = picked.fecha
        GROUP BY pp.fecha, id_ccaa"""):
        if count and ccaa not in taxes.OWN_TAXES:
            out[dt.date.fromisoformat(day)][ccaa] = (total / count, count)
    return out


def load_market(db, serie):
    rows = db.execute("SELECT fecha, valor FROM mercados WHERE serie = ? ORDER BY fecha", (serie,)).fetchall()
    return [dt.date.fromisoformat(d) for d, _ in rows], [v for _, v in rows]


def eia_published_through(day):
    """The last date of EIA daily prices usable at `day`: the Tuesday before the last Wednesday
    release before `day` (the release comes in the Spanish evening, so it counts from Thursday)."""
    wednesday = day - dt.timedelta(days=(day.weekday() - 2) % 7 or 7)
    return wednesday - DAY


class Series:
    """One fuel in one area: daily pump and pre-tax prices, and the tax effects."""

    def __init__(self, regions, fuel, area, market, eia_lag, fresh_lag=None, futures=False):
        self.fuel = fuel
        self.area = area
        self.eia_lag = eia_lag
        self.fresh_lag = fresh_lag
        self.regions = {}
        self.pump = {}
        self.net = {}
        self.iva = {}
        for day, by in regions.items():
            mine = {c: v for c, v in by.items() if area == "ES" or c == area}
            comps = {c: taxes.components(day, c, fuel) for c in mine}
            mine = {c: v for c, v in mine.items() if comps[c] is not None}
            total = sum(n for _, n in mine.values())
            if not total:
                continue
            self.regions[day] = mine
            self.pump[day] = sum(p * n for p, n in mine.values()) / total
            self.net[day] = sum(taxes.net_price(p, comps[c]) * n for c, (p, n) in mine.items()) / total
            self.iva[day] = sum(comps[c]["iva"] * n for c, (_, n) in mine.items()) / total
        self.usd = market["ecb:USD"]
        self.products = {"eia": market[PRODUCT[fuel]]}
        if futures:
            self.products["futures"] = market[FUTURES[fuel]]
        self._activity = {}
        self.tax_changes = sorted({r["from"] for r in taxes.load() if r["fuel"] in (fuel, "both")})

    def settling(self, day):
        """Whether `day` is a tax change's day or one of the SETTLE_DAYS after it."""
        i = bisect.bisect_left(self.tax_changes, day - SETTLE_DAYS * DAY)
        return i < len(self.tax_changes) and self.tax_changes[i] <= day

    def activity(self, day):
        """Each weekday's mean absolute daily change of the pre-tax price over the ACTIVITY_DAYS
        before `day`'s month, relative to their mean (Monday first), or None."""
        month = day.replace(day=1)
        if month not in self._activity:
            moves = collections.defaultdict(list)
            for k in range(1, ACTIVITY_DAYS + 1):
                d = month - k * DAY
                if d in self.net and d - DAY in self.net:
                    moves[d.weekday()].append(abs(self.net[d] - self.net[d - DAY]))
            a = np.array([np.mean(moves[k]) if moves[k] else np.nan for k in range(7)])
            self._activity[month] = None if np.isnan(a).any() or not a.mean() else a / a.mean()
        return self._activity[month]

    def tax_effect(self, origin, target):
        """The pump price change from `origin` to `target` that taxes cause with full pass-through,
        with the schedule known at `origin`."""
        by = self.regions[origin]
        total = sum(n for _, n in by.values())
        effect = 0.0
        for c, (p, n) in by.items():
            now = taxes.components(origin, c, self.fuel, as_of=origin)
            then = taxes.components(target, c, self.fuel, as_of=origin)
            effect += (taxes.pump_price(taxes.net_price(p, now), then) - p) * n
        return effect / total

    def product_eur(self, day, lag, source="eia"):
        """The product price in €/L from `source` (eia or futures) as known at `day` when published
        `lag` days late, or on EIA's schedule if `lag` is "weekly"."""
        dates, values = self.products[source]
        cutoff = eia_published_through(day) if lag == "weekly" else day - dt.timedelta(days=lag)
        i = bisect.bisect_right(dates, cutoff) - 1
        if i < 0 or (cutoff - dates[i]).days > 7:
            return None
        udates, uvalues = self.usd
        j = bisect.bisect_right(udates, dates[i]) - 1
        if j < 0:
            return None
        return values[i] / GAL / uvalues[j]


# ---------- Samples ----------

def features(s, t, h, lag, source="eia"):
    """The linear model's inputs at origin t for horizon h with product prices from `source`
    `lag` days late, or None if data is missing."""
    need = [t - dt.timedelta(days=k) for k in (0, 7, 14, 28)]
    if any(d not in s.net for d in need) or t - SETTLE_DAYS * DAY not in s.regions:
        return None
    product = [s.product_eur(d, lag, source) for d in need]
    if any(p is None for p in product):
        return None
    p0, p7, p14, p28 = product
    n0, n7, n14 = s.net[t], s.net[t - 7 * DAY], s.net[t - 14 * DAY]
    gross = 1 + s.iva[t]
    changes = [(p0 - p7) * gross, (p7 - p14) * gross, (p14 - p28) * gross]
    x = [
        s.tax_effect(t, t + h * DAY),
        s.tax_effect(t - SETTLE_DAYS * DAY, t),
        (n0 - p0) * gross,
        *[max(c, 0) for c in changes],
        *[min(c, 0) for c in changes],
        (n0 - n7) * gross,
        (n7 - n14) * gross,
    ]
    weekday = (t + h * DAY).weekday()
    x += [1.0 if weekday == k else 0.0 for k in range(6)]
    return x


WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]


def pump_features(s, t, h):
    """The pump model's inputs at origin t for horizon h, or None if data is missing."""
    need = [t - k * DAY for k in (*range(8), 14, 21, 28)]
    if any(d not in s.net for d in need) or t - SETTLE_DAYS * DAY not in s.regions:
        return None
    gross = 1 + s.iva[t]
    n = [s.net[d] for d in need]
    x = [
        s.tax_effect(t, t + h * DAY),
        s.tax_effect(t - SETTLE_DAYS * DAY, t),
        *[(n[k] - n[k + 1]) * gross for k in range(7)],
        *[(n[k] - n[k + 1]) * gross for k in range(7, 10)],
    ]
    weekday = (t + h * DAY).weekday()
    x += [1.0 if weekday == k else 0.0 for k in range(6)]
    return x


def futures_features(s, t, h):
    """The pump model's inputs plus the futures' margin, rises and falls, or None."""
    pump, product = pump_features(s, t, h), features(s, t, h, FUTURES_LAG, "futures")
    if pump is None or product is None:
        return None
    return pump[:-6] + product[2:9] + pump[-6:]


FEATURE_NAMES = {
    "linear": ["Δtax", "recent Δtax", "margin", "product rise 0-7", "product rise 7-14", "product rise 14-28",
               "product fall 0-7", "product fall 7-14", "product fall 14-28", "own change 0-7", "own change 7-14",
               *WEEKDAYS],
    "pump": ["Δtax", "recent Δtax", *[f"change {k}-{k + 1}" for k in range(7)], "change 7-14", "change 14-21",
             "change 21-28", *WEEKDAYS],
}
FEATURE_NAMES["linear-fresh"] = FEATURE_NAMES["linear"]
FEATURE_NAMES["pump+futures"] = FEATURE_NAMES["pump"][:-6] + FEATURE_NAMES["linear"][2:9] + WEEKDAYS


def baselines(s, t, h, tax):
    gross = 1 + s.iva[t]
    out = {"today": 0.0, "tax": tax}
    past = t - TREND_DAYS * DAY
    activity = s.activity(t)
    if past in s.net and activity is not None:
        slope = (s.net[t] - s.net[past]) / TREND_DAYS
        steps = sum(DAMPING ** k * activity[(t + k * DAY).weekday()] for k in range(1, h + 1))
        out["tax+trend"] = tax + gross * slope * steps
    # The pre-tax change over the same weekdays a week (or two) earlier.
    back = 7 * math.ceil(h / 7) * DAY
    if t - back in s.net and t + h * DAY - back in s.net:
        out["tax+weekday"] = tax + gross * (s.net[t + h * DAY - back] - s.net[t - back])
    return out


def volatility(s, t):
    """The standard deviation of daily pump changes over the VOL_DAYS before t, or None. Days
    settling a tax change are left out: their step is the tax, and it rarely reaches the pump in full."""
    changes = [s.pump[d] - s.pump[d - DAY] for d in (t - k * DAY for k in range(VOL_DAYS))
               if d in s.pump and d - DAY in s.pump and not s.settling(d)]
    return float(np.std(changes)) if len(changes) >= VOL_DAYS // 2 else None


def samples(s, h):
    """Every origin with data at the target and a volatility:
    (origin, actual change, volatility, baselines, {linear model: features})."""
    out = []
    for t in sorted(s.pump):
        target = t + h * DAY
        vol = volatility(s, t)
        if target not in s.pump or not vol:
            continue
        tax = s.tax_effect(t, target)
        xs = {"linear": features(s, t, h, s.eia_lag), "pump": pump_features(s, t, h)}
        if "futures" in s.products:
            xs["pump+futures"] = futures_features(s, t, h)
        if s.fresh_lag is not None:
            xs["linear-fresh"] = features(s, t, h, s.fresh_lag)
        out.append((t, s.pump[target] - s.pump[t], vol, baselines(s, t, h, tax), xs))
    return out


# ---------- Validation ----------

def tax_change_dates():
    rows = taxes.load()
    return sorted({r["from"] for r in rows})


def near_tax_change(t, h, changes):
    lo, hi = t - SETTLE_DAYS * DAY, t + h * DAY
    i = bisect.bisect_right(changes, lo)
    return i < len(changes) and changes[i] <= hi


LINEAR = ("linear", "pump", "pump+futures", "linear-fresh")
ENSEMBLES = {"pump+trend": "pump", "pump+futures+trend": "pump+futures"}
MODELS = ("today", "tax", "tax+trend", "tax+weekday", "linear", "pump", "pump+trend", "pump+futures",
          "pump+futures+trend", "linear-fresh")


def ensemble(preds):
    """Adds the combined models (a regression's mean with tax+trend) to a {model: prediction} dict."""
    for name, model in ENSEMBLES.items():
        if model in preds and "tax+trend" in preds:
            preds[name] = (preds[model] + preds["tax+trend"]) / 2
    return preds


def fit_ridge(X, y):
    X, y = np.asarray(X), np.asarray(y)
    mean, std = X.mean(axis=0), X.std(axis=0)
    # A feature that barely moved in training can't be learned: it gets no weight.
    flat = std < 1e-6
    std[flat] = 1
    Z = (X - mean) / std
    A = Z.T @ Z + RIDGE * np.eye(Z.shape[1])
    beta = np.linalg.solve(A, Z.T @ (y - y.mean()))
    beta[flat] = 0
    return {"mean": mean, "std": std, "beta": beta, "intercept": y.mean()}


def predict(model, x):
    return float(((np.asarray(x) - model["mean"]) / model["std"]) @ model["beta"] + model["intercept"])


def run(s, h, holdout, final, changes):
    data = samples(s, h)
    if not data:
        return [], {}
    last = data[-1][0]
    cut = last - dt.timedelta(days=holdout)
    scored, coefs = [], collections.defaultdict(list)
    if final:
        blocks = [(cut + DAY, last + DAY)]
    else:
        start = data[0][0] + dt.timedelta(days=MIN_TRAIN + GAP_DAYS)
        blocks = []
        while start <= cut:
            blocks.append((start, min(start + dt.timedelta(days=VALIDATION_DAYS), cut + DAY)))
            start += dt.timedelta(days=VALIDATION_DAYS)
    for lo, hi in blocks:
        train = [d for d in data if d[0] + h * DAY <= lo - dt.timedelta(days=GAP_DAYS)]
        test = [d for d in data if lo <= d[0] < hi]
        if len(train) < MIN_TRAIN or not test:
            continue
        # Prediction intervals: each model's training residual quantiles, in units of volatility.
        resid = collections.defaultdict(list)
        for t, y, vol, base, _ in train:
            for name, f in base.items():
                resid[name].append((y - f) / vol)
        models = {}
        for name in LINEAR:
            lin_train = [(xs[name], y, vol) for _, y, vol, _, xs in train if xs.get(name) is not None]
            if len(lin_train) < MIN_TRAIN:
                continue
            model = fit_ridge([x for x, _, _ in lin_train], [y - x[0] for x, y, _ in lin_train])
            models[name] = model
            coefs[name].append(model["beta"])
            resid[name] = [(y - x[0] - predict(model, x)) / vol for x, y, vol in lin_train]
        for t, y, vol, base, xs in train:
            preds = {name: xs[name][0] + predict(model, xs[name])
                     for name, model in models.items() if xs[name] is not None}
            for name, f in ensemble({**base, **preds}).items():
                if name in ENSEMBLES:
                    resid[name].append((y - f) / vol)
        bands = {name: np.quantile(r, [0.1, 0.9]) for name, r in resid.items() if r}
        for t, y, vol, base, xs in test:
            before = t - REVERSAL_DAYS * DAY
            past = s.pump[t] - s.pump[before] if before in s.pump else None
            preds = dict(base)
            for name, model in models.items():
                if xs[name] is not None:
                    preds[name] = xs[name][0] + predict(model, xs[name])
            for name, f in ensemble(preds).items():
                lo_q, hi_q = bands.get(name, (None, None))
                inside = None if lo_q is None else (f + lo_q * vol <= y <= f + hi_q * vol)
                scored.append((name, t, y - f, inside, near_tax_change(t, h, changes), y, past))
    return scored, coefs


# ---------- Report ----------

def summary(errors):
    a = np.abs(errors)
    return a.mean(), np.quantile(a, 0.9), np.mean(errors)


def reversals(by_h, models):
    """How well each model calls trend reversals, on the origins every model forecasts. today
    and tax have no direction of their own, so they're left out."""
    models = [m for m in models if m not in ("today", "tax")]
    horizons = [h for h in HORIZONS if h >= 3]
    table = {m: [] for m in models}
    bases = []
    for h in horizons:
        by_origin = collections.defaultdict(dict)
        for name, t, err, _, _, y, past in by_h.get(h, []):
            if past is not None and abs(past) >= FLAT and abs(y) >= FLAT * h / 7:
                by_origin[t][name] = (y - err, y, past)
        rows = [v for v in by_origin.values() if all(m in v for m in models)]
        reversed_ = [v for v in rows if np.sign(next(iter(v.values()))[1]) != np.sign(next(iter(v.values()))[2])]
        bases.append(f"{h} d: {len(reversed_)} of {len(rows)} ({len(reversed_) / len(rows):.0%})" if rows else f"{h} d: –")
        for m in models:
            if not rows:
                table[m].append("–")
                continue
            called = [v[m] for v in rows if np.sign(v[m][0]) != np.sign(v[m][2])]
            hits = sum(np.sign(y) != np.sign(past) for _, y, past in called)
            right = np.mean([np.sign(v[m][0]) == np.sign(v[m][1]) for v in rows])
            precision = f"{hits / len(called):.0%}" if called else "–"
            table[m].append(f"{hits / len(reversed_):.0%} / {precision} ({len(called)}) / {right:.0%}")
    print(f"\nTrend reversals against the last {REVERSAL_DAYS} days (reversed: {', '.join(bases)}).")
    print("Reversals called / reversal calls right (calls) / direction right overall:\n")
    print("| Model | " + " | ".join(f"{h} d" for h in horizons) + " |")
    print("|---|" + "---|" * len(horizons))
    for m in models:
        print(f"| {m} | " + " | ".join(table[m]) + " |")


def report(results, coefs_by):
    for fuel, by_h in results.items():
        models = [m for m in MODELS if any(r[0] == m for rows in by_h.values() for r in rows)]
        print(f"\n## {fuel}: error in €/L (MAE / P90 / bias / 80 % interval coverage)\n")
        print("| Model | " + " | ".join(f"{h} d" for h in HORIZONS) + " |")
        print("|---|" + "---|" * len(HORIZONS))
        for m in models:
            cells = []
            for h in HORIZONS:
                rows = [r for r in by_h.get(h, []) if r[0] == m]
                if not rows:
                    cells.append("–")
                    continue
                mae, p90, bias = summary([r[2] for r in rows])
                cov = [r[3] for r in rows if r[3] is not None]
                cells.append(f"{mae:.4f} / {p90:.4f} / {bias:+.4f} / {np.mean(cov):.0%}" if cov else f"{mae:.4f} / {p90:.4f} / {bias:+.4f}")
            print(f"| {m} | " + " | ".join(cells) + " |")
        print("\nMAE without / with a tax change in the window (origins):\n")
        print("| Model | " + " | ".join(f"{h} d" for h in HORIZONS) + " |")
        print("|---|" + "---|" * len(HORIZONS))
        for m in models:
            cells = []
            for h in HORIZONS:
                rows = [r for r in by_h.get(h, []) if r[0] == m]
                calm = [abs(r[2]) for r in rows if not r[4]]
                taxed = [abs(r[2]) for r in rows if r[4]]
                fmt = lambda v: f"{np.mean(v):.4f} ({len(v)})" if v else "–"
                cells.append(f"{fmt(calm)} / {fmt(taxed)}")
            print(f"| {m} | " + " | ".join(cells) + " |")
        reversals(by_h, models)
        for model, coefs in coefs_by.get((fuel, 7), {}).items():
            c = np.array(coefs)
            print(f"\n{model}, 7 d, standardized coefficients over {len(c)} blocks (mean ± sd, share with the same sign):\n")
            for i, name in enumerate(FEATURE_NAMES[model]):
                same = np.mean(np.sign(c[:, i]) == np.sign(c[:, i].mean()))
                print(f"- {name}: {c[:, i].mean():+.4f} ± {c[:, i].std():.4f} ({same:.0%})")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("db")
    p.add_argument("--area", default="ES")
    p.add_argument("--holdout", type=int, default=365, help="days of origins kept for the final test")
    p.add_argument("--final", action="store_true", help="score the held-out period (once, at the end)")
    p.add_argument("--eia-lag", type=lambda v: v if v == "weekly" else int(v), default="weekly",
                   help='"weekly" (EIA\'s release schedule) or a delay in days')
    p.add_argument("--fresh-lag", type=int, help="also run linear-fresh with product prices this many days late")
    p.add_argument("--futures", action="store_true", help="also run pump+futures (needs the yf: series from `downloader markets`)")
    args = p.parse_args()

    db = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    series = ("ecb:USD", *PRODUCT.values(), *(FUTURES.values() if args.futures else ()))
    market = {name: load_market(db, name) for name in series}
    missing = [name for name, (dates, _) in market.items() if not dates]
    if missing:
        raise SystemExit(f"No data for {', '.join(missing)} in mercados: run `downloader markets 2006-10-01` on (a copy of) the database")
    changes = tax_change_dates()
    results, coefs_by = {}, {}
    for fuel in ("gasolina_95", "gasoleo_a"):
        s = Series(load_regions(db, fuel), fuel, args.area, market, args.eia_lag, args.fresh_lag, args.futures)
        days = sorted(s.pump)
        print(f"{fuel}: {len(days)} days from {days[0]} to {days[-1]}")
        results[fuel] = {}
        for h in HORIZONS:
            scored, coefs = run(s, h, args.holdout, args.final, changes)
            results[fuel][h] = scored
            coefs_by[(fuel, h)] = coefs
    print(f"\nArea {args.area}, {'held-out period' if args.final else f'walk-forward, last {args.holdout} days held out'}, EIA {'on its weekly schedule' if args.eia_lag == 'weekly' else f'{args.eia_lag} days late'}"
          + (f" (linear-fresh: {args.fresh_lag} days late)" if args.fresh_lag is not None else ""))
    report(results, coefs_by)


if __name__ == "__main__":
    main()
