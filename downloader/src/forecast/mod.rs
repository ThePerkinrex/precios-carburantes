//! Price forecasts (issue #11), ported from the models tools/backtest backtests: Spain's average
//! price 1-14 days ahead (national.rs) and each station's odds of a lower, same or higher price
//! 1-7 days ahead (stations.rs).
//!
//! `downloader forecast fit` fits the models and stores their coefficients in `modelos`;
//! `downloader forecast` forecasts from the stored ones into `pronosticos` and
//! `pronosticos_estaciones`. The daily download does both, refitting once the models are
//! REFIT_DAYS old.

mod linalg;
mod national;
mod stations;
mod taxes;

use std::{collections::HashMap, error::Error, time::Instant};

use chrono::{Days, Local};
use rand::{SeedableRng, rngs::StdRng};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Serialize, de::DeserializeOwned};

use national::Series;
use stations::{Inputs, Stations};
use taxes::Taxes;

const FUELS: [&str; 2] = ["gasolina_95", "gasoleo_a"];
const REFIT_DAYS: i64 = 7;

pub fn run(args: &[String]) -> Result<(), Box<dyn Error>> {
    let manager = database_access::get_connection_manager(database_access::DEFAULT_DB_PATH)?;
    let mut conn = r2d2::Pool::new(manager)?.get()?;
    match args.first().map(String::as_str) {
        Some("fit") => fit(&mut conn)?,
        None => {}
        Some(other) => return Err(format!("Uso: downloader forecast [fit] ({other}?)").into()),
    }
    predict(&mut conn)
}

/// Refits if the models are missing or REFIT_DAYS old, then forecasts.
pub fn daily(conn: &mut Connection) -> Result<(), Box<dyn Error>> {
    let fitted: Option<i64> =
        conn.query_row("SELECT MIN(ajustado) FROM modelos", [], |r| r.get(0))?;
    if fitted.is_none_or(|t| Local::now().timestamp() - t >= REFIT_DAYS * 24 * 3600) {
        fit(conn)?;
    }
    predict(conn)
}

fn save(
    conn: &Connection,
    name: &str,
    model: &impl Serialize,
    fitted: i64,
) -> Result<(), Box<dyn Error>> {
    conn.execute(
        "INSERT OR REPLACE INTO modelos (nombre, ajustado, datos) VALUES (?1, ?2, ?3)",
        params![name, fitted, serde_json::to_string(model)?],
    )?;
    Ok(())
}

fn load<T: DeserializeOwned>(conn: &Connection, name: &str) -> Result<Option<T>, Box<dyn Error>> {
    let json: Option<String> = conn
        .query_row("SELECT datos FROM modelos WHERE nombre = ?", [name], |r| {
            r.get(0)
        })
        .optional()?;
    Ok(json.map(|j| serde_json::from_str(&j)).transpose()?)
}

/// The rows of `st` that national forecasts from `forecast` (by day) and the tax effect feed.
fn inputs<'a>(
    st: &'a Stations,
    s: &Series,
    h: usize,
    forecast: impl Fn(chrono::NaiveDate) -> Option<f64>,
    prior_rate: f64,
    peers: Vec<Vec<usize>>,
) -> Inputs<'a> {
    let forecast: Vec<f64> = st
        .days
        .iter()
        .map(|&d| forecast(d).unwrap_or(f64::NAN))
        .collect();
    let tax = st
        .days
        .iter()
        .zip(&forecast)
        .map(|(&d, f)| {
            if f.is_finite() {
                s.tax_ahead(d, h as u64).unwrap_or(f64::NAN)
            } else {
                f64::NAN
            }
        })
        .collect();
    Inputs {
        st,
        h,
        forecast,
        tax,
        prior_rate,
        peers,
    }
}

fn fit(conn: &mut Connection) -> Result<(), Box<dyn Error>> {
    let taxes = Taxes::load();
    let fitted = Local::now().timestamp();
    let mut rng = StdRng::seed_from_u64(0);
    for fuel in FUELS {
        let start = Instant::now();
        let s = Series::load(conn, &taxes, fuel)?;
        let mut samples = HashMap::new();
        for h in national::HORIZONS {
            let all = s.samples(h);
            let model = national::Model::fit(all.iter()).ok_or("muy pocos datos")?;
            save(conn, &format!("nacional:{fuel}:{h}"), &model, fitted)?;
            samples.insert(h, all);
        }

        let last = s.last_day();
        let st = Stations::load(
            conn,
            fuel,
            last - Days::new(stations::LOAD_DAYS as u64),
            last,
            |d| s.pump(d),
        )?;
        // As if a block of forecasts started tomorrow: its training targets are known by today.
        let lo = st.days.len();
        let prior_rate = st.change_rate(lo);
        let peers = stations::find_peers(&st, lo - 1);
        for h in stations::HORIZONS {
            let wf = national::walk_forward(&samples[&(h as u64)], h as u64, st.days[0]);
            let inputs = inputs(
                &st,
                &s,
                h,
                |d| wf.get(&d).copied(),
                prior_rate,
                peers.clone(),
            );
            let train_lo = lo
                .saturating_sub(stations::TRAIN_DAYS)
                .max(stations::LOOKBACK);
            let model = stations::Model::fit(&inputs, train_lo, lo - h, &mut rng)
                .ok_or("muy pocos datos")?;
            save(conn, &format!("estaciones:{fuel}:{h}"), &model, fitted)?;
        }
        println!(
            "Pronósticos: modelos de {fuel} ajustados en {:.0}s",
            start.elapsed().as_secs_f32()
        );
    }
    Ok(())
}

fn predict(conn: &mut Connection) -> Result<(), Box<dyn Error>> {
    let taxes = Taxes::load();
    let created = Local::now().timestamp();
    for fuel in FUELS {
        let s = Series::load(conn, &taxes, fuel)?;
        let t = s.last_day();
        let price = s.pump(t).unwrap();
        let tx = conn.transaction()?;
        let mut national = HashMap::new();
        for h in national::HORIZONS {
            let Some(model) = load::<national::Model>(&tx, &format!("nacional:{fuel}:{h}"))? else {
                continue;
            };
            let Some(f) = s.sample(t, h).and_then(|x| model.forecast(&x)) else {
                eprintln!("Pronósticos: sin datos para {fuel} a {h} días desde {t}");
                continue;
            };
            tx.execute(
                "INSERT OR REPLACE INTO pronosticos (origen, combustible, horizonte, precio, cambio, bajo, alto, creado)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![t.to_string(), fuel, h as i64, price, f.change, f.low, f.high, created],
            )?;
            national.insert(h, f.change);
        }

        let st = Stations::load(
            &tx,
            fuel,
            t - Days::new(stations::LOAD_DAYS as u64),
            t,
            |d| s.pump(d),
        )?;
        let i = st.days.len() - 1;
        let peers = stations::find_peers(&st, i);
        tx.execute(
            "DELETE FROM pronosticos_estaciones WHERE combustible = ?",
            [fuel],
        )?;
        let mut stored = 0;
        for h in stations::HORIZONS {
            let Some(model) = load::<stations::Model>(&tx, &format!("estaciones:{fuel}:{h}"))?
            else {
                continue;
            };
            let Some(&change) = national.get(&(h as u64)) else {
                continue;
            };
            let inputs = inputs(
                &st,
                &s,
                h,
                |d| (d == t).then_some(change),
                model.prior_rate,
                peers.clone(),
            );
            let mut stmt = tx.prepare(
                "INSERT INTO pronosticos_estaciones (id_estacion, combustible, horizonte, origen, baja, igual, sube)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            for (k, id) in st.ids.iter().enumerate() {
                if let Some(x) = inputs.features(i, k) {
                    let [down, same, up] = model.predict(&x);
                    stmt.execute(params![id, fuel, h as i64, t.to_string(), down, same, up])?;
                    stored += 1;
                }
            }
        }
        tx.commit()?;
        println!(
            "Pronósticos: {fuel} desde {t}, {} horizontes nacionales, {stored} de estaciones",
            national.len()
        );
    }
    Ok(())
}
