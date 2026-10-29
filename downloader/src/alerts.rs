//! Price alerts: checks each download's price changes against the users' rules and queues what
//! fired in `notification_outbox`, one message per user, for the service to send.
//!
//! Everything happens inside the import's transaction, so a message is queued exactly when the
//! prices that caused it are stored, and `drop_by`'s `ref_price` moves with it.

use std::collections::{HashMap, HashSet};

use rusqlite::{Result, Transaction, params};
use serde::Serialize;

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    AnyDrop,
    /// `value` cents below `ref_price`.
    DropBy,
    /// Crossing `value` €/l on the way down.
    Below,
}

struct Rule {
    id: i64,
    username: String,
    /// 0 for Gasóleo A, 1 for Gasolina 95, as in the price tuples.
    fuel: usize,
    fuel_name: &'static str,
    kind: Kind,
    value: Option<f64>,
    ref_price: Option<f64>,
}

/// One rule that fired, as the service reads it from the outbox.
#[derive(Serialize)]
struct Fired {
    alert_id: i64,
    station_id: i32,
    fuel: &'static str,
    kind: &'static str,
    value: Option<f64>,
    /// The price the drop is measured from: the previous one, or `ref_price` for drop_by.
    from: f64,
    to: f64,
}

#[derive(Serialize)]
struct Body<'a> {
    alerts: &'a [Fired],
}

type Prices = (Option<f64>, Option<f64>);

pub struct Alerts {
    by_station: HashMap<i32, Vec<Rule>>,
    fired: Vec<(String, Fired)>,
    /// drop_by rules whose `ref_price` changed.
    moved: HashSet<(i32, usize)>,
}

/// Prices have three decimals: compare them in tenths of a cent so float noise doesn't matter.
fn mills(price: f64) -> i64 {
    (price * 1000.0).round() as i64
}

impl Alerts {
    /// The rules on stations their users still have saved.
    pub fn load(tx: &Transaction) -> Result<Self> {
        let mut by_station: HashMap<i32, Vec<Rule>> = HashMap::new();
        let mut stmt = tx.prepare(
            "SELECT a.id, a.username, a.station_id, a.fuel, a.kind, a.value, a.ref_price
            FROM price_alerts a
            JOIN user_stations u ON u.username = a.username AND u.station_id = a.station_id
            WHERE u.kind = 'saved'",
        )?;
        let rows = stmt.query_map([], |row| {
            let (fuel, fuel_name) = match row.get_ref(3)?.as_str()? {
                "gasoleo_a" => (0, "gasoleo_a"),
                _ => (1, "gasolina_95"),
            };
            let kind = match row.get_ref(4)?.as_str()? {
                "any_drop" => Kind::AnyDrop,
                "drop_by" => Kind::DropBy,
                _ => Kind::Below,
            };
            Ok((
                row.get::<_, i32>(2)?,
                Rule {
                    id: row.get(0)?,
                    username: row.get(1)?,
                    fuel,
                    fuel_name,
                    kind,
                    value: row.get(5)?,
                    ref_price: row.get(6)?,
                },
            ))
        })?;
        for row in rows {
            let (station, rule) = row?;
            by_station.entry(station).or_default().push(rule);
        }
        Ok(Self {
            by_station,
            fired: Vec::new(),
            moved: HashSet::new(),
        })
    }

    /// Station `id`'s prices went from `old` (None if it wasn't in the last download) to `new`.
    pub fn check(&mut self, id: i32, old: Option<Prices>, new: Prices) {
        let Some(rules) = self.by_station.get_mut(&id) else {
            return;
        };
        let pick = |p: Prices, fuel: usize| if fuel == 0 { p.0 } else { p.1 };
        for (i, rule) in rules.iter_mut().enumerate() {
            let Some(to) = pick(new, rule.fuel) else {
                continue;
            };
            let before = old.and_then(|o| pick(o, rule.fuel));
            let from = match rule.kind {
                Kind::AnyDrop => before.filter(|&b| mills(to) < mills(b)),
                Kind::Below => {
                    let limit = mills(rule.value.unwrap_or(0.0));
                    before.filter(|&b| mills(b) > limit && mills(to) <= limit)
                }
                Kind::DropBy => match rule.ref_price {
                    // Made while the station had no price: start from the first one it reports.
                    None => {
                        rule.ref_price = Some(to);
                        self.moved.insert((id, i));
                        None
                    }
                    Some(reference) => {
                        let wanted = (rule.value.unwrap_or(0.0) * 10.0).round() as i64;
                        let fired = mills(reference) - mills(to) >= wanted;
                        if fired {
                            rule.ref_price = Some(to);
                            self.moved.insert((id, i));
                        }
                        fired.then_some(reference)
                    }
                },
            };
            if let Some(from) = from {
                self.fired.push((
                    rule.username.clone(),
                    Fired {
                        alert_id: rule.id,
                        station_id: id,
                        fuel: rule.fuel_name,
                        kind: match rule.kind {
                            Kind::AnyDrop => "any_drop",
                            Kind::DropBy => "drop_by",
                            Kind::Below => "below",
                        },
                        value: rule.value,
                        from,
                        to,
                    },
                ));
            }
        }
    }

    /// Queues one message per user for what fired, and stores the moved `ref_price`s. Returns
    /// how many messages it queued.
    pub fn save(self, tx: &Transaction, fecha: i64) -> Result<usize> {
        let mut update = tx.prepare("UPDATE price_alerts SET ref_price = ?2 WHERE id = ?1")?;
        for (station, i) in &self.moved {
            let rule = &self.by_station[station][*i];
            update.execute(params![rule.id, rule.ref_price])?;
        }

        let mut by_user: HashMap<String, Vec<Fired>> = HashMap::new();
        for (username, fired) in self.fired {
            by_user.entry(username).or_default().push(fired);
        }
        let mut insert = tx.prepare(
            "INSERT INTO notification_outbox (username, fecha, body, created_at, next_attempt_at)
            VALUES (?1, ?2, ?3, ?4, ?4)",
        )?;
        let now = chrono::Utc::now().timestamp();
        for (username, alerts) in &by_user {
            let body = serde_json::to_string(&Body { alerts }).expect("serializable");
            insert.execute(params![username, fecha, body, now])?;
        }
        Ok(by_user.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alerts(kind: Kind, value: Option<f64>, ref_price: Option<f64>) -> Alerts {
        let rule = Rule {
            id: 1,
            username: "ana".into(),
            fuel: 0,
            fuel_name: "gasoleo_a",
            kind,
            value,
            ref_price,
        };
        Alerts {
            by_station: HashMap::from([(7, vec![rule])]),
            fired: Vec::new(),
            moved: HashSet::new(),
        }
    }

    fn fired(a: &Alerts) -> Vec<(f64, f64)> {
        a.fired.iter().map(|(_, f)| (f.from, f.to)).collect()
    }

    #[test]
    fn any_drop_fires_on_drops_only() {
        let mut a = alerts(Kind::AnyDrop, None, None);
        a.check(7, Some((Some(1.459), None)), (Some(1.469), None));
        a.check(7, Some((Some(1.469), None)), (Some(1.469), Some(1.6)));
        a.check(7, Some((Some(1.469), None)), (Some(1.449), None));
        // Coming back to the list isn't a drop.
        a.check(7, None, (Some(1.3), None));
        assert_eq!(fired(&a), [(1.469, 1.449)]);
    }

    #[test]
    fn below_fires_when_crossing() {
        let mut a = alerts(Kind::Below, Some(1.40), None);
        a.check(7, Some((Some(1.41), None)), (Some(1.40), None));
        // Still below: no new message.
        a.check(7, Some((Some(1.40), None)), (Some(1.39), None));
        a.check(7, Some((Some(1.39), None)), (Some(1.42), None));
        a.check(7, Some((Some(1.42), None)), (Some(1.35), None));
        assert_eq!(fired(&a), [(1.41, 1.40), (1.42, 1.35)]);
    }

    #[test]
    fn drop_by_adds_up_small_drops() {
        let mut a = alerts(Kind::DropBy, Some(3.0), Some(1.500));
        a.check(7, Some((Some(1.500), None)), (Some(1.490), None));
        a.check(7, Some((Some(1.490), None)), (Some(1.480), None));
        a.check(7, Some((Some(1.480), None)), (Some(1.470), None));
        assert_eq!(fired(&a), [(1.500, 1.470)]);
        assert_eq!(a.by_station[&7][0].ref_price, Some(1.470));
        assert!(a.moved.contains(&(7, 0)));
    }

    #[test]
    fn drop_by_ignores_rises() {
        // The reference stays put when the price goes up.
        let mut a = alerts(Kind::DropBy, Some(3.0), Some(1.500));
        a.check(7, Some((Some(1.500), None)), (Some(1.550), None));
        a.check(7, Some((Some(1.550), None)), (Some(1.480), None));
        assert!(a.fired.is_empty());
        a.check(7, Some((Some(1.480), None)), (Some(1.470), None));
        assert_eq!(fired(&a), [(1.500, 1.470)]);
    }

    #[test]
    fn drop_by_starts_from_first_price() {
        let mut a = alerts(Kind::DropBy, Some(2.0), None);
        a.check(7, None, (Some(1.500), None));
        assert!(a.fired.is_empty());
        assert_eq!(a.by_station[&7][0].ref_price, Some(1.500));
        a.check(7, Some((Some(1.500), None)), (Some(1.480), None));
        assert_eq!(fired(&a), [(1.500, 1.480)]);
    }
}
