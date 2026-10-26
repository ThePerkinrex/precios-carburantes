//! `downloader backfill <from> <to> [delay]`: stores the Ministry's daily history, one day at a
//! time, as backfill snapshots (see the migration that adds `snapshots.backfill`).
//!
//! A day is skipped if it already has any snapshot, so the command can be stopped and run again.
//! Days may land between existing snapshots: `precios` stays change-only around them.

use chrono::{Days, Local, NaiveDate, TimeZone};
use rusqlite::{OptionalExtension, Result, Transaction, params};
use std::{collections::HashMap, error::Error, thread, time::Duration, time::Instant};

use database_access::{DEFAULT_DB_PATH, get_connection_manager};

use crate::{ApiResponse, client, fetch};

const HIST_URL: &str = "https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestresHist/";
const DEFAULT_DELAY_SECS: u64 = 5;
const RETRIES: u32 = 5;

/// A station's state: its prices, or None when it isn't reported.
type State = Option<(Option<f64>, Option<f64>)>;

pub fn run(args: &[String]) -> Result<(), Box<dyn Error>> {
    let usage = "Uso: downloader backfill <desde AAAA-MM-DD> <hasta AAAA-MM-DD> [segundos entre peticiones]";
    let (Some(from), Some(to)) = (args.first(), args.get(1)) else {
        return Err(usage.into());
    };
    let from = NaiveDate::parse_from_str(from, "%Y-%m-%d")?;
    let to = NaiveDate::parse_from_str(to, "%Y-%m-%d")?;
    let delay = Duration::from_secs(match args.get(2) {
        Some(d) => d.parse()?,
        None => DEFAULT_DELAY_SECS,
    });
    if to >= Local::now().date_naive() {
        return Err("Solo se pueden rellenar días ya terminados".into());
    }

    let manager = get_connection_manager(DEFAULT_DB_PATH)?;
    let pool = r2d2::Pool::new(manager)?;
    let mut conn = pool.get()?;
    let client = client()?;

    let mut day = from;
    while day <= to {
        let (start, end) = (day_start(day)?, day_start(day + Days::new(1))?);
        let stored: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM snapshots WHERE fecha >= ?1 AND fecha < ?2)",
            params![start, end],
            |row| row.get(0),
        )?;
        if stored {
            println!("{day}: ya guardado");
        } else {
            let t = Instant::now();
            let resp = fetch_retrying(&client, day, delay)?;
            let downloaded = t.elapsed().as_secs_f32();
            if resp.lista_eess.is_empty() {
                println!("{day}: la API no devolvió estaciones ({})", resp.fecha);
            } else {
                let tx = conn.transaction()?;
                let stats = store_day(&tx, end - 1, resp)?;
                tx.commit()?;
                println!(
                    "{day}: {} estaciones (+{} mantenidas), {} filas nuevas, {} borradas; descarga {downloaded:.1}s, guardado {:.1}s",
                    stats.stations,
                    stats.carried,
                    stats.inserted,
                    stats.deleted,
                    t.elapsed().as_secs_f32() - downloaded
                );
            }
            thread::sleep(delay);
        }
        day = day + Days::new(1);
    }
    Ok(())
}

/// Local midnight at the start of `day`, in unix seconds.
fn day_start(day: NaiveDate) -> Result<i64, Box<dyn Error>> {
    let midnight = day.and_hms_opt(0, 0, 0).unwrap();
    Ok(Local
        .from_local_datetime(&midnight)
        .earliest()
        .ok_or("Medianoche inexistente")?
        .timestamp())
}

fn fetch_retrying(
    client: &reqwest::blocking::Client,
    day: NaiveDate,
    delay: Duration,
) -> Result<ApiResponse, Box<dyn Error>> {
    let url = format!("{HIST_URL}{}", day.format("%d-%m-%Y"));
    let mut attempt = 0;
    loop {
        match fetch(client, &url) {
            Ok(resp) => return Ok(resp),
            // A response that doesn't parse will be the same next time.
            Err(e) if attempt < RETRIES && !e.is_decode() => {
                attempt += 1;
                let wait = delay.max(Duration::from_secs(5)) * 2u32.pow(attempt);
                eprintln!(
                    "{day}: {e}; reintento {attempt}/{RETRIES} en {}s",
                    wait.as_secs()
                );
                thread::sleep(wait);
            }
            Err(e) => return Err(e.into()),
        }
    }
}

struct Stats {
    stations: usize,
    carried: usize,
    inserted: usize,
    deleted: usize,
}

fn store_day(tx: &Transaction, fecha: i64, resp: ApiResponse) -> Result<Stats, Box<dyn Error>> {
    let seen = Local
        .timestamp_opt(fecha, 0)
        .unwrap()
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();

    tx.execute(
        "INSERT INTO snapshots (fecha, backfill) VALUES (?1, 1)",
        params![fecha],
    )?;

    let mut new: HashMap<i32, (Option<f64>, Option<f64>)> = HashMap::new();
    for est in &resp.lista_eess {
        let Ok(id) = est.id_eess.parse() else {
            continue;
        };
        // The historical endpoint returns every station's current details (its brand today, not
        // that day's), so they only fill in stations we don't have yet, or a missing position.
        tx.prepare_cached(
            "INSERT INTO estaciones (
                id, rotulo, direccion, margen, cp, horario, municipio,
                localidad, provincia, id_municipio, id_provincia, id_ccaa,
                longitud, latitud, first_seen, last_seen
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)
            ON CONFLICT(id) DO UPDATE SET
                longitud = COALESCE(longitud, excluded.longitud),
                latitud = COALESCE(latitud, excluded.latitud),
                first_seen = MIN(first_seen, excluded.first_seen),
                last_seen = MAX(last_seen, excluded.last_seen)",
        )?
        .execute(params![
            id,
            est.rotulo,
            est.direccion,
            est.margen,
            est.postal_code,
            est.horario,
            est.municipio,
            est.localidad,
            est.provincia,
            est.id_municipio,
            est.id_provincia,
            est.id_ccaa,
            est.longitud,
            est.latitud,
            seen
        ])?;
        new.insert(id, (est.precio_gasoleo_a, est.precio_gasolina_95));
    }

    // Every station's state just before this snapshot, from its last row, and whether that row
    // is from a live download.
    let prev: HashMap<i32, (State, bool)> = tx
        .prepare(
            "SELECT p.id_estacion, p.reportado, p.gasoleo_a, p.gasolina_95, s.backfill = 0
            FROM estaciones e
            CROSS JOIN precios p ON p.id_estacion = e.id
                AND p.fecha = (SELECT MAX(fecha) FROM precios WHERE id_estacion = e.id AND fecha < ?1)
            CROSS JOIN snapshots s ON s.fecha = p.fecha",
        )?
        .query_map(params![fecha], |row| {
            let (id, state) = row_state(row)?;
            Ok((id, (state, row.get(4)?)))
        })?
        .collect::<Result<_>>()?;

    // The historical list leaves out restricted-sale stations (cooperatives, fleets), so one
    // last seen in a live download keeps its state instead of being marked unreported.
    let mut carried = 0;
    for (&id, &(state, live)) in &prev {
        if let (Some(prices), true) = (state, live) {
            new.entry(id).or_insert_with(|| {
                carried += 1;
                prices
            });
        }
    }

    // The snapshot after this one: the stored state there must not change.
    let next_snapshot: Option<i64> = tx
        .query_row(
            "SELECT MIN(fecha) FROM snapshots WHERE fecha > ?1",
            params![fecha],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    let next_rows: HashMap<i32, State> = match next_snapshot {
        Some(next) => tx
            // A primary key lookup per station (CROSS JOIN keeps estaciones outer): precios has
            // no index on fecha alone.
            .prepare(
                "SELECT p.id_estacion, p.reportado, p.gasoleo_a, p.gasolina_95
                FROM estaciones e
                CROSS JOIN precios p ON p.id_estacion = e.id AND p.fecha = ?1",
            )?
            .query_map(params![next], row_state)?
            .collect::<Result<_>>()?,
        None => HashMap::new(),
    };

    let mut stats = Stats {
        stations: new.len() - carried,
        carried,
        inserted: 0,
        deleted: 0,
    };
    let mut ids: Vec<i32> = new.keys().chain(prev.keys()).copied().collect();
    ids.sort_unstable();
    ids.dedup();

    for id in ids {
        let before = prev.get(&id).and_then(|&(state, _)| state);
        let now = new.get(&id).copied();
        if now == before {
            continue;
        }
        stats.inserted += insert_state(tx, id, fecha, now)?;

        if let Some(next) = next_snapshot {
            match next_rows.get(&id) {
                // The next snapshot already starts a row: drop it if it repeats this state.
                Some(&state) if state == now => {
                    tx.prepare_cached("DELETE FROM precios WHERE id_estacion = ?1 AND fecha = ?2")?
                        .execute(params![id, next])?;
                    stats.deleted += 1;
                }
                Some(_) => {}
                // Otherwise the station was still in its earlier state there.
                None => stats.inserted += insert_state(tx, id, next, before)?,
            }
        }
    }

    // Only when this is the newest snapshot (e.g. an empty database).
    if next_snapshot.is_none() {
        tx.execute("DELETE FROM precios_actuales", [])?;
        let mut stmt = tx.prepare(
            "INSERT INTO precios_actuales (id_estacion, gasoleo_a, gasolina_95) VALUES (?1, ?2, ?3)",
        )?;
        for (id, (a, b)) in &new {
            stmt.execute(params![id, a, b])?;
        }
    }

    // Province averages over the stations in this snapshot.
    let mut sums: HashMap<(String, String), (f64, i64, f64, i64)> = HashMap::new();
    let provinces: HashMap<i32, (String, String)> = tx
        .prepare("SELECT id, id_provincia, id_ccaa FROM estaciones")?
        .query_map([], |row| Ok((row.get(0)?, (row.get(1)?, row.get(2)?))))?
        .collect::<Result<_>>()?;
    for (id, (a, b)) in &new {
        let s = sums.entry(provinces[id].clone()).or_default();
        if let Some(a) = a {
            s.0 += a;
            s.1 += 1;
        }
        if let Some(b) = b {
            s.2 += b;
            s.3 += 1;
        }
    }
    let mut stmt =
        tx.prepare("INSERT INTO precios_provincia VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")?;
    for ((provincia, ccaa), (sa, na, sb, nb)) in sums {
        stmt.execute(params![
            fecha,
            provincia,
            ccaa,
            (na > 0).then_some(sa),
            na,
            (nb > 0).then_some(sb),
            nb
        ])?;
    }

    Ok(stats)
}

fn row_state(row: &rusqlite::Row) -> Result<(i32, State)> {
    let reportado: bool = row.get(1)?;
    let state = if reportado {
        Some((row.get(2)?, row.get(3)?))
    } else {
        None
    };
    Ok((row.get(0)?, state))
}

/// Writes `state` for station `id` at `fecha`. Only called after one of the station's rows, so
/// an unreported state is always written as a reportado = 0 row.
fn insert_state(tx: &Transaction, id: i32, fecha: i64, state: State) -> Result<usize> {
    match state {
        Some((a, b)) => tx
            .prepare_cached(
                "INSERT INTO precios (id_estacion, fecha, reportado, gasoleo_a, gasolina_95)
                VALUES (?1, ?2, 1, ?3, ?4)",
            )?
            .execute(params![id, fecha, a, b]),
        None => tx
            .prepare_cached(
                "INSERT INTO precios (id_estacion, fecha, reportado) VALUES (?1, ?2, 0)",
            )?
            .execute(params![id, fecha]),
    }
}
