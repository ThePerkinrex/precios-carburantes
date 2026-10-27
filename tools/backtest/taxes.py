"""Spain's fuel taxes over time, from data/fuel_taxes_es.csv.

Each row sets one component from `from` on, for a region and fuel:

- region: a Ministry IDCCAA code ("09"), "ES" (every region under the general IVA and
  hydrocarbon tax: all but Canarias 05, Ceuta 18 and Melilla 19) or "ALL".
- fuel: gasolina_95, gasoleo_a or both.
- component: state (hydrocarbon tax, state part, €/1000 L), regional (the regional part,
  €/1000 L), cut (a temporary cut in the hydrocarbon tax, €/1000 L), iva (fraction) and
  bonus (a discount at the pump after IVA, €/L).
- published: when it was known (blank: on `from`). A row published later can revise one for
  the same date, so `as_of` gives the schedule as it was known then.

Canarias, Ceuta and Melilla have their own taxes, which aren't modelled: components() returns
None for them (the bonus aside).
"""

import csv
import datetime as dt
import os

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "fuel_taxes_es.csv")
OWN_TAXES = {"05", "18", "19"}
FUELS = ("gasolina_95", "gasoleo_a")


def _date(s):
    return dt.date.fromisoformat(s) if s else None


def load(path=DATA):
    rows = []
    with open(path, newline="") as f:
        for r in csv.DictReader(f):
            if r["value"] == "":
                continue  # documentation only
            rows.append({
                "from": _date(r["from"]),
                "published": _date(r["published"]) or _date(r["from"]),
                "region": r["region"],
                "fuel": r["fuel"],
                "component": r["component"],
                "value": float(r["value"]),
            })
    return rows


_ROWS = None


def _rows():
    global _ROWS
    if _ROWS is None:
        _ROWS = load()
    return _ROWS


def _applies(row, ccaa, fuel):
    if row["fuel"] not in ("both", fuel):
        return False
    if row["region"] == "ALL":
        return True
    if row["region"] == "ES":
        return ccaa not in OWN_TAXES
    return row["region"] == ccaa


def _component(name, date, ccaa, fuel, as_of, default):
    best = None
    for r in _rows():
        if r["component"] != name or r["from"] > date or not _applies(r, ccaa, fuel):
            continue
        if as_of is not None and r["published"] > as_of:
            continue
        # The latest start wins, then the latest publication.
        key = (r["from"], r["published"])
        if best is None or key >= best[0]:
            best = (key, r["value"])
    return default if best is None else best[1]


def components(date, ccaa, fuel, as_of=None):
    """The taxes on `fuel` at `date` (datetime.date) in region `ccaa`, as known on `as_of`.

    Returns a dict: state, regional and cut in €/L, iva as a fraction and bonus in €/L, or None
    where the taxes aren't modelled (Canarias, Ceuta, Melilla, or dates before the data).
    """
    if ccaa in OWN_TAXES:
        return None
    state = _component("state", date, ccaa, fuel, as_of, None)
    iva = _component("iva", date, ccaa, fuel, as_of, None)
    if state is None or iva is None:
        return None
    return {
        "state": state / 1000,
        "regional": _component("regional", date, ccaa, fuel, as_of, 0.0) / 1000,
        "cut": _component("cut", date, ccaa, fuel, as_of, 0.0) / 1000,
        "iva": iva,
        "bonus": _component("bonus", date, ccaa, fuel, as_of, 0.0),
    }


def excise(c):
    """The hydrocarbon tax per litre in force (state + regional - cut)."""
    return c["state"] + c["regional"] - c["cut"]


def net_price(price, c):
    """The pump price without taxes (and without the pump bonus)."""
    return (price + c["bonus"]) / (1 + c["iva"]) - excise(c)


def pump_price(net, c):
    return (net + excise(c)) * (1 + c["iva"]) - c["bonus"]


def reprice(price, date, ccaa, fuel, to_date, as_of=None):
    """`price` seen at `date`, under the taxes of `to_date` instead, with full pass-through.

    None where the taxes aren't modelled. The 2026 changes only passed through 60-85 %, so this
    is the full-pass-through reference, not a prediction.
    """
    a = components(date, ccaa, fuel, as_of)
    b = components(to_date, ccaa, fuel, as_of)
    if a is None or b is None:
        return None
    return pump_price(net_price(price, a), b)


if __name__ == "__main__":
    # A quick look: the taxes on 1 €/L of diesel before tax, by region and year.
    for year in (2007, 2010, 2012, 2013, 2015, 2019, 2022, 2026):
        d = dt.date(year, 6, 15)
        line = []
        for ccaa in ("01", "09", "13", "15"):
            c = components(d, ccaa, "gasoleo_a")
            line.append(f"{ccaa}: {pump_price(1.0, c) - 1.0:.4f}" if c else f"{ccaa}: -")
        print(d, "  ".join(line))
