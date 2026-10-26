"""Checks a database after `downloader backfill` against a copy taken before it.

Usage: python3 check_backfill.py <before.db> <after.db> [json_dir]

- Every precios row sits on a snapshot, no station starts with an unreported row, and no row
  repeats its station's previous state (precios is change-only).
- At every snapshot of <before.db>, every station has the same state in both databases.
- For each backfill snapshot with a saved response in json_dir (named dd-mm-yyyy.json, as
  returned by EstacionesTerrestresHist/dd-mm-yyyy), the stored state matches the response, and
  precios_provincia matches the stored state. Stations missing from the response may keep the
  state they had at the previous snapshot if it's a live one (restricted-sale stations).

Prints the problems found and exits with 1 if there are any.
"""

import collections
import datetime
import json
import os
import sqlite3
import sys

MAX_SHOWN = 20


def load(db):
    snaps = [r[0] for r in db.execute("SELECT fecha FROM snapshots ORDER BY 1")]
    rows = collections.defaultdict(list)
    for i, f, r, a, b in db.execute(
        "SELECT id_estacion, fecha, reportado, gasoleo_a, gasolina_95 FROM precios ORDER BY 1, 2"
    ):
        rows[i].append((f, (a, b) if r else None))
    return snaps, rows


def expand(snaps, rows):
    """Each station's state at every snapshot (None: not reported)."""
    out = {}
    for i, rs in rows.items():
        states, k, cur = [], 0, None
        for s in snaps:
            while k < len(rs) and rs[k][0] <= s:
                cur = rs[k][1]
                k += 1
            states.append(cur)
        out[i] = states
    return out


def spanish_float(s):
    return float(s.replace(",", ".")) if s else None


def main(before_path, after_path, json_dir=None):
    before, after = sqlite3.connect(before_path), sqlite3.connect(after_path)
    problems = 0

    def problem(*msg):
        nonlocal problems
        problems += 1
        if problems <= MAX_SHOWN:
            print(*msg)

    bsnaps, brows = load(before)
    asnaps, arows = load(after)
    asnap_set = set(asnaps)

    for i, rs in arows.items():
        if rs[0][1] is None:
            problem("starts unreported", i, rs[0][0])
        for (_, s1), (f2, s2) in zip(rs, rs[1:]):
            if s1 == s2:
                problem("redundant row", i, f2)
        for f, _ in rs:
            if f not in asnap_set:
                problem("row off snapshot", i, f)

    bstates, astates = expand(bsnaps, brows), expand(asnaps, arows)
    index = {s: j for j, s in enumerate(asnaps)}
    for i in set(bstates) | set(astates):
        bv = bstates.get(i, [None] * len(bsnaps))
        av = astates.get(i, [None] * len(asnaps))
        for j, s in enumerate(bsnaps):
            if bv[j] != av[index[s]]:
                problem("changed at an earlier snapshot", i, s, bv[j], av[index[s]])

    if json_dir:
        live = {r[0] for r in after.execute("SELECT fecha FROM snapshots WHERE backfill = 0")}
        provinces = dict(after.execute("SELECT id, id_provincia FROM estaciones"))
        for s in [r[0] for r in after.execute("SELECT fecha FROM snapshots WHERE backfill = 1 ORDER BY 1")]:
            day = datetime.datetime.fromtimestamp(s).strftime("%d-%m-%Y")
            path = os.path.join(json_dir, day + ".json")
            if not os.path.exists(path):
                continue
            with open(path) as f:
                listed = {
                    int(e["IDEESS"]): (spanish_float(e["Precio Gasoleo A"]), spanish_float(e["Precio Gasolina 95 E5"]))
                    for e in json.load(f)["ListaEESSPrecio"]
                }
            j = index[s]
            stored = {i: v[j] for i, v in astates.items() if v[j] is not None}
            after_live = j > 0 and asnaps[j - 1] in live
            carried = {i for i in stored if i not in listed and after_live and astates[i][j - 1] == stored[i]}
            mismatches = [i for i in set(listed) | set(stored) if i not in carried and listed.get(i) != stored.get(i)]
            for i in mismatches:
                problem("differs from the response", day, i, listed.get(i), stored.get(i))

            sums = collections.defaultdict(lambda: [0.0, 0, 0.0, 0])
            for i, (a, b) in stored.items():
                t = sums[provinces[i]]
                if a is not None:
                    t[0] += a
                    t[1] += 1
                if b is not None:
                    t[2] += b
                    t[3] += 1
            for p, sa, na, sb, nb in after.execute(
                "SELECT id_provincia, suma_gasoleo_a, n_gasoleo_a, suma_gasolina_95, n_gasolina_95"
                " FROM precios_provincia WHERE fecha = ?",
                (s,),
            ):
                e = sums.pop(p, [0.0, 0, 0.0, 0])
                if na != e[1] or nb != e[3] or abs((sa or 0) - e[0]) > 1e-6 or abs((sb or 0) - e[2]) > 1e-6:
                    problem("province average", day, p)
            for p in sums:
                problem("missing province average", day, p)
            print(f"{day}: {len(listed)} listed, {len(carried)} carried, {len(mismatches)} mismatches")

    print(
        f"snapshots {len(bsnaps)} -> {len(asnaps)}, rows "
        f"{sum(map(len, brows.values()))} -> {sum(map(len, arows.values()))}, problems {problems}"
    )
    return 1 if problems else 0


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        sys.exit(__doc__)
    sys.exit(main(*sys.argv[1:]))
