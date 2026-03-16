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
    &[
        "CREATE TABLE IF NOT EXISTS precios_valores (
            id INTEGER PRIMARY KEY,
            gasoleo_a REAL,
            gasolina_95 REAL,
            UNIQUE (gasoleo_a, gasolina_95)
        )",
        "CREATE TABLE IF NOT EXISTS precios_lecturas (
            fecha TEXT,
            id_estacion INTEGER,
            id_precio INTEGER NOT NULL,
            PRIMARY KEY (fecha, id_estacion),
            FOREIGN KEY (id_estacion) REFERENCES estaciones(id),
            FOREIGN KEY (id_precio) REFERENCES precios_valores(id)
        )",
        "INSERT OR IGNORE INTO precios_valores (gasoleo_a, gasolina_95)
         SELECT DISTINCT gasoleo_a, gasolina_95
         FROM precios",
        "INSERT OR IGNORE INTO precios_lecturas (fecha, id_estacion, id_precio)
         SELECT p.fecha, p.id_estacion, v.id
         FROM precios p
         JOIN precios_valores v
           ON v.gasoleo_a IS p.gasoleo_a
          AND v.gasolina_95 IS p.gasolina_95",
        "DROP TABLE precios",
        // "CREATE VIEW precios AS
        //  SELECT l.fecha, l.id_estacion, v.gasoleo_a, v.gasolina_95
        //  FROM precios_lecturas l
        //  JOIN precios_valores v ON v.id = l.id_precio",
        // "CREATE TRIGGER precios_insert INSTEAD OF INSERT ON precios
        //  BEGIN
        //      INSERT OR IGNORE INTO precios_valores (gasoleo_a, gasolina_95)
        //      VALUES (NEW.gasoleo_a, NEW.gasolina_95);

        //      INSERT INTO precios_lecturas (fecha, id_estacion, id_precio)
        //      VALUES (
        //          NEW.fecha,
        //          NEW.id_estacion,
        //          (
        //              SELECT id
        //              FROM precios_valores
        //              WHERE gasoleo_a IS NEW.gasoleo_a
        //                AND gasolina_95 IS NEW.gasolina_95
        //          )
        //      );
        //  END",
        "CREATE INDEX IF NOT EXISTS idx_precios_lecturas_estacion_fecha ON precios_lecturas(id_estacion, fecha)",
        "CREATE INDEX IF NOT EXISTS idx_precios_lecturas_fecha ON precios_lecturas(fecha)",
        "CREATE INDEX IF NOT EXISTS idx_precios_lecturas_precio ON precios_lecturas(id_precio)",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_precio_pair ON precios_valores(gasoleo_a, gasolina_95)"
    ],
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
