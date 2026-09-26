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
    // Rebuild precios as a WITHOUT ROWID table clustered on (fecha, id_estacion).
    // The old rowid table + PK autoindex + two secondary indexes stored every row four times.
    // idx_precios_estacion implicitly contains the PK, so it covers (id_estacion, fecha) lookups.
    // fecha goes from local-time text ("%Y-%m-%d %H:%M:%S") to unix seconds, which is much smaller.
    &[
        "CREATE TABLE precios_new (
            fecha INTEGER NOT NULL,
            id_estacion INTEGER NOT NULL,
            gasoleo_a REAL,
            gasolina_95 REAL,
            PRIMARY KEY (fecha, id_estacion),
            FOREIGN KEY (id_estacion) REFERENCES estaciones(id)
        ) WITHOUT ROWID",
        "INSERT INTO precios_new (fecha, id_estacion, gasoleo_a, gasolina_95)
            SELECT CAST(strftime('%s', fecha, 'utc') AS INTEGER), id_estacion, gasoleo_a, gasolina_95
            FROM precios
            ORDER BY fecha, id_estacion",
        "DROP TABLE precios",
        "ALTER TABLE precios_new RENAME TO precios",
        "CREATE INDEX idx_precios_estacion ON precios(id_estacion)",
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
