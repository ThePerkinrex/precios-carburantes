//! Each station's odds of a lower, same or higher price 1, 3 and 7 days ahead. A port of
//! tools/backtest/stations.py's "full" model, which documents and backtests it: a multinomial
//! logistic regression on the national forecast, the station's state (its gap to the national
//! average against its usual one, how far it lags the national moves, days since its last
//! change) and habits (how often it changes, how often up, its chance of a change over the
//! target days by weekday), and its peers' latest moves (stations in its province that change
//! on the same days, usually the same owner).
//!
//! Prices are each station's state at the end of the day; the last day is the latest snapshot.

use std::{collections::HashMap, error::Error};

use chrono::{Datelike, Days, NaiveDate, TimeZone};
use nalgebra::{DMatrix, DVector};
use rand::{Rng, seq::index};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::{
    linalg::{Scaling, matrix, solve},
    taxes::OWN_TAXES,
};

pub const HORIZONS: [usize; 3] = [1, 3, 7];
const EPS: f32 = 0.0005;
pub const TRAIN_DAYS: usize = 365;
const TRAIN_ROWS: usize = 150_000;
const STATION_DAYS: usize = 182;
const GAP_DAYS: usize = 90;
const PRIOR_ROWS: f64 = 10.0;
const PRIOR_DAYS: f64 = 30.0;
const PEER_J: f64 = 0.5;
const PEER_MIN: u32 = 8;
const RIDGE: f64 = 1.0;
pub const LOOKBACK: usize = STATION_DAYS + 14;
/// Days loaded: the training window, the lookback its first rows need, and a margin.
pub const LOAD_DAYS: usize = TRAIN_DAYS + LOOKBACK + 7;

fn local_ts(day: NaiveDate) -> i64 {
    chrono::Local
        .from_local_datetime(&day.and_hms_opt(0, 0, 0).unwrap())
        .earliest()
        .map(|d| d.timestamp())
        .unwrap_or_default()
}

/// Every station's end-of-day prices for one fuel, and its national average.
pub struct Stations {
    pub days: Vec<NaiveDate>,
    pub ids: Vec<i64>,
    provinces: Vec<String>,
    /// days x stations, row-major; NaN where it had no price or no snapshot was taken.
    p: Vec<f32>,
    /// National average per day (NaN if unknown).
    n: Vec<f64>,
    /// Each day's change class: -1, 0 or 1 (0 where unknown too).
    c: Vec<i8>,
    /// Days since the last change, up to 365.
    since: Vec<i16>,
}

impl Stations {
    pub fn load(
        conn: &Connection,
        fuel: &str,
        start: NaiveDate,
        end: NaiveDate,
        national: impl Fn(NaiveDate) -> Option<f64>,
    ) -> Result<Self, Box<dyn Error>> {
        let mut ids = Vec::new();
        let mut provinces = Vec::new();
        let mut stmt =
            conn.prepare("SELECT id, id_provincia, id_ccaa FROM estaciones ORDER BY id")?;
        for row in stmt.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })? {
            let (id, prov, ccaa) = row?;
            if !ccaa.as_deref().is_some_and(|c| OWN_TAXES.contains(&c)) {
                ids.push(id);
                provinces.push(prov.unwrap_or_default());
            }
        }
        let col: HashMap<i64, usize> = ids.iter().enumerate().map(|(k, &i)| (i, k)).collect();
        let width = ids.len();
        let days: Vec<NaiveDate> = start.iter_days().take_while(|&d| d <= end).collect();
        let row = |d: NaiveDate| (d - start).num_days() as usize;
        let price = |reported: bool, p: Option<f64>| match p {
            Some(p) if reported && p != 0.0 => p as f32,
            _ => f32::NAN,
        };

        let mut state = vec![f32::NAN; width];
        let mut stmt = conn.prepare(&format!(
            "SELECT p.id_estacion, p.reportado, p.{fuel} FROM precios p
            JOIN (SELECT id_estacion, MAX(fecha) AS fecha FROM precios WHERE fecha < ? GROUP BY id_estacion) q
            ON p.id_estacion = q.id_estacion AND p.fecha = q.fecha"
        ))?;
        for r in stmt.query_map([local_ts(start)], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, bool>(1)?, r.get(2)?))
        })? {
            let (id, reported, p) = r?;
            if let Some(&k) = col.get(&id) {
                state[k] = price(reported, p);
            }
        }
        // None: no new row that day, the state carries over.
        let mut events: Vec<Vec<(usize, f32)>> = vec![Vec::new(); days.len()];
        let mut stmt = conn.prepare(&format!(
            "SELECT id_estacion, date(fecha, 'unixepoch', 'localtime'), reportado, {fuel} FROM precios
            WHERE fecha >= ? AND fecha < ? ORDER BY fecha"
        ))?;
        let end_ts = local_ts(end + Days::new(1));
        for r in stmt.query_map([local_ts(start), end_ts], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, bool>(2)?,
                r.get(3)?,
            ))
        })? {
            let (id, day, reported, p) = r?;
            if let Some(&k) = col.get(&id) {
                events[row(NaiveDate::parse_from_str(&day, "%Y-%m-%d")?)]
                    .push((k, price(reported, p)));
            }
        }
        let mut snapshot = vec![false; days.len()];
        let mut stmt = conn.prepare(
            "SELECT DISTINCT date(fecha, 'unixepoch', 'localtime') FROM snapshots WHERE fecha >= ? AND fecha < ?",
        )?;
        for d in stmt.query_map([local_ts(start), end_ts], |r| r.get::<_, String>(0))? {
            snapshot[row(NaiveDate::parse_from_str(&d?, "%Y-%m-%d")?)] = true;
        }

        let mut p = vec![f32::NAN; days.len() * width];
        for (k, evs) in events.iter().enumerate() {
            for &(s, v) in evs {
                state[s] = v;
            }
            if snapshot[k] {
                p[k * width..(k + 1) * width].copy_from_slice(&state);
            }
        }
        let n: Vec<f64> = days
            .iter()
            .map(|&d| national(d).unwrap_or(f64::NAN))
            .collect();
        let mut c = vec![0i8; p.len()];
        let mut since = vec![0i16; p.len()];
        for k in 1..days.len() {
            for s in 0..width {
                let step = p[k * width + s] - p[(k - 1) * width + s];
                if step.is_finite() && step.abs() >= EPS {
                    c[k * width + s] = step.signum() as i8;
                }
                since[k * width + s] = if c[k * width + s] != 0 {
                    0
                } else {
                    (since[(k - 1) * width + s] + 1).min(365)
                };
            }
        }
        Ok(Stations {
            days,
            ids,
            provinces,
            p,
            n,
            c,
            since,
        })
    }

    fn width(&self) -> usize {
        self.ids.len()
    }

    fn p(&self, i: usize, s: usize) -> f32 {
        self.p[i * self.width() + s]
    }

    fn c(&self, i: usize, s: usize) -> i8 {
        self.c[i * self.width() + s]
    }

    /// The share of station-days with a change before row `end`.
    pub fn change_rate(&self, end: usize) -> f64 {
        let (mut changed, mut observed) = (0usize, 0usize);
        for i in 1..end {
            for s in 0..self.width() {
                if (self.p(i, s) - self.p(i - 1, s)).is_finite() {
                    observed += 1;
                    changed += (self.c(i, s) != 0) as usize;
                }
            }
        }
        changed as f64 / observed.max(1) as f64
    }

    /// The outcome class at h days from row i: 0 down, 1 same, 2 up, or None if unknown.
    fn target(&self, i: usize, s: usize, h: usize) -> Option<usize> {
        let change = self.p(i + h, s) - self.p(i, s);
        if !change.is_finite() {
            None
        } else if change <= -EPS {
            Some(0)
        } else if change >= EPS {
            Some(2)
        } else {
            Some(1)
        }
    }
}

/// Each station's peers: stations in its province that changed on the same days over the
/// STATION_DAYS before row `lo` (Jaccard similarity of their change days of at least PEER_J).
pub fn find_peers(st: &Stations, lo: usize) -> Vec<Vec<usize>> {
    let from = lo.saturating_sub(STATION_DAYS).max(1);
    let words = (lo - from).div_ceil(64);
    let bits: Vec<Vec<u64>> = (0..st.width())
        .map(|s| {
            let mut b = vec![0u64; words];
            for (k, i) in (from..lo).enumerate() {
                if st.c(i, s) != 0 {
                    b[k / 64] |= 1 << (k % 64);
                }
            }
            b
        })
        .collect();
    let count: Vec<u32> = bits
        .iter()
        .map(|b| b.iter().map(|w| w.count_ones()).sum())
        .collect();
    let mut by_province: HashMap<&str, Vec<usize>> = HashMap::new();
    for (s, prov) in st.provinces.iter().enumerate() {
        by_province.entry(prov).or_default().push(s);
    }
    let mut peers = vec![Vec::new(); st.width()];
    for members in by_province.values() {
        for &a in members {
            if count[a] < PEER_MIN {
                continue;
            }
            for &b in members {
                if a == b || count[b] < PEER_MIN {
                    continue;
                }
                let both: u32 = bits[a]
                    .iter()
                    .zip(&bits[b])
                    .map(|(x, y)| (x & y).count_ones())
                    .sum();
                if both as f64 / (count[a] + count[b] - both) as f64 >= PEER_J {
                    peers[a].push(b);
                }
            }
        }
    }
    peers
}

pub const FEATURES: usize = 22;

/// What the features of one horizon read: the national forecast and tax effect per row.
pub struct Inputs<'a> {
    pub st: &'a Stations,
    pub h: usize,
    pub forecast: Vec<f64>,
    pub tax: Vec<f64>,
    pub prior_rate: f64,
    pub peers: Vec<Vec<usize>>,
}

impl Inputs<'_> {
    /// The model's inputs for station s at row i, or None if any is unknown.
    pub fn features(&self, i: usize, s: usize) -> Option<[f64; FEATURES]> {
        let st = self.st;
        let (p, n) = (|k: usize| st.p(k, s), &st.n);
        let (f_nat, tax) = (self.forecast[i], self.tax[i]);
        let n7 = n[i] - n[i.saturating_sub(7)];
        // The usual gap: its mean over the GAP_DAYS before T (T itself left out).
        let (mut gap_sum, mut gap_n) = (0.0, 0usize);
        for k in i.saturating_sub(GAP_DAYS)..i {
            let g = p(k) as f64 - n[k];
            if g.is_finite() {
                gap_sum += g;
                gap_n += 1;
            }
        }
        let dev = if gap_n >= GAP_DAYS / 3 {
            (p(i) as f64 - n[i]) - gap_sum / gap_n.max(1) as f64
        } else {
            f64::NAN
        };
        let pend = [3, 7, 14].map(|k| (n[i] - n[i - k]) - (p(i) - p(i - k)) as f64);
        let since = (st.since[i * st.width() + s] as f64).ln_1p();
        let moved = (st.c(i, s) != 0) as u8 as f64;
        let own2 = p(i) - p(i - 2);
        let own2 = if own2.is_finite() {
            own2.signum() as f64 * (own2.abs() >= EPS) as u8 as f64
        } else {
            f64::NAN
        };

        // Habits over the STATION_DAYS up to T.
        let (mut obs, mut chg, mut up) = (0.0, 0.0, 0.0);
        let (mut wd_obs, mut wd_chg) = ([0.0; 7], [0.0; 7]);
        for k in (i + 1).saturating_sub(STATION_DAYS)..=i {
            if k == 0 || !(p(k) - p(k - 1)).is_finite() {
                continue;
            }
            let wd = st.days[k].weekday().num_days_from_monday() as usize;
            obs += 1.0;
            wd_obs[wd] += 1.0;
            if st.c(k, s) != 0 {
                chg += 1.0;
                wd_chg[wd] += 1.0;
                up += (st.c(k, s) > 0) as u8 as f64;
            }
        }
        let rate = (chg + PRIOR_DAYS * self.prior_rate) / (obs + PRIOR_DAYS);
        let rise = (up + PRIOR_ROWS * 0.5) / (chg + PRIOR_ROWS) - 0.5;
        let today = st.days[i].weekday().num_days_from_monday() as usize;
        let stay: f64 = (1..=self.h)
            .map(|k| {
                let w = (today + k) % 7;
                1.0 - (wd_chg[w] + 5.0 * self.prior_rate) / (wd_obs[w] + 5.0)
            })
            .product();
        let chance = 1.0 - stay;

        // Peers that went down / up over the last 2 days.
        let peers = &self.peers[s];
        let (mut dn, mut upp) = (0.0, 0.0);
        for &q in peers {
            let m = st.p(i, q) - st.p(i - 2, q);
            dn += (m <= -EPS) as u8 as f64;
            upp += (m >= EPS) as u8 as f64;
        }
        let norm = (peers.len() as f64).max(1.0);
        let (dn, upp) = (dn / norm, upp / norm);
        let still = (own2 == 0.0) as u8 as f64;

        let x = [
            f_nat,
            tax,
            n7,
            dev,
            pend[0],
            pend[1],
            pend[2],
            since,
            moved,
            own2,
            rate,
            rise,
            chance,
            f_nat * chance,
            dev * chance,
            pend[1] * chance,
            tax * chance,
            dn,
            upp,
            dn * still,
            upp * still,
            (peers.len() as f64).ln_1p(),
        ];
        x.iter().all(|v| v.is_finite()).then_some(x)
    }
}

#[derive(Serialize, Deserialize)]
pub struct Model {
    mean: Vec<f64>,
    std: Vec<f64>,
    flat: Vec<bool>,
    /// (1 + FEATURES) x 2 coefficients, for "down" and "up" against "same".
    w: Vec<[f64; 2]>,
    pub prior_rate: f64,
}

impl Model {
    /// Fits on up to TRAIN_ROWS random station-days among rows [lo, hi) whose target is known.
    pub fn fit(inputs: &Inputs, lo: usize, hi: usize, rng: &mut impl Rng) -> Option<Self> {
        let st = inputs.st;
        let mut candidates = Vec::new();
        for i in lo..hi {
            for s in 0..st.width() {
                if st.p(i, s).is_finite() {
                    candidates.push((i, s));
                }
            }
        }
        let mut x = Vec::new();
        let mut y = Vec::new();
        let picked = index::sample(
            rng,
            candidates.len(),
            (TRAIN_ROWS * 2).min(candidates.len()),
        );
        for k in picked {
            let (i, s) = candidates[k];
            if let (Some(f), Some(cls)) = (inputs.features(i, s), st.target(i, s, inputs.h)) {
                x.push(f.to_vec());
                y.push(cls);
                if y.len() == TRAIN_ROWS {
                    break;
                }
            }
        }
        if y.len() < 1000 {
            return None;
        }
        Self::fit_softmax(&x, &y, inputs.prior_rate)
    }

    /// Multinomial logistic regression with "same" as the reference class, on standardized
    /// inputs with a ridge penalty, by Newton's method.
    fn fit_softmax(x: &[Vec<f64>], y: &[usize], prior_rate: f64) -> Option<Self> {
        let x = matrix(x);
        let scaling = Scaling::fit(&x, 1e-9);
        let mut z = scaling.apply(&x).insert_column(0, 1.0);
        for (k, _) in scaling.flat.iter().enumerate().filter(|(_, f)| **f) {
            z.column_mut(k + 1).fill(0.0);
        }
        let (rows, f) = z.shape();
        // Targets: is it down, is it up.
        let t = DMatrix::from_fn(rows, 2, |i, a| {
            (y[i] == if a == 0 { 0 } else { 2 }) as u8 as f64
        });
        let penalty = DVector::from_fn(f, |k, _| if k == 0 { 0.0 } else { RIDGE });
        let mut w = DMatrix::<f64>::zeros(f, 2);
        for _ in 0..30 {
            let eta = &z * &w;
            let mut p = DMatrix::<f64>::zeros(rows, 2);
            for i in 0..rows {
                let top = eta[(i, 0)].max(eta[(i, 1)]).max(0.0);
                let e = [(eta[(i, 0)] - top).exp(), (eta[(i, 1)] - top).exp()];
                let denom = (-top).exp() + e[0] + e[1];
                p[(i, 0)] = e[0] / denom;
                p[(i, 1)] = e[1] / denom;
            }
            let mut grad = z.transpose() * (&t - &p);
            for a in 0..2 {
                grad.column_mut(a)
                    .zip_apply(&penalty.component_mul(&w.column(a)), |g, r| *g -= r);
            }
            // The Hessian, block (a, c): -Zᵀ diag(p_a (δ_ac - p_c)) Z, minus the penalty.
            let mut hess = DMatrix::<f64>::zeros(2 * f, 2 * f);
            for a in 0..2 {
                for c in a..2 {
                    let wt = DVector::from_fn(rows, |i, _| {
                        p[(i, a)] * ((a == c) as u8 as f64 - p[(i, c)])
                    });
                    let mut zw = z.clone();
                    for (mut row, v) in zw.row_iter_mut().zip(wt.iter()) {
                        row *= *v;
                    }
                    let block = -(z.transpose() * zw);
                    hess.view_mut((a * f, c * f), (f, f)).copy_from(&block);
                    hess.view_mut((c * f, a * f), (f, f))
                        .copy_from(&block.transpose());
                }
            }
            for k in 0..2 * f {
                hess[(k, k)] -= penalty[k % f];
            }
            let g = DVector::from_iterator(
                2 * f,
                grad.column(0).iter().chain(grad.column(1).iter()).cloned(),
            );
            let delta = solve(hess, g)?;
            for a in 0..2 {
                for k in 0..f {
                    w[(k, a)] -= delta[a * f + k];
                }
            }
            if delta.amax() < 1e-6 {
                break;
            }
        }
        let w = (0..f).map(|k| [w[(k, 0)], w[(k, 1)]]).collect();
        Some(Model {
            mean: scaling.mean,
            std: scaling.std,
            flat: scaling.flat,
            w,
            prior_rate,
        })
    }

    /// The probabilities of down, same and up.
    pub fn predict(&self, x: &[f64; FEATURES]) -> [f64; 3] {
        let mut eta = [self.w[0][0], self.w[0][1]];
        for k in 0..FEATURES {
            let z = if self.flat[k] {
                0.0
            } else {
                (x[k] - self.mean[k]) / self.std[k]
            };
            eta[0] += z * self.w[k + 1][0];
            eta[1] += z * self.w[k + 1][1];
        }
        let full = [eta[0], 0.0, eta[1]];
        let top = full.iter().cloned().fold(f64::MIN, f64::max);
        let e = full.map(|v| (v - top).exp());
        let sum: f64 = e.iter().sum();
        e.map(|v| v / sum)
    }
}
