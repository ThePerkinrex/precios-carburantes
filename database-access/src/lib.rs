use std::{
    hash::{DefaultHasher, Hash, Hasher},
    path::Path,
    sync::Mutex,
};

use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{Connection, OptionalExtension, params};

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
];

pub const DEFAULT_DB_PATH: &str = "precios_carburantes.db";
static MIGRATIONS_APPLIED: Mutex<bool> = Mutex::new(false);

fn apply_init(conn: &mut Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
    ",
    )?;

    println!("Locking migrations");
    let mut lock = MIGRATIONS_APPLIED.lock().unwrap();

    if !*lock {
        println!("Applying migrations");
        let mut tx = conn.transaction()?;

        tx.execute(
            "CREATE TABLE IF NOT EXISTS migrations (
            id INTEGER PRIMARY KEY,
            migration_hash INTEGER
        )",
            [],
        )?;

        for (i, &mig) in MIGRATIONS.iter().enumerate() {
            let i = i as i64;
            let mut hasher = DefaultHasher::new();

            mig.hash(&mut hasher);

            let hash = hasher.finish() as i64;

            let old_hash: Option<i64> = tx
                .query_one(
                    "SELECT migration_hash FROM migrations WHERE id = ?",
                    params![&i],
                    |row| row.get("migration_hash"),
                )
                .optional()?;

            if let Some(old_hash) = old_hash {
                if hash != old_hash {
                    panic!(
                        "Non matching hashes ({:x} vs applied {:x}) for migration {}: {:?}",
                        hash as u64, old_hash as u64, i as u64, mig
                    )
                } else {
                    println!(
                        "Migration {} with hash {:x} already applied",
                        i as u64, hash as u64
                    );
                }
            } else {
                println!(
                    "Applying migration {} with hash {:x}",
                    i as u64, hash as u64
                );
                let savepoint = tx.savepoint()?;
                for x in mig {
                    savepoint.execute(x, params![])?;
                }
                savepoint.execute(
                    "INSERT INTO migrations (id, migration_hash) VALUES (?1, ?2)",
                    params![i, hash],
                )?;
                savepoint.commit()?;
            }
        }

        tx.commit()?;

        *lock = true;
    }

    drop(lock);

    Ok(())
}

pub fn get_connection_manager<P: AsRef<Path>>(db: P) -> rusqlite::Result<SqliteConnectionManager> {
    Ok(SqliteConnectionManager::file(db).with_init(apply_init))
}
