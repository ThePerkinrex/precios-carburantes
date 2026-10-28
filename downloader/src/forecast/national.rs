//! The national forecast: Spain's average pump price (stations under the general taxes)
//! 1-14 days ahead, by pump+futures+trend. A port of tools/backtest/backtest.py, which
//! documents and backtests the model; only what that model needs is here.
//!
//! The forecast is the change y = pump(T + h) - pump(T) from the end of day T: the mean of
//! - pump+futures: Δtax (the change scheduled taxes cause with full pass-through) plus a ridge
//!   regression of the rest on Δtax, the recent tax change, the pre-tax price's daily changes
//!   over 7 days and weekly ones over 7-28 days, the margin over the futures' price and its
//!   rises and falls over 0-7, 7-14 and 14-28 days, and the target's weekday;
//! - tax+trend: Δtax plus the damped 7-day trend of the pre-tax price, spread over the target
//!   days by weekday activity.
//!
//! Its 80 % interval is the 10-90 % quantiles of the training residuals in units of volatility
//! (the standard deviation of daily pump changes over the last VOL_DAYS), times today's.

use std::{cell::RefCell, collections::HashMap, error::Error};

use chrono::{Datelike, Days, NaiveDate};
use nalgebra::{DMatrix, DVector};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::{
    linalg::{Scaling, matrix, quantile, solve},
    taxes::{OWN_TAXES, Taxes},
};

pub const HORIZONS: [u64; 4] = [1, 3, 7, 14];
const SETTLE_DAYS: u64 = 4;
const TREND_DAYS: u64 = 7;
const DAMPING: f64 = 0.8;
const VOL_DAYS: u64 = 28;
const ACTIVITY_DAYS: u64 = 365;
const RIDGE: f64 = 1.0;
const GAL: f64 = 3.785411784;
// The previous day's close: futures settle at 14:30 ET, 20:30 in Spain.
const FUTURES_LAG: u64 = 1;
const MIN_TRAIN: usize = 90;
pub const GAP_DAYS: u64 = 28;
pub const VALIDATION_DAYS: u64 = 28;

fn futures_serie(fuel: &str) -> &'static str {
    if fuel == "gasoleo_a" {
        "yf:HO=F"
    } else {
        "yf:RB=F"
    }
}

fn sub(d: NaiveDate, days: u64) -> NaiveDate {
    d - Days::new(days)
}

fn add(d: NaiveDate, days: u64) -> NaiveDate {
    d + Days::new(days)
}

fn weekday(d: NaiveDate) -> usize {
    d.weekday().num_days_from_monday() as usize
}

/// A region's average price and how many stations it's over.
type Region = (String, f64, f64);

/// Each day's regions under the general taxes at the day's last snapshot.
fn load_regions(conn: &Connection, fuel: &str) -> Result<Vec<(NaiveDate, Region)>, Box<dyn Error>> {
    let (s, n) = if fuel == "gasoleo_a" {
        ("suma_gasoleo_a", "n_gasoleo_a")
    } else {
        ("suma_gasolina_95", "n_gasolina_95")
    };
    let mut stmt = conn.prepare(&format!(
        "WITH picked AS (SELECT MAX(fecha) AS fecha FROM snapshots GROUP BY date(fecha, 'unixepoch', 'localtime'))
        SELECT date(pp.fecha, 'unixepoch', 'localtime'), id_ccaa, SUM({s}), SUM({n})
        FROM picked CROSS JOIN precios_provincia pp ON pp.fecha = picked.fecha
        GROUP BY pp.fecha, id_ccaa"
    ))?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<f64>>(2)?,
            row.get::<_, f64>(3)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (day, ccaa, total, count) = row?;
        if count > 0.0 && !OWN_TAXES.contains(&ccaa.as_str()) {
            out.push((
                NaiveDate::parse_from_str(&day, "%Y-%m-%d")?,
                (ccaa, total.unwrap_or(0.0) / count, count),
            ));
        }
    }
    Ok(out)
}

/// A daily market series: dates and values, sorted.
pub type Market = (Vec<NaiveDate>, Vec<f64>);

pub fn load_market(conn: &Connection, serie: &str) -> Result<Market, Box<dyn Error>> {
    let mut stmt =
        conn.prepare("SELECT fecha, valor FROM mercados WHERE serie = ? ORDER BY fecha")?;
    let mut dates = Vec::new();
    let mut values = Vec::new();
    for row in stmt.query_map([serie], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
    })? {
        let (d, v) = row?;
        dates.push(NaiveDate::parse_from_str(&d, "%Y-%m-%d")?);
        values.push(v);
    }
    Ok((dates, values))
}

/// The value at the last date on or before `day`: its index.
fn last_at(dates: &[NaiveDate], day: NaiveDate) -> Option<usize> {
    dates.partition_point(|&d| d <= day).checked_sub(1)
}

struct Day {
    regions: Vec<Region>,
    pump: f64,
    net: f64,
    iva: f64,
}

/// One fuel in Spain: daily pump and pre-tax prices, and the tax effects.
pub struct Series<'a> {
    taxes: &'a Taxes,
    fuel: String,
    first: NaiveDate,
    days: Vec<Option<Day>>,
    futures: Market,
    usd: Market,
    tax_changes: Vec<NaiveDate>,
    activity: RefCell<HashMap<NaiveDate, Option<[f64; 7]>>>,
}

impl<'a> Series<'a> {
    pub fn load(conn: &Connection, taxes: &'a Taxes, fuel: &str) -> Result<Self, Box<dyn Error>> {
        let regions = load_regions(conn, fuel)?;
        let first = regions.first().ok_or("sin precios")?.0;
        let last = regions.last().unwrap().0;
        let mut by_day: Vec<Vec<Region>> = (0..=(last - first).num_days())
            .map(|_| Vec::new())
            .collect();
        for (day, region) in regions {
            by_day[(day - first).num_days() as usize].push(region);
        }
        let days = by_day
            .into_iter()
            .enumerate()
            .map(|(k, regions)| {
                let day = add(first, k as u64);
                let with: Vec<_> = regions
                    .into_iter()
                    .filter_map(|r| taxes.components(day, &r.0, fuel, None).map(|c| (r, c)))
                    .collect();
                let total: f64 = with.iter().map(|((_, _, n), _)| n).sum();
                if total == 0.0 {
                    return None;
                }
                let avg = |f: &dyn Fn(f64, &super::taxes::Components) -> f64| {
                    with.iter().map(|((_, p, n), c)| f(*p, c) * n).sum::<f64>() / total
                };
                Some(Day {
                    pump: avg(&|p, _| p),
                    net: avg(&|p, c| c.net_price(p)),
                    iva: avg(&|_, c| c.iva),
                    regions: with.into_iter().map(|(r, _)| r).collect(),
                })
            })
            .collect();
        let futures = load_market(conn, futures_serie(fuel))?;
        let usd = load_market(conn, "ecb:USD")?;
        if futures.0.is_empty() || usd.0.is_empty() {
            return Err(format!("faltan {} o ecb:USD en mercados", futures_serie(fuel)).into());
        }
        Ok(Series {
            taxes,
            fuel: fuel.to_string(),
            first,
            days,
            futures,
            usd,
            tax_changes: taxes.change_dates(fuel),
            activity: RefCell::new(HashMap::new()),
        })
    }

    fn day(&self, d: NaiveDate) -> Option<&Day> {
        let k = (d - self.first).num_days();
        if k < 0 {
            return None;
        }
        self.days.get(k as usize)?.as_ref()
    }

    pub fn pump(&self, d: NaiveDate) -> Option<f64> {
        self.day(d).map(|x| x.pump)
    }

    fn net(&self, d: NaiveDate) -> Option<f64> {
        self.day(d).map(|x| x.net)
    }

    /// Every day with prices, oldest first.
    pub fn dates(&self) -> impl Iterator<Item = NaiveDate> + '_ {
        self.days
            .iter()
            .enumerate()
            .filter(|(_, d)| d.is_some())
            .map(|(k, _)| add(self.first, k as u64))
    }

    pub fn last_day(&self) -> NaiveDate {
        self.dates().last().unwrap()
    }

    /// Whether `day` is a tax change's day or one of the SETTLE_DAYS after it.
    fn settling(&self, day: NaiveDate) -> bool {
        let i = self
            .tax_changes
            .partition_point(|&c| c < sub(day, SETTLE_DAYS));
        i < self.tax_changes.len() && self.tax_changes[i] <= day
    }

    /// Each weekday's mean absolute daily change of the pre-tax price over the ACTIVITY_DAYS
    /// before `day`'s month, relative to their mean (Monday first).
    fn activity(&self, day: NaiveDate) -> Option<[f64; 7]> {
        let month = day.with_day(1).unwrap();
        *self.activity.borrow_mut().entry(month).or_insert_with(|| {
            let mut sum = [0.0; 7];
            let mut count = [0usize; 7];
            for k in 1..=ACTIVITY_DAYS {
                let d = sub(month, k);
                if let (Some(a), Some(b)) = (self.net(d), self.net(sub(d, 1))) {
                    sum[weekday(d)] += (a - b).abs();
                    count[weekday(d)] += 1;
                }
            }
            if count.contains(&0) {
                return None;
            }
            let a: Vec<f64> = (0..7).map(|k| sum[k] / count[k] as f64).collect();
            let mean = a.iter().sum::<f64>() / 7.0;
            if mean == 0.0 {
                return None;
            }
            Some(std::array::from_fn(|k| a[k] / mean))
        })
    }

    /// The pump price change from `origin` to `target` that taxes cause with full
    /// pass-through, with the schedule known at `origin`.
    fn tax_effect(&self, origin: NaiveDate, target: NaiveDate) -> f64 {
        let regions = &self.day(origin).unwrap().regions;
        let total: f64 = regions.iter().map(|(_, _, n)| n).sum();
        let mut effect = 0.0;
        for (c, p, n) in regions {
            let now = self.taxes.components(origin, c, &self.fuel, Some(origin));
            let then = self.taxes.components(target, c, &self.fuel, Some(origin));
            if let (Some(now), Some(then)) = (now, then) {
                effect += (then.pump_price(now.net_price(*p)) - p) * n;
            }
        }
        effect / total
    }

    /// The futures' price in €/L as known at `day` (the close FUTURES_LAG days before).
    fn product_eur(&self, day: NaiveDate) -> Option<f64> {
        let cutoff = sub(day, FUTURES_LAG);
        let i = last_at(&self.futures.0, cutoff)?;
        if (cutoff - self.futures.0[i]).num_days() > 7 {
            return None;
        }
        let j = last_at(&self.usd.0, self.futures.0[i])?;
        Some(self.futures.1[i] / GAL / self.usd.1[j])
    }

    /// pump+futures' inputs at origin t for horizon h, or None if data is missing.
    fn features(&self, t: NaiveDate, h: u64) -> Option<Vec<f64>> {
        self.day(sub(t, SETTLE_DAYS))?;
        let back: Vec<u64> = (0..8).chain([14, 21, 28]).collect();
        let n = back
            .iter()
            .map(|&k| self.net(sub(t, k)))
            .collect::<Option<Vec<f64>>>()?;
        let product = [0, 7, 14, 28].map(|k| self.product_eur(sub(t, k)));
        let [Some(p0), Some(p7), Some(p14), Some(p28)] = product else {
            return None;
        };
        let gross = 1.0 + self.day(t)?.iva;
        let changes = [(p0 - p7) * gross, (p7 - p14) * gross, (p14 - p28) * gross];
        let mut x = vec![
            self.tax_effect(t, add(t, h)),
            self.tax_effect(sub(t, SETTLE_DAYS), t),
        ];
        x.extend((0..10).map(|k| (n[k] - n[k + 1]) * gross));
        x.push((n[0] - p0) * gross);
        x.extend(changes.map(|c| c.max(0.0)));
        x.extend(changes.map(|c| c.min(0.0)));
        let wd = weekday(add(t, h));
        x.extend((0..6).map(|k| if wd == k { 1.0 } else { 0.0 }));
        Some(x)
    }

    /// tax+trend's forecast, or None without a trend.
    fn tax_trend(&self, t: NaiveDate, h: u64, tax: f64) -> Option<f64> {
        let gross = 1.0 + self.day(t)?.iva;
        let past = self.net(sub(t, TREND_DAYS))?;
        let activity = self.activity(t)?;
        let slope = (self.net(t)? - past) / TREND_DAYS as f64;
        let steps: f64 = (1..=h)
            .map(|k| DAMPING.powi(k as i32) * activity[weekday(add(t, k))])
            .sum();
        Some(tax + gross * slope * steps)
    }

    /// The standard deviation of daily pump changes over the VOL_DAYS before t, leaving out
    /// days settling a tax change, or None.
    fn volatility(&self, t: NaiveDate) -> Option<f64> {
        let changes: Vec<f64> = (0..VOL_DAYS)
            .map(|k| sub(t, k))
            .filter(|&d| !self.settling(d))
            .filter_map(|d| Some(self.pump(d)? - self.pump(sub(d, 1))?))
            .collect();
        if changes.len() < (VOL_DAYS / 2) as usize {
            return None;
        }
        let mean = changes.iter().sum::<f64>() / changes.len() as f64;
        let var = changes.iter().map(|c| (c - mean).powi(2)).sum::<f64>() / changes.len() as f64;
        Some(var.sqrt()).filter(|&v| v > 0.0)
    }

    /// The model's inputs at origin t for horizon h; the actual change if the target is known.
    pub fn sample(&self, t: NaiveDate, h: u64) -> Option<Sample> {
        self.day(t)?;
        let vol = self.volatility(t)?;
        let tax = self.tax_effect(t, add(t, h));
        Some(Sample {
            t,
            y: self.pump(add(t, h)).map(|p| p - self.pump(t).unwrap()),
            vol,
            tax_trend: self.tax_trend(t, h, tax),
            x: self.features(t, h),
        })
    }

    /// Every origin with a volatility, oldest first.
    pub fn samples(&self, h: u64) -> Vec<Sample> {
        self.dates().filter_map(|t| self.sample(t, h)).collect()
    }

    /// The scheduled tax effect over h days from t, if t has prices.
    pub fn tax_ahead(&self, t: NaiveDate, h: u64) -> Option<f64> {
        self.day(t).map(|_| self.tax_effect(t, add(t, h)))
    }
}

pub struct Sample {
    pub t: NaiveDate,
    pub y: Option<f64>,
    vol: f64,
    tax_trend: Option<f64>,
    x: Option<Vec<f64>>,
}

#[derive(Serialize, Deserialize)]
pub struct Ridge {
    mean: Vec<f64>,
    std: Vec<f64>,
    beta: Vec<f64>,
    intercept: f64,
}

impl Ridge {
    /// Ridge regression on standardized inputs. A feature that barely moved in training can't
    /// be learned: it gets no weight.
    fn fit(x: &[Vec<f64>], y: &[f64]) -> Option<Self> {
        let x = matrix(x);
        let scaling = Scaling::fit(&x, 1e-6);
        let z = scaling.apply(&x);
        let y = DVector::from_column_slice(y);
        let intercept = y.mean();
        let a = z.transpose() * &z + DMatrix::identity(z.ncols(), z.ncols()) * RIDGE;
        let mut beta = solve(a, z.transpose() * y.add_scalar(-intercept))?;
        for (b, &flat) in beta.iter_mut().zip(&scaling.flat) {
            if flat {
                *b = 0.0;
            }
        }
        Some(Ridge {
            mean: scaling.mean,
            std: scaling.std,
            beta: beta.as_slice().to_vec(),
            intercept,
        })
    }

    fn predict(&self, x: &[f64]) -> f64 {
        x.iter()
            .enumerate()
            .map(|(k, v)| (v - self.mean[k]) / self.std[k] * self.beta[k])
            .sum::<f64>()
            + self.intercept
    }
}

/// pump+futures+trend for one fuel and horizon, with its interval.
#[derive(Serialize, Deserialize)]
pub struct Model {
    ridge: Ridge,
    /// The 10 and 90 % quantiles of the training residuals, in units of volatility.
    band: [f64; 2],
}

/// A forecast change and its 80 % interval, in €/L.
pub struct Forecast {
    pub change: f64,
    pub low: f64,
    pub high: f64,
}

impl Model {
    /// Fits on the samples with a known target and features; None if there are too few.
    pub fn fit<'s>(samples: impl Iterator<Item = &'s Sample>) -> Option<Self> {
        let train: Vec<&Sample> = samples.filter(|s| s.y.is_some() && s.x.is_some()).collect();
        if train.len() < MIN_TRAIN {
            return None;
        }
        let x: Vec<Vec<f64>> = train.iter().map(|s| s.x.clone().unwrap()).collect();
        let y: Vec<f64> = train
            .iter()
            .map(|s| s.y.unwrap() - s.x.as_ref().unwrap()[0])
            .collect();
        let ridge = Ridge::fit(&x, &y)?;
        let mut model = Model {
            ridge,
            band: [0.0, 0.0],
        };
        let resid: Vec<f64> = train
            .iter()
            .filter_map(|s| Some((s.y? - model.change(s)?) / s.vol))
            .collect();
        if !resid.is_empty() {
            model.band = [quantile(&resid, 0.1), quantile(&resid, 0.9)];
        }
        Some(model)
    }

    fn change(&self, s: &Sample) -> Option<f64> {
        let x = s.x.as_ref()?;
        Some((x[0] + self.ridge.predict(x) + s.tax_trend?) / 2.0)
    }

    pub fn forecast(&self, s: &Sample) -> Option<Forecast> {
        let change = self.change(s)?;
        Some(Forecast {
            change,
            low: change + self.band[0] * s.vol,
            high: change + self.band[1] * s.vol,
        })
    }
}

/// Out-of-sample forecasts for every sample from `from` on, as the backtest makes them:
/// VALIDATION_DAYS blocks, each from a model fitted on targets at least GAP_DAYS before it.
pub fn walk_forward(samples: &[Sample], h: u64, from: NaiveDate) -> HashMap<NaiveDate, f64> {
    let mut out = HashMap::new();
    let Some(last) = samples.last().map(|s| s.t) else {
        return out;
    };
    let mut lo = from;
    while lo <= last {
        let hi = add(lo, VALIDATION_DAYS);
        let cutoff = sub(lo, GAP_DAYS);
        if let Some(model) = Model::fit(samples.iter().filter(|s| add(s.t, h) <= cutoff)) {
            for s in samples.iter().filter(|s| lo <= s.t && s.t < hi) {
                if let Some(c) = model.change(s) {
                    out.insert(s.t, c);
                }
            }
        }
        lo = hi;
    }
    out
}
