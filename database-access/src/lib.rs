use std::{path::Path, sync::Mutex};

use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

const MIGRATIONS: &[&[&str]] = &[
    &[
        "CREATE TABLE IF NOT EXISTS estaciones (
            id INTEGER PRIMARY KEY,
            rotulo TEXT,
            direccion TEXT,
            margen TEXT,
            cp TEXT,
            horario TEXT,
            municipio TEXT,
            localidad TEXT,
            provincia TEXT,
            id_municipio TEXT,
            id_provincia TEXT,
            id_ccaa TEXT,
            longitud REAL,
            latitud REAL,
            first_seen TEXT,
            last_seen TEXT
        )",
        "CREATE TABLE IF NOT EXISTS precios (
            fecha TEXT,
            id_estacion INTEGER,
            gasoleo_a REAL,
            gasolina_95 REAL,
            PRIMARY KEY (fecha, id_estacion),
            FOREIGN KEY (id_estacion) REFERENCES estaciones(id)
        )",
    ],
    &[
        "CREATE INDEX IF NOT EXISTS idx_estaciones_coords ON estaciones(latitud, longitud)",
        "CREATE INDEX IF NOT EXISTS idx_precios_estacion_fecha ON precios(id_estacion, fecha)",
        "CREATE INDEX IF NOT EXISTS idx_estaciones_municipio ON estaciones(municipio)",
        "CREATE INDEX IF NOT EXISTS idx_estaciones_rotulo ON estaciones(rotulo)",
    ],
    &["CREATE INDEX IF NOT EXISTS idx_precios_fecha_solo ON precios(fecha)"],
    &["CREATE TABLE IF NOT EXISTS user_configs (
            username TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            last_filter TEXT NOT NULL DEFAULT 'all'
        )"],
    &[
        "CREATE TABLE IF NOT EXISTS user_roles (
            username TEXT NOT NULL,
            role TEXT NOT NULL,
            PRIMARY KEY (username, role)
        )",
        "CREATE INDEX IF NOT EXISTS idx_user_roles_username ON user_roles(username)",
    ], // Index 4: New migration
    &[
        "CREATE TABLE IF NOT EXISTS routes (
            hash TEXT NOT NULL,
            data TEXT NOT NULL,
            PRIMARY KEY (hash)
        )",
        "CREATE TABLE IF NOT EXISTS route_searches (
            hash TEXT NOT NULL,
            route_index INTEGER NOT NULL,
            username TEXT NOT NULL,
            PRIMARY KEY (hash, username),
            FOREIGN KEY (username) REFERENCES user_configs(username),
            FOREIGN KEY (hash) REFERENCES routes(hash)
        )",
        "CREATE INDEX IF NOT EXISTS idx_route_searches_user ON route_searches(username)",
    ],
    &[
        "ALTER TABLE user_configs ADD COLUMN tank_maximum REAL",
        "ALTER TABLE user_configs ADD COLUMN avg_consumption REAL",
    ],
    &["CREATE TABLE IF NOT EXISTS enrollments (
            token_hash TEXT PRIMARY KEY,
            cn TEXT NOT NULL,
            label TEXT NOT NULL,
            created_by TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            used_at INTEGER,
            used_serial TEXT
        )"],
    // Store prices only when they change, instead of one row per station per download.
    // fecha goes from local-time text ("%Y-%m-%d %H:%M:%S") to unix seconds, which is much smaller.
    //
    // - snapshots: the time of every download.
    // - precios: a station's prices from `fecha` until its next row. A row is written when a
    //   station first appears, reappears, or any price changes (NULL included). A row with
    //   reportado = 0 means the station stopped appearing in downloads (its prices are NULL).
    //   Clustered on (id_estacion, fecha): every query on it is per station.
    // - precios_actuales: the prices of the stations present in the latest snapshot.
    // - precios_provincia: per snapshot and province, the sum and count of every fuel's prices,
    //   so average prices for any area are a quick SUM(suma) / SUM(n).
    &[
        "CREATE TABLE snapshots (fecha INTEGER PRIMARY KEY)",
        "INSERT INTO snapshots (fecha)
            SELECT DISTINCT CAST(strftime('%s', fecha, 'utc') AS INTEGER) FROM precios ORDER BY 1",
        "CREATE TABLE precios_provincia (
            fecha INTEGER NOT NULL,
            id_provincia TEXT NOT NULL,
            id_ccaa TEXT NOT NULL,
            suma_gasoleo_a REAL,
            n_gasoleo_a INTEGER NOT NULL,
            suma_gasolina_95 REAL,
            n_gasolina_95 INTEGER NOT NULL,
            PRIMARY KEY (fecha, id_provincia)
        ) WITHOUT ROWID",
        "INSERT INTO precios_provincia
            SELECT CAST(strftime('%s', p.fecha, 'utc') AS INTEGER), e.id_provincia, e.id_ccaa,
                SUM(p.gasoleo_a), COUNT(p.gasoleo_a), SUM(p.gasolina_95), COUNT(p.gasolina_95)
            FROM precios p
            JOIN estaciones e ON e.id = p.id_estacion
            GROUP BY p.fecha, e.id_provincia",
        "CREATE TABLE precios_new (
            id_estacion INTEGER NOT NULL,
            fecha INTEGER NOT NULL,
            reportado INTEGER NOT NULL,
            gasoleo_a REAL,
            gasolina_95 REAL,
            PRIMARY KEY (id_estacion, fecha),
            FOREIGN KEY (id_estacion) REFERENCES estaciones(id)
        ) WITHOUT ROWID",
        // n numbers the snapshots, so a gap in a station's n sequence means it wasn't reported.
        // Keep the rows that start a run or change a price, and add a reportado = 0 row at the
        // snapshot after the end of every run that isn't the latest snapshot.
        "INSERT INTO precios_new (id_estacion, fecha, reportado, gasoleo_a, gasolina_95)
            WITH sn AS (
                SELECT fecha, row_number() OVER (ORDER BY fecha) AS n FROM snapshots
            ),
            p AS (
                SELECT p.id_estacion, sn.fecha, sn.n, p.gasoleo_a AS a, p.gasolina_95 AS b
                FROM precios p
                JOIN sn ON sn.fecha = CAST(strftime('%s', p.fecha, 'utc') AS INTEGER)
            ),
            l AS (
                SELECT *, lag(n) OVER w AS pn, lag(a) OVER w AS pa, lag(b) OVER w AS pb,
                    lead(n) OVER w AS nn
                FROM p
                WINDOW w AS (PARTITION BY id_estacion ORDER BY n)
            )
            SELECT id_estacion, fecha, 1, a, b FROM l
                WHERE pn IS NULL OR pn <> n - 1 OR a IS NOT pa OR b IS NOT pb
            UNION ALL
            SELECT l.id_estacion, sn.fecha, 0, NULL, NULL FROM l
                JOIN sn ON sn.n = l.n + 1
                WHERE l.nn IS NULL OR l.nn <> l.n + 1
            ORDER BY 1, 2",
        "DROP TABLE precios",
        "ALTER TABLE precios_new RENAME TO precios",
        "CREATE TABLE precios_actuales (
            id_estacion INTEGER PRIMARY KEY,
            gasoleo_a REAL,
            gasolina_95 REAL,
            FOREIGN KEY (id_estacion) REFERENCES estaciones(id)
        )",
        "INSERT INTO precios_actuales (id_estacion, gasoleo_a, gasolina_95)
            SELECT p.id_estacion, p.gasoleo_a, p.gasolina_95
            FROM estaciones e
            CROSS JOIN precios p ON p.id_estacion = e.id
                AND p.fecha = (SELECT MAX(fecha) FROM precios q WHERE q.id_estacion = e.id)
            WHERE p.reportado = 1",
    ],
];

pub const DEFAULT_DB_PATH: &str = "precios_carburantes.db";
static MIGRATIONS_APPLIED: Mutex<bool> = Mutex::new(false);

fn get_hash(mig: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for statement in mig {
        hasher.update(statement.as_bytes());
    }
    let result = hasher.finalize();
    result.iter().map(|b| format!("{:02x}", b)).collect()
}

pub fn get_migration_hashes() -> impl Iterator<Item = (usize, String)> {
    MIGRATIONS.iter().map(|&x| get_hash(x)).enumerate()
}

fn apply_init(conn: &mut Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
    ",
    )?;

    eprintln!("Locking migrations");
    let mut lock = MIGRATIONS_APPLIED.lock().unwrap();

    if !*lock {
        eprintln!("Applying migrations");
        let mut applied_any = false;
        let mut tx = conn.transaction()?;

        tx.execute(
            "CREATE TABLE IF NOT EXISTS migrations (
            id INTEGER PRIMARY KEY,
            migration_hash TEXT
        )",
            [],
        )?;

        for (i, &mig) in MIGRATIONS.iter().enumerate() {
            let i = i as i64;
            let hash = get_hash(mig);

            let old_hash: Option<String> = tx
                .query_one(
                    "SELECT migration_hash FROM migrations WHERE id = ?",
                    params![&i],
                    |row| row.get("migration_hash"),
                )
                .optional()?;

            if let Some(old_hash) = old_hash {
                if hash != old_hash {
                    panic!(
                        "Non matching hashes ({:?} vs applied {:?}) for migration {}: {:?}",
                        hash, old_hash, i as u64, mig
                    )
                } else {
                    eprintln!(
                        "Migration {} with hash {:?} already applied",
                        i as u64, hash
                    );
                }
            } else {
                eprintln!("Applying migration {} with hash {:?}", i as u64, hash);
                let savepoint = tx.savepoint()?;
                for x in mig {
                    savepoint.execute(x, params![])?;
                }
                savepoint.execute(
                    "INSERT INTO migrations (id, migration_hash) VALUES (?1, ?2)",
                    params![i, hash],
                )?;
                savepoint.commit()?;
                applied_any = true;
            }
        }

        tx.commit()?;

        // Migrations may free a lot of pages (e.g. table rebuilds); VACUUM can't run inside
        // a transaction, so reclaim the space here.
        if applied_any {
            eprintln!("Vacuuming database");
            conn.execute_batch("VACUUM")?;
        }

        *lock = true;
    }

    drop(lock);

    Ok(())
}

pub fn get_connection_manager<P: AsRef<Path>>(db: P) -> rusqlite::Result<SqliteConnectionManager> {
    // Run migrations eagerly on a dedicated connection: a slow migration (table rebuild + VACUUM)
    // inside the pool's init would make the pool's other connections time out waiting on the lock.
    apply_init(&mut Connection::open(&db)?)?;
    Ok(SqliteConnectionManager::file(db).with_init(apply_init))
}
