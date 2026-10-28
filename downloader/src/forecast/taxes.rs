//! Spain's fuel taxes over time, from tools/backtest/data/fuel_taxes_es.csv. A port of
//! tools/backtest/taxes.py, which documents the file.

use chrono::NaiveDate;

const CSV: &str = include_str!("../../../tools/backtest/data/fuel_taxes_es.csv");
/// Canarias, Ceuta and Melilla: their own taxes, which aren't modelled.
pub const OWN_TAXES: [&str; 3] = ["05", "18", "19"];

struct Row {
    from: NaiveDate,
    published: NaiveDate,
    region: String,
    fuel: String,
    component: String,
    value: f64,
}

pub struct Taxes {
    rows: Vec<Row>,
}

/// The taxes on a fuel at a date: state, regional and cut in €/L, iva as a fraction and the
/// pump bonus in €/L.
#[derive(Clone, Copy)]
pub struct Components {
    state: f64,
    regional: f64,
    cut: f64,
    pub iva: f64,
    bonus: f64,
}

impl Components {
    fn excise(&self) -> f64 {
        self.state + self.regional - self.cut
    }

    /// The pump price without taxes (and without the pump bonus).
    pub fn net_price(&self, price: f64) -> f64 {
        (price + self.bonus) / (1.0 + self.iva) - self.excise()
    }

    pub fn pump_price(&self, net: f64) -> f64 {
        (net + self.excise()) * (1.0 + self.iva) - self.bonus
    }
}

impl Taxes {
    pub fn load() -> Self {
        let date = |s: &str| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok();
        let rows = CSV
            .lines()
            .skip(1)
            .filter_map(|line| {
                // Only the notes after the sixth column are ever quoted.
                let f: Vec<&str> = line.splitn(7, ',').collect();
                if f.len() < 6 || f[5].is_empty() {
                    return None; // documentation only
                }
                let from = date(f[0])?;
                Some(Row {
                    from,
                    published: date(f[1]).unwrap_or(from),
                    region: f[2].to_string(),
                    fuel: f[3].to_string(),
                    component: f[4].to_string(),
                    value: f[5].parse().ok()?,
                })
            })
            .collect();
        Taxes { rows }
    }

    fn applies(row: &Row, ccaa: &str, fuel: &str) -> bool {
        if row.fuel != "both" && row.fuel != fuel {
            return false;
        }
        match row.region.as_str() {
            "ALL" => true,
            "ES" => !OWN_TAXES.contains(&ccaa),
            r => r == ccaa,
        }
    }

    fn component(
        &self,
        name: &str,
        date: NaiveDate,
        ccaa: &str,
        fuel: &str,
        as_of: Option<NaiveDate>,
    ) -> Option<f64> {
        let mut best: Option<((NaiveDate, NaiveDate), f64)> = None;
        for r in &self.rows {
            if r.component != name || r.from > date || !Self::applies(r, ccaa, fuel) {
                continue;
            }
            if as_of.is_some_and(|a| r.published > a) {
                continue;
            }
            // The latest start wins, then the latest publication, then the later row.
            let key = (r.from, r.published);
            if best.is_none_or(|(k, _)| key >= k) {
                best = Some((key, r.value));
            }
        }
        best.map(|(_, v)| v)
    }

    /// The taxes on `fuel` at `date` in region `ccaa`, as known on `as_of`, or None where they
    /// aren't modelled.
    pub fn components(
        &self,
        date: NaiveDate,
        ccaa: &str,
        fuel: &str,
        as_of: Option<NaiveDate>,
    ) -> Option<Components> {
        if OWN_TAXES.contains(&ccaa) {
            return None;
        }
        let state = self.component("state", date, ccaa, fuel, as_of)?;
        let iva = self.component("iva", date, ccaa, fuel, as_of)?;
        let or_zero = |name| self.component(name, date, ccaa, fuel, as_of).unwrap_or(0.0);
        Some(Components {
            state: state / 1000.0,
            regional: or_zero("regional") / 1000.0,
            cut: or_zero("cut") / 1000.0,
            iva,
            bonus: or_zero("bonus"),
        })
    }

    /// Every date a tax on `fuel` changed, sorted.
    pub fn change_dates(&self, fuel: &str) -> Vec<NaiveDate> {
        let mut dates: Vec<NaiveDate> = self
            .rows
            .iter()
            .filter(|r| r.fuel == "both" || r.fuel == fuel)
            .map(|r| r.from)
            .collect();
        dates.sort();
        dates.dedup();
        dates
    }
}
