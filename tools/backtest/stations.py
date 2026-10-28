"""Backtests forecasts of whether a single station's price will be lower, the same or higher
1, 3 and 7 days ahead (issue #11).

Usage: python3 stations.py <db> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--holdout DAYS] [--final]
                               [--futures]

A station's price is a step function: it changes on about one day in five, by about a cent, and
each owner (most stations are franchises, whatever the brand) sets its own pace. So instead of a
price, the models give the probabilities of the three outcomes at T + h (down, same or up by at
least EPS), from what was known at the end of day T. Prices are each station's state at the end
of the day (the precios table stores changes only; a station out of the feed has no price).
Stations under their own taxes (Canarias, Ceuta, Melilla) are left out, as in backtest.py.

Models:
- climatology: the training shares of the three outcomes.
- station: the station's own outcome shares at the same horizon over the STATION_DAYS before
  T, shrunk toward climatology (by PRIOR_ROWS pseudo-observations).
- national: a multinomial logistic regression on the national forecast alone: backtest.py's
  pump+futures+trend (pump+trend without --futures) change to T + h, out of sample, the scheduled
  tax effect and the national change over the last 7 days.
- full: the national inputs plus the station's state and habits:
  - its gap to the national average against its mean gap over the GAP_DAYS before T (a station
    above its usual gap tends to come down), and how much less it has moved than the national
    average over the last 3, 7 and 14 days (a slow owner still catching up);
  - days since its last change, whether it changed on T, its own change over the last 2 days;
  - its habits over the STATION_DAYS before T, shrunk toward the average station: how often it
    changes, the share of its changes that were rises, and from its rate per weekday the chance
    of at least one change over the target days;
  - those habits times the national forecast, the gap and the tax effect (a fast station follows
    them sooner);
  - its peers: stations in the same province that changed on the same days as it over the
    STATION_DAYS before the block (Jaccard similarity of their change days of at least PEER_J),
    which are usually the same owner. The share of peers that went down or up over the last 2
    days, and the same when the station itself hasn't moved yet.

Validation: walk-forward like backtest.py, over VALIDATION_DAYS blocks of origins from --from to
--to. Each block trains on up to TRAIN_ROWS random station-days among the TRAIN_DAYS of origins
before it whose target is before the block. The national forecasts come from backtest.py's own
walk-forward, so they are out of sample too. The last --holdout days of origins (as in
backtest.py) are left out unless --final, which scores only them, once.

Scores per model and horizon: log loss and Brier score of the three probabilities (lower is
better), accuracy of the likeliest outcome, and the "wait" calls: the share of station-days where
the model gives P(down) > 0.5, how often the price did go down, and the mean saving of waiting
h days to fill up on those days instead of filling up at T, in c€/L.
"""

import argparse
import collections
import datetime as dt
import sqlite3
import time

import numpy as np

import backtest as B
import taxes

DAY = B.DAY
HORIZONS = (1, 3, 7)
EPS = 0.0005
VALIDATION_DAYS = 28
TRAIN_DAYS = 365
TRAIN_ROWS = 150_000
STATION_DAYS = 182
GAP_DAYS = 90
PRIOR_ROWS = 10
PRIOR_DAYS = 30
PEER_J = 0.5
PEER_MIN = 8
RIDGE = 1.0
LOOKBACK = STATION_DAYS + 14
MODELS = ("climatology", "station", "national", "full")
NATIONAL = ("national forecast", "tax effect", "national 7 d change")
STATION = ("gap vs usual", "pending 3 d", "pending 7 d", "pending 14 d", "days since change",
           "changed today", "own 2 d change", "change rate", "rise share", "chance of a change",
           "national × chance", "gap × chance", "pending 7 d × chance", "tax × chance",
           "peers down", "peers up", "peers down, not me", "peers up, not me", "peers")
FEATURES = NATIONAL + STATION
WEEKDAYS = 7


# ---------- Data ----------

def local_ts(day):
    return int(time.mktime(day.timetuple()))


def load_prices(db, fuel, start, end):
    """(days, station ids, province per station, prices): the end-of-day price of every station
    under the general taxes, days x stations, NaN where it had none or no snapshot was taken."""
    stations = db.execute("SELECT id, id_provincia, id_ccaa FROM estaciones ORDER BY id").fetchall()
    stations = [(i, p) for i, p, c in stations if c not in taxes.OWN_TAXES]
    ids = np.array([i for i, _ in stations])
    col = {i: k for k, i in enumerate(ids)}
    provinces = np.array([p or "" for _, p in stations])
    days = [start + k * DAY for k in range((end - start).days + 1)]
    row = {d: k for k, d in enumerate(days)}
    # NOTHING marks "no new row that day": the state carries over.
    NOTHING = -1.0
    events = np.full((len(days), len(ids)), NOTHING, dtype=np.float32)
    first = np.full(len(ids), np.nan, dtype=np.float32)
    for sid, reported, price in db.execute(f"""
            SELECT p.id_estacion, p.reportado, p.{fuel} FROM precios p
            JOIN (SELECT id_estacion, MAX(fecha) AS fecha FROM precios WHERE fecha < ? GROUP BY id_estacion) q
            ON p.id_estacion = q.id_estacion AND p.fecha = q.fecha""", (local_ts(start),)):
        if sid in col:
            first[col[sid]] = price if reported and price else np.nan
    for sid, day, reported, price in db.execute(f"""
            SELECT id_estacion, date(fecha, 'unixepoch', 'localtime'), reportado, {fuel} FROM precios
            WHERE fecha >= ? AND fecha < ? ORDER BY fecha""", (local_ts(start), local_ts(end + DAY))):
        if sid in col:
            events[row[dt.date.fromisoformat(day)], col[sid]] = price if reported and price else np.nan
    snapshot_days = {dt.date.fromisoformat(d) for (d,) in db.execute(
        "SELECT DISTINCT date(fecha, 'unixepoch', 'localtime') FROM snapshots WHERE fecha >= ? AND fecha < ?",
        (local_ts(start), local_ts(end + DAY)))}
    prices = np.empty_like(events)
    state = first
    for k in range(len(days)):
        state = np.where(events[k] == NOTHING, state, events[k])
        prices[k] = state
        if days[k] not in snapshot_days:
            prices[k] = np.nan
    return days, ids, provinces, prices


def window_sum(cs, i, s, w):
    """Station s's sum over rows (i - w, i] from an exclusive cumulative sum (cs[k] = sum of rows < k)."""
    return (cs[i + 1, s] - cs[np.maximum(i + 1 - w, 0), s]).astype(float)


def cumulative(x, dtype):
    out = np.zeros((x.shape[0] + 1, *x.shape[1:]), dtype=dtype)
    np.cumsum(x, axis=0, dtype=dtype, out=out[1:])
    return out


class Stations:
    """Every station's prices and the matrices its features are read from."""

    def __init__(self, days, ids, provinces, prices, national):
        self.days, self.ids, self.provinces, self.P = days, ids, provinces, prices
        self.row = {d: k for k, d in enumerate(days)}
        self.N = np.array([national.get(d, np.nan) for d in days])
        P = prices
        step = np.full_like(P, np.nan)
        step[1:] = P[1:] - P[:-1]
        self.valid = np.isfinite(step)
        self.C = np.where(self.valid, np.sign(step) * (np.abs(step) >= EPS), 0).astype(np.int8)
        changed = self.C != 0
        self.cs_obs = cumulative(self.valid, np.int16)
        self.cs_chg = cumulative(changed, np.int16)
        self.cs_up = cumulative(self.C > 0, np.int16)
        weekday = np.array([d.weekday() for d in days])
        self.weekday = weekday
        self.cs_wd_chg = [cumulative(changed & (weekday == w)[:, None], np.int16) for w in range(WEEKDAYS)]
        self.cs_wd_obs = [cumulative(self.valid & (weekday == w)[:, None], np.int16) for w in range(WEEKDAYS)]
        gap = P - self.N[:, None]
        self.gap = gap
        self.cs_gap = cumulative(np.nan_to_num(gap), np.float64)
        self.cs_gap_n = cumulative(np.isfinite(gap), np.int16)
        since = np.zeros(P.shape, dtype=np.int16)
        for k in range(1, len(days)):
            since[k] = np.where(changed[k], 0, np.minimum(since[k - 1] + 1, 365))
        self.since = since
        self._outcomes = (None, None)

    def outcomes(self, h):
        """Exclusive cumulative counts of each outcome (down, same, up) at horizon h, by origin."""
        if self._outcomes[0] != h:
            change = np.full(self.P.shape, np.nan, dtype=np.float32)
            change[:-h] = self.P[h:] - self.P[:-h]
            known = np.isfinite(change)
            self._outcomes = (h, [cumulative(known & m, np.int16) for m in
                                  (change <= -EPS, np.abs(change) < EPS, change >= EPS)])
        return self._outcomes[1]

    def target(self, i, s, h):
        """Outcome classes 0 down, 1 same, 2 up (NaN if unknown) and the change, at rows i."""
        j = i + h
        ok = j < len(self.days)
        change = np.full(len(i), np.nan)
        change[ok] = self.P[j[ok], s[ok]] - self.P[i[ok], s[ok]]
        cls = np.where(change <= -EPS, 0, np.where(change >= EPS, 2, 1)).astype(float)
        cls[~np.isfinite(change)] = np.nan
        return cls, change


# ---------- Features ----------

def peer_shares(st, lo, rows):
    """For each day in `rows`: the share of each station's peers whose price went down / up over
    the last 2 days, and its peer count, with peers found over the STATION_DAYS before day lo."""
    win = slice(max(lo - STATION_DAYS, 1), lo)
    changed = (st.C[win] != 0).astype(np.float32)
    move = np.full((len(rows), st.P.shape[1]), np.nan, dtype=np.float32)
    ok = rows >= 2
    move[ok] = st.P[rows[ok]] - st.P[rows[ok] - 2]
    down, up = (move <= -EPS).astype(np.float32), (move >= EPS).astype(np.float32)
    share_dn = np.zeros_like(move)
    share_up = np.zeros_like(move)
    count = np.zeros(st.P.shape[1], dtype=np.float32)
    for prov in np.unique(st.provinces):
        idx = np.flatnonzero(st.provinces == prov)
        c = changed[:, idx]
        co = c.T @ c
        n = np.diag(co).copy()
        union = n[:, None] + n[None, :] - co
        with np.errstate(divide="ignore", invalid="ignore"):
            peers = (co / union >= PEER_J) & (n[:, None] >= PEER_MIN) & (n[None, :] >= PEER_MIN)
        np.fill_diagonal(peers, False)
        a = peers.astype(np.float32)
        k = a.sum(axis=1)
        count[idx] = k
        norm = np.maximum(k, 1)
        share_dn[:, idx] = (down[:, idx] @ a.T) / norm
        share_up[:, idx] = (up[:, idx] @ a.T) / norm
    return share_dn, share_up, count


class Block:
    """Feature rows for one block: national arrays per day, peers found before the block."""

    def __init__(self, st, nat, h, lo, rows, prior_rate):
        self.st, self.nat, self.h = st, nat, h
        self.prior_rate = prior_rate
        self.first = rows[0]
        self.peer_dn, self.peer_up, self.peer_n = peer_shares(st, lo, rows)

    def features(self, i, s):
        st, h, nat = self.st, self.h, self.nat
        P, N = st.P, st.N
        f_nat, tax = nat["forecast"][i], nat["tax"][i]
        n7 = N[i] - N[np.maximum(i - 7, 0)]
        # The usual gap: its mean over the GAP_DAYS before T (T itself left out).
        n_gap = st.cs_gap_n[i, s] - st.cs_gap_n[np.maximum(i - GAP_DAYS, 0), s]
        usual = (st.cs_gap[i, s] - st.cs_gap[np.maximum(i - GAP_DAYS, 0), s]) / np.maximum(n_gap, 1)
        dev = np.where(n_gap >= GAP_DAYS // 3, st.gap[i, s] - usual, np.nan)
        pend = [(N[i] - N[i - k]) - (P[i, s] - P[i - k, s]) for k in (3, 7, 14)]
        since = np.log1p(st.since[i, s].astype(float))
        moved = (st.C[i, s] != 0).astype(float)
        own2 = P[i, s] - P[i - 2, s]
        own2 = np.sign(own2) * (np.abs(own2) >= EPS)
        n_obs, n_chg, n_up = (window_sum(cs, i, s, STATION_DAYS) for cs in (st.cs_obs, st.cs_chg, st.cs_up))
        rate = (n_chg + PRIOR_DAYS * self.prior_rate) / (n_obs + PRIOR_DAYS)
        rise = (n_up + PRIOR_ROWS * 0.5) / (n_chg + PRIOR_ROWS) - 0.5
        stay = np.ones(len(i))
        wd_rate = {}
        for w in range(WEEKDAYS):
            c = window_sum(st.cs_wd_chg[w], i, s, STATION_DAYS)
            o = window_sum(st.cs_wd_obs[w], i, s, STATION_DAYS)
            wd_rate[w] = (c + 5 * self.prior_rate) / (o + 5)
        for k in range(1, h + 1):
            w = st.weekday[np.minimum(i + k, len(st.days) - 1)]
            r = np.choose(w, [wd_rate[x] for x in range(WEEKDAYS)])
            stay *= 1 - r
        chance = 1 - stay
        b = i - self.first
        dn, up, n_peers = self.peer_dn[b, s], self.peer_up[b, s], self.peer_n[s]
        still = (own2 == 0).astype(float)
        X = np.column_stack([
            f_nat, tax, n7,
            dev, *pend, since, moved, own2, rate, rise, chance,
            f_nat * chance, dev * chance, pend[1] * chance, tax * chance,
            dn, up, dn * still, up * still, np.log1p(n_peers),
        ])
        return X

    def station_rates(self, i, s, climate):
        """The station's own outcome shares at this horizon over the STATION_DAYS before i."""
        st, h = self.st, self.h
        # Origins (i - STATION_DAYS, i - h]: their targets are known at i.
        counts = np.column_stack([window_sum(cs, i - h, s, STATION_DAYS - h) for cs in st.outcomes(h)])
        return (counts + PRIOR_ROWS * climate) / (counts.sum(axis=1, keepdims=True) + PRIOR_ROWS)


# ---------- Models ----------

def fit_softmax(X, y):
    """Multinomial logistic regression with "same" as the reference class, on standardized X with
    a ridge penalty, by Newton's method. Returns the model for predict_softmax."""
    mean, std = X.mean(axis=0), X.std(axis=0)
    flat = std < 1e-9
    std[flat] = 1
    Z = np.c_[np.ones(len(X)), (X - mean) / std]
    Z[:, 1:][:, flat] = 0
    F = Z.shape[1]
    T = np.c_[y == 0, y == 2].astype(float)
    W = np.zeros((F, 2))
    penalty = np.r_[0, np.full(F - 1, RIDGE)]
    for _ in range(30):
        eta = Z @ W
        top = np.maximum(eta.max(axis=1), 0)
        e = np.exp(eta - top[:, None])
        p = e / (np.exp(-top) + e.sum(axis=1))[:, None]
        grad = Z.T @ (T - p) - penalty[:, None] * W
        H = np.zeros((2 * F, 2 * F))
        for a in range(2):
            for c in range(2):
                w = p[:, a] * ((a == c) - p[:, c])
                H[a * F:(a + 1) * F, c * F:(c + 1) * F] = -(Z * w[:, None]).T @ Z
        H -= np.diag(np.r_[penalty, penalty])
        delta = np.linalg.solve(H, grad.T.ravel())
        W -= delta.reshape(2, F).T
        if np.abs(delta).max() < 1e-6:
            break
    return {"mean": mean, "std": std, "flat": flat, "W": W}


def predict_softmax(model, X):
    Z = (X - model["mean"]) / model["std"]
    Z[:, model["flat"]] = 0
    eta = np.c_[np.ones(len(X)), Z] @ model["W"]
    full = np.c_[eta[:, 0], np.zeros(len(X)), eta[:, 1]]
    full -= full.max(axis=1, keepdims=True)
    e = np.exp(full)
    return e / e.sum(axis=1, keepdims=True)


# ---------- National inputs ----------

def national_inputs(s, st, h, holdout, final, futures):
    """{"forecast", "tax"}: per row of st, the national model's out-of-sample change to T + h
    and the scheduled tax effect, NaN where unknown."""
    name = "pump+futures+trend" if futures else "pump+trend"
    changes = B.tax_change_dates()
    forecast = np.full(len(st.days), np.nan)
    modes = (False, True) if final else (False,)
    for mode in modes:
        scored, _ = B.run(s, h, holdout, mode, changes)
        for model, t, err, _, _, y, _ in scored:
            if model == name and t in st.row:
                forecast[st.row[t]] = y - err
    tax = np.full(len(st.days), np.nan)
    for k, d in enumerate(st.days):
        if np.isfinite(forecast[k]) and d in s.regions:
            tax[k] = s.tax_effect(d, d + h * DAY)
    return {"forecast": forecast, "tax": tax}


# ---------- Validation ----------

def rows_of(st, i_range, rng=None, limit=None):
    """All (row, station) pairs for rows in i_range with a price, or a random `limit` of them."""
    i, s = np.nonzero(np.isfinite(st.P[i_range]))
    i = i + i_range.start
    if limit is not None and len(i) > limit:
        pick = rng.choice(len(i), limit, replace=False)
        i, s = i[pick], s[pick]
    return i, s


def usable(st, X, cls):
    return np.isfinite(X).all(axis=1) & np.isfinite(cls)


def run(st, nat, h, first, last, rng):
    """Scores every model over the blocks of origins from row `first` to row `last`."""
    stats = {m: collections.defaultdict(float) for m in MODELS}
    coefs = []
    prior_rate = st.cs_chg[first].sum() / max(st.cs_obs[first].sum(), 1)
    lo = first
    while lo <= last:
        hi = min(lo + VALIDATION_DAYS, last + 1)
        train_lo = max(lo - TRAIN_DAYS, LOOKBACK)
        train_hi = lo - h  # targets before the block
        block_rows = np.arange(train_lo, hi)
        if train_hi - train_lo < VALIDATION_DAYS:
            lo = hi
            continue
        blk = Block(st, nat, h, lo, block_rows, prior_rate)
        ti, ts = rows_of(st, range(train_lo, train_hi), rng, TRAIN_ROWS * 2)
        Xt = blk.features(ti, ts)
        ct, _ = st.target(ti, ts, h)
        ok = usable(st, Xt, ct)
        Xt, ct = Xt[ok][:TRAIN_ROWS], ct[ok][:TRAIN_ROWS]
        vi, vs = rows_of(st, range(lo, hi))
        Xv = blk.features(vi, vs)
        cv, change = st.target(vi, vs, h)
        ok = usable(st, Xv, cv)
        vi, vs, Xv, cv, change = vi[ok], vs[ok], Xv[ok], cv[ok], change[ok]
        lo = hi
        if len(ct) < 1000 or not len(cv):
            continue
        climate = np.bincount(ct.astype(int), minlength=3) / len(ct)
        full = fit_softmax(Xt, ct)
        national = fit_softmax(Xt[:, :len(NATIONAL)], ct)
        coefs.append((full["W"][1:] * ~full["flat"][:, None]).T)
        probs = {
            "climatology": np.tile(climate, (len(cv), 1)),
            "station": blk.station_rates(vi, vs, climate),
            "national": predict_softmax(national, Xv[:, :len(NATIONAL)]),
            "full": predict_softmax(full, Xv),
        }
        onehot = np.eye(3)[cv.astype(int)]
        for m, p in probs.items():
            a = stats[m]
            a["n"] += len(cv)
            a["logloss"] -= np.log(np.clip(p[np.arange(len(cv)), cv.astype(int)], 1e-12, 1)).sum()
            a["brier"] += ((p - onehot) ** 2).sum()
            a["right"] += (p.argmax(axis=1) == cv).sum()
            wait = p[:, 0] > 0.5
            a["wait"] += wait.sum()
            a["wait_right"] += (cv[wait] == 0).sum()
            a["wait_saving"] -= change[wait].sum()
        a = stats["climatology"]
        for c in range(3):
            a[f"class{c}"] += (cv == c).sum()
        a["saving_all"] -= change.sum()
    return stats, coefs


def report(results, coefs_by, label):
    print(label)
    for fuel, by_h in results.items():
        print(f"\n## {fuel}\n")
        for h, stats in by_h.items():
            base = stats["climatology"]
            n = base["n"]
            if not n:
                print(f"{h} d: no origins scored\n")
                continue
            print(f"### {h} d: {int(n)} station-days; down {base['class0'] / n:.0%}, same {base['class1'] / n:.0%}, "
                  f"up {base['class2'] / n:.0%}; waiting saves {base['saving_all'] / n * 100:+.3f} c€/L on average\n")
            print("| Model | log loss | Brier | accuracy | wait calls | wait calls right | saving when waiting (c€/L) |")
            print("|---|---|---|---|---|---|---|")
            for m in MODELS:
                a = stats[m]
                w = a["wait"]
                right = f"{a['wait_right'] / w:.0%}" if w else "–"
                saving = f"{a['wait_saving'] / w * 100:+.2f}" if w else "–"
                print(f"| {m} | {a['logloss'] / n:.4f} | {a['brier'] / n:.4f} | {a['right'] / n:.1%} | "
                      f"{w / n:.1%} | {right} | {saving} |")
            print()
        print("full model, standardized coefficients vs \"same\" (mean over blocks), down / up:\n")
        hs = [h for h in by_h if coefs_by[(fuel, h)]]
        print("| Feature | " + " | ".join(f"{h} d" for h in hs) + " |")
        print("|---|" + "---|" * len(hs))
        means = {h: np.mean(coefs_by[(fuel, h)], axis=0) for h in hs}
        for k, name in enumerate(FEATURES):
            print(f"| {name} | " + " | ".join(f"{means[h][0, k]:+.2f} / {means[h][1, k]:+.2f}" for h in hs) + " |")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("db")
    p.add_argument("--from", dest="start", type=dt.date.fromisoformat, help="first origin scored (default: 3 years before the holdout)")
    p.add_argument("--to", dest="end", type=dt.date.fromisoformat, help="last origin scored (default: the holdout's start)")
    p.add_argument("--holdout", type=int, default=365, help="days of origins kept for the final test")
    p.add_argument("--final", action="store_true", help="score the held-out period (once, at the end)")
    p.add_argument("--futures", action="store_true", help="national forecast from pump+futures+trend (needs the yf: series)")
    args = p.parse_args()

    db = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    series = ("ecb:USD", *B.PRODUCT.values(), *(B.FUTURES.values() if args.futures else ()))
    market = {name: B.load_market(db, name) for name in series}
    missing = [name for name, (dates, _) in market.items() if not dates]
    if missing:
        raise SystemExit(f"No data for {', '.join(missing)} in mercados: run `downloader markets 2006-10-01` on (a copy of) the database")
    rng = np.random.default_rng(0)
    results, coefs_by = {}, {}
    for fuel in ("gasolina_95", "gasoleo_a"):
        s = B.Series(B.load_regions(db, fuel), fuel, "ES", market, "weekly", None, args.futures)
        days = sorted(s.pump)
        cut = days[-1] - dt.timedelta(days=args.holdout)
        start = cut + DAY if args.final else (args.start or cut - dt.timedelta(days=3 * 365))
        end = days[-1] if args.final else min(args.end or cut, cut)
        load_from = start - dt.timedelta(days=TRAIN_DAYS + LOOKBACK + 7)
        t0 = time.time()
        st = Stations(*load_prices(db, fuel, load_from, min(end + dt.timedelta(days=max(HORIZONS)), days[-1])), s.pump)
        print(f"{fuel}: {st.P.shape[1]} stations, {load_from} to {st.days[-1]} loaded in {time.time() - t0:.0f} s; scoring {start} to {end}")
        results[fuel] = {}
        for h in HORIZONS:
            nat = national_inputs(s, st, h, args.holdout, args.final, args.futures)
            stats, coefs = run(st, nat, h, st.row[start], st.row[min(end, st.days[-1])], rng)
            results[fuel][h] = stats
            coefs_by[(fuel, h)] = coefs
    national = "pump+futures+trend" if args.futures else "pump+trend"
    report(results, coefs_by, f"\nStations under the general taxes, {'held-out period' if args.final else 'walk-forward'}; national forecast: {national}")


if __name__ == "__main__":
    main()
