//! Daily market series that pump prices follow, stored in `mercados`:
//!
//! - ECB reference rates (no key): dollars per euro, to turn dollar prices into euros.
//! - EIA spot and futures prices (free API key in EIA_API_KEY, e.g. in .env): Brent crude,
//!   New York Harbor diesel and gasoline. Skipped without a key. EIA publishes them about a
//!   week late, so they suit the history better than live forecasts.
//! - Yahoo Finance front-month futures (no key): RBOB gasoline, NY Harbor ULSD and Brent, each
//!   trading day's close, the day after. Yahoo's chart API is unofficial and may change or
//!   block us without notice.
//!
//! The live downloader calls `update` after every download; `downloader markets [from]`
//! fetches the history from a date.

use chrono::{DateTime, Days, Local, NaiveDate, Utc};
use rusqlite::{Connection, params};
use serde_json::Value;
use std::error::Error;

const ECB_URL: &str = "https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A";
const EIA_URL: &str = "https://api.eia.gov/v2/petroleum/pri/";
const YAHOO_URL: &str = "https://query1.finance.yahoo.com/v8/finance/chart/";
/// How far back each update looks, so late publications and revisions get picked up.
pub const UPDATE_DAYS: u64 = 30;
/// The EIA API returns at most this many rows per request.
const EIA_PAGE: usize = 5000;

/// EIA series: (route under petroleum/pri/, series id). Units: $/bbl for crude, $/gal for
/// products.
const EIA_SERIES: &[(&str, &str)] = &[
    // Europe Brent spot price FOB.
    ("spt", "RBRTE"),
    // New York Harbor ultra-low sulfur No 2 diesel spot price.
    ("spt", "EER_EPD2DXL0_PF4_Y35NY_DPG"),
    // New York Harbor conventional gasoline regular spot price.
    ("spt", "EER_EPMRU_PF4_Y35NY_DPG"),
];

/// Yahoo front-month futures tickers. Units: $/gal for products, $/bbl for crude.
const YAHOO_SERIES: &[&str] = &[
    // RBOB gasoline (NYMEX).
    "RB=F",
    // NY Harbor ultra-low sulfur diesel (NYMEX).
    "HO=F",
    // Brent crude (ICE).
    "BZ=F",
];

type Rows = Vec<(String, NaiveDate, f64)>;

pub fn run(args: &[String]) -> Result<(), Box<dyn Error>> {
    let from = match args.first() {
        Some(d) => NaiveDate::parse_from_str(d, "%Y-%m-%d")?,
        None => Local::now().date_naive() - Days::new(UPDATE_DAYS),
    };
    let manager = database_access::get_connection_manager(database_access::DEFAULT_DB_PATH)?;
    let mut conn = r2d2::Pool::new(manager)?.get()?;
    update(&mut conn, &crate::client()?, from)
}

/// Fetches every source from `from` on and stores what it gets. A source that fails is
/// reported and skipped, so one being down doesn't stop the others.
pub fn update(
    conn: &mut Connection,
    client: &reqwest::blocking::Client,
    from: NaiveDate,
) -> Result<(), Box<dyn Error>> {
    let mut failed = Vec::new();
    let mut rows = Rows::new();
    match ecb(client, from) {
        Ok(r) => rows.extend(r),
        Err(e) => failed.push(format!("ECB: {e}")),
    }
    match std::env::var("EIA_API_KEY") {
        Ok(key) if !key.is_empty() => {
            for (route, series) in EIA_SERIES {
                match eia(client, &key, route, series, from) {
                    Ok(r) => rows.extend(r),
                    Err(e) => failed.push(format!("EIA {series}: {e}")),
                }
            }
        }
        _ => println!("Mercados: sin EIA_API_KEY, se omite la EIA"),
    }
    for ticker in YAHOO_SERIES {
        match yahoo(client, ticker, from) {
            Ok(r) => rows.extend(r),
            Err(e) => failed.push(format!("Yahoo {ticker}: {e}")),
        }
    }

    let now = Local::now().timestamp();
    let tx = conn.transaction()?;
    let mut stmt = tx.prepare(
        "INSERT INTO mercados (serie, fecha, valor, visto) VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT DO UPDATE SET valor = excluded.valor",
    )?;
    for (serie, fecha, valor) in &rows {
        stmt.execute(params![serie, fecha.to_string(), valor, now])?;
    }
    drop(stmt);
    tx.commit()?;
    println!("Mercados: {} valores desde {from}", rows.len());

    if failed.is_empty() {
        Ok(())
    } else {
        Err(failed.join("; ").into())
    }
}

/// Dollars per euro, from the ECB's CSV.
fn ecb(client: &reqwest::blocking::Client, from: NaiveDate) -> Result<Rows, Box<dyn Error>> {
    let body = client
        .get(ECB_URL)
        .query(&[("format", "csvdata"), ("startPeriod", &from.to_string())])
        .send()?
        .error_for_status()?
        .text()?;
    let mut lines = body.lines();
    let header: Vec<&str> = lines.next().ok_or("CSV vacío")?.split(',').collect();
    let col = |name: &str| {
        header
            .iter()
            .position(|h| *h == name)
            .ok_or(format!("Falta la columna {name}"))
    };
    let (date_col, value_col) = (col("TIME_PERIOD")?, col("OBS_VALUE")?);
    let mut rows = Rows::new();
    for line in lines {
        // The columns we need come before any quoted field with commas.
        let fields: Vec<&str> = line.split(',').collect();
        let (Some(date), Some(value)) = (fields.get(date_col), fields.get(value_col)) else {
            continue;
        };
        if let (Ok(date), Ok(value)) = (NaiveDate::parse_from_str(date, "%Y-%m-%d"), value.parse())
        {
            rows.push(("ecb:USD".to_string(), date, value));
        }
    }
    Ok(rows)
}

/// One EIA daily series, page by page.
fn eia(
    client: &reqwest::blocking::Client,
    key: &str,
    route: &str,
    series: &str,
    from: NaiveDate,
) -> Result<Rows, Box<dyn Error>> {
    let mut rows = Rows::new();
    let mut received = 0;
    loop {
        let offset = received.to_string();
        let page: Value = client
            .get(format!("{EIA_URL}{route}/data/"))
            .query(&[
                ("api_key", key),
                ("frequency", "daily"),
                ("data[0]", "value"),
                ("facets[series][]", series),
                ("start", &from.to_string()),
                ("sort[0][column]", "period"),
                ("sort[0][direction]", "asc"),
                ("offset", &offset),
                ("length", &EIA_PAGE.to_string()),
            ])
            .send()?
            .error_for_status()?
            .json()?;
        let data = page["response"]["data"]
            .as_array()
            .ok_or("Respuesta de la EIA sin datos")?;
        received += data.len();
        for item in data {
            let date = item["period"]
                .as_str()
                .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());
            // The value comes as a number or as a string, depending on the series.
            let value = match &item["value"] {
                Value::Number(n) => n.as_f64(),
                Value::String(s) => s.parse().ok(),
                _ => None,
            };
            if let (Some(date), Some(value)) = (date, value) {
                rows.push((format!("eia:{series}"), date, value));
            }
        }
        if data.len() < EIA_PAGE {
            return Ok(rows);
        }
    }
}

/// One Yahoo futures series: each trading day's close, as "yf:<ticker>".
fn yahoo(
    client: &reqwest::blocking::Client,
    ticker: &str,
    from: NaiveDate,
) -> Result<Rows, Box<dyn Error>> {
    let now = Utc::now().timestamp();
    let start = from.and_time(chrono::NaiveTime::MIN).and_utc().timestamp();
    let body: Value = client
        .get(format!("{YAHOO_URL}{ticker}"))
        .query(&[
            ("period1", start.to_string()),
            ("period2", now.to_string()),
            ("interval", "1d".to_string()),
        ])
        .send()?
        .error_for_status()?
        .json()?;
    let result = &body["chart"]["result"][0];
    let meta = &result["meta"];
    // Bars are stamped at the session's start in New York; the offset turns them into dates.
    let offset = meta["gmtoffset"]
        .as_i64()
        .ok_or("Respuesta de Yahoo sin gmtoffset")?;
    let session = &meta["currentTradingPeriod"]["regular"];
    let (session_start, session_end) = (
        session["start"].as_i64().unwrap_or(i64::MAX),
        session["end"].as_i64().unwrap_or(i64::MIN),
    );
    let times = result["timestamp"]
        .as_array()
        .ok_or("Respuesta de Yahoo sin datos")?;
    let closes = result["indicators"]["quote"][0]["close"]
        .as_array()
        .ok_or("Respuesta de Yahoo sin cierres")?;
    let mut rows = Rows::new();
    for (time, close) in times.iter().zip(closes) {
        // Days without trading come as null.
        let (Some(time), Some(close)) = (time.as_i64(), close.as_f64()) else {
            continue;
        };
        // While a session is open its bar holds the latest trade, not the close.
        if time >= session_start && now < session_end {
            continue;
        }
        if let Some(date) = DateTime::from_timestamp(time + offset, 0)
            && close > 0.0
        {
            rows.push((format!("yf:{ticker}"), date.date_naive(), close));
        }
    }
    Ok(rows)
}
