use crate::capture::{SavedExchange, Summary};
use anyhow::{Result, bail};
use rusqlite::{Connection, OptionalExtension, params, params_from_iter, types::Value};
use serde::{Deserialize, Serialize};

pub struct Store(Connection);

#[derive(Default, Deserialize)]
#[serde(default)]
pub struct Search {
    pub offset: usize,
    pub limit: usize,
    pub query: String,
    pub method: String,
    pub status: String,
    pub traffic_type: String,
    pub sort: String,
    pub order: String,
    pub rules: Vec<Rule>,
    pub before: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::History;
    fn saved(id: u64) -> SavedExchange {
        serde_json::from_value(serde_json::json!({
            "summary":{"id":id,"time":0,"method":"GET","url":format!("https://example.test/assets/{id}.png?q=100%"),"status":200,"elapsed_ms":1,"size":3,"error":null},
            "request":{"headers":[],"text":"","base64":"","size":0,"complete":true,"truncated":false},
            "response":{"headers":[["content-type","image/png"]],"text":"png","base64":"cG5n","size":3,"complete":true,"truncated":false}
        })).unwrap()
    }
    #[test]
    fn large_history_survives_restart_filters_pages_and_explicit_clear() {
        let dir = std::env::temp_dir().join(format!("librium-history-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("history.sqlite3");
        {
            let mut h = History::open(&file).unwrap();
            let rows: Vec<_> = (1..=2500).map(saved).collect();
            h.restore_json(&serde_json::to_string(&rows).unwrap())
                .unwrap();
            h.flush().unwrap();
            assert!(
                h.rows.len() <= 200,
                "body previews must leave RAM after being saved"
            );
        }
        {
            let mut h = History::open(&file).unwrap();
            let store = h.store.as_mut().unwrap();
            assert_eq!(store.detail(1).unwrap().unwrap().summary.id, 1);
            let page = store.search(&Search::default()).unwrap();
            assert_eq!(page.total, 2500);
            assert_eq!(page.rows.len(), 500);
            assert_eq!(page.rows[0].id, 2500);
            store.save(&[saved(2501)]).unwrap();
            let older = store
                .search(&Search {
                    offset: 500,
                    before: Some(2500),
                    ..Search::default()
                })
                .unwrap();
            assert_eq!(
                older.rows[0].id, 2000,
                "new traffic must not shift older pages"
            );
            let found = store
                .search(&Search {
                    query: "/assets/1.png".into(),
                    rules: vec![
                        Rule {
                            field: "host".into(),
                            op: "eq".into(),
                            value: "EXAMPLE.TEST".into(),
                        },
                        Rule {
                            field: "status".into(),
                            op: "gte".into(),
                            value: "200".into(),
                        },
                    ],
                    ..Search::default()
                })
                .unwrap();
            assert_eq!(found.matched, 1);
            assert_eq!(found.rows[0].id, 1);
            let literal = store
                .search(&Search {
                    query: "%' OR 1=1 --".into(),
                    ..Search::default()
                })
                .unwrap();
            assert_eq!(literal.matched, 0);
            let percent = store
                .search(&Search {
                    query: "100%".into(),
                    ..Search::default()
                })
                .unwrap();
            assert_eq!(percent.matched, 2501);
            let mut ws = saved(2502);
            ws.summary.status = Some(403);
            ws.request
                .headers
                .push(("upgrade".into(), "websocket".into()));
            store.save(&[ws]).unwrap();
            let sockets = store
                .search(&Search {
                    traffic_type: "ws".into(),
                    ..Search::default()
                })
                .unwrap();
            assert_eq!(sockets.matched, 1);
            assert_eq!(sockets.rows[0].id, 2502);
            assert_eq!(
                store
                    .search(&Search {
                        traffic_type: "http".into(),
                        ..Search::default()
                    })
                    .unwrap()
                    .matched,
                2501
            );
            h.clear().unwrap();
        }
        {
            let store = Store::open(&file).unwrap();
            assert_eq!(store.search(&Search::default()).unwrap().total, 0);
            assert_eq!(
                store.max_id().unwrap(),
                2502,
                "clear and restart must not reuse IDs"
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn failed_save_keeps_unsaved_requests_in_memory() {
        let mut h = History::open(std::path::Path::new(":memory:")).unwrap();
        h.restore_json(&serde_json::to_string(&vec![saved(1)]).unwrap())
            .unwrap();
        h.store
            .as_ref()
            .unwrap()
            .0
            .execute_batch("PRAGMA query_only=ON")
            .unwrap();
        assert!(h.flush().is_err());
        assert_eq!(h.rows.len(), 1);
        h.store
            .as_ref()
            .unwrap()
            .0
            .execute_batch("PRAGMA query_only=OFF")
            .unwrap();
        h.flush().unwrap();
        assert!(h.store.as_ref().unwrap().detail(1).unwrap().is_some());
    }
    #[test]
    fn sorting_is_global_numeric_stable_and_keeps_pending_status_last() {
        let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let mut rows: Vec<_> = (1..=650).map(saved).collect();
        rows[0].summary.size = 90000;
        rows[1].summary.size = 800;
        rows[2].summary.status = None;
        rows[3].summary.status = Some(500);
        store.save(&rows).unwrap();
        let page = store
            .search(&Search {
                sort: "id".into(),
                order: "asc".into(),
                offset: 500,
                ..Search::default()
            })
            .unwrap();
        assert_eq!(page.rows[0].id, 501);
        let page = store
            .search(&Search {
                sort: "size".into(),
                order: "desc".into(),
                limit: 2,
                ..Search::default()
            })
            .unwrap();
        assert_eq!(page.rows[0].id, 1);
        assert_eq!(page.rows[1].id, 2);
        let page = store
            .search(&Search {
                sort: "status".into(),
                order: "desc".into(),
                limit: 1000,
                ..Search::default()
            })
            .unwrap();
        assert_eq!(page.rows[0].id, 4);
        assert_eq!(page.rows.last().unwrap().id, 3);
        let page = store
            .search(&Search {
                sort: "status".into(),
                order: "asc".into(),
                limit: 1000,
                ..Search::default()
            })
            .unwrap();
        assert_eq!(page.rows.last().unwrap().id, 3);
        assert!(
            store
                .search(&Search {
                    sort: "id; DELETE FROM traffic".into(),
                    ..Search::default()
                })
                .is_err()
        );
    }
}
#[derive(Deserialize)]
pub struct Rule {
    pub field: String,
    pub op: String,
    pub value: String,
}
#[derive(Serialize)]
pub struct Page {
    pub rows: Vec<Summary>,
    pub total: i64,
    pub matched: i64,
    pub newest: u64,
}

impl Store {
    pub fn open(path: &std::path::Path) -> Result<Self> {
        let db = Connection::open(path)?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        db.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS traffic (
                id INTEGER PRIMARY KEY, method TEXT NOT NULL, url TEXT NOT NULL,
                host TEXT NOT NULL, path TEXT NOT NULL, status INTEGER, size INTEGER NOT NULL,
                search TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS ws_sessions (exchange_id INTEGER PRIMARY KEY, state TEXT NOT NULL, error TEXT);
            CREATE TABLE IF NOT EXISTS ws_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, exchange_id INTEGER NOT NULL, data TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS ws_exchange ON ws_messages(exchange_id,id);
            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS traffic_host ON traffic(host, id);
            CREATE INDEX IF NOT EXISTS traffic_status ON traffic(status, id);
            CREATE INDEX IF NOT EXISTS traffic_method ON traffic(method, id);",
        )?;
        let has_kind = {
            let mut stmt = db.prepare("PRAGMA table_info(traffic)")?;
            let names = stmt
                .query_map([], |r| r.get::<_, String>(1))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            names.iter().any(|n| n == "kind")
        };
        if !has_kind {
            db.execute_batch("BEGIN; ALTER TABLE traffic ADD COLUMN kind TEXT; UPDATE traffic SET kind=CASE WHEN status=101 OR EXISTS(SELECT 1 FROM json_each(detail,'$.request.headers') WHERE lower(json_extract(value,'$[0]'))='upgrade' AND lower(json_extract(value,'$[1]'))='websocket') THEN 'ws' ELSE 'http' END; CREATE INDEX IF NOT EXISTS traffic_kind ON traffic(kind,id); COMMIT;")?;
        }
        // A process restart cannot resume an old socket, but its captured data
        // must remain inspectable instead of appearing pending forever.
        db.execute_batch("UPDATE traffic SET
            summary=json_set(summary, '$.error', 'Connection interrupted when Librium stopped'),
            detail=json_set(detail, '$.summary.error', 'Connection interrupted when Librium stopped')
            WHERE json_extract(summary,'$.error') IS NULL
            AND (json_extract(detail,'$.request.complete')=0 OR json_extract(detail,'$.response.complete')=0);")?;
        db.execute("UPDATE ws_sessions SET state='closed',error='Connection closed when Librium restarted' WHERE state='open'", [])?;
        Ok(Self(db))
    }
    pub fn max_id(&self) -> Result<u64> {
        Ok(self.0.query_row("SELECT max(coalesce((SELECT max(id) FROM traffic),0), coalesce((SELECT value FROM metadata WHERE key='next_id'),0))", [], |r| r.get::<_, i64>(0))? as u64)
    }
    pub fn save(&mut self, rows: &[SavedExchange]) -> Result<()> {
        let tx = self.0.transaction()?;
        {
            let mut insert = tx.prepare_cached("INSERT OR REPLACE INTO traffic(id,method,url,host,path,status,size,search,summary,detail,kind) VALUES (?,?,?,?,?,?,?,?,?,?,?)")?;
            for row in rows {
                let s = &row.summary;
                let url = url::Url::parse(&s.url).ok();
                let host = url
                    .as_ref()
                    .and_then(|u| u.host_str())
                    .unwrap_or("")
                    .to_lowercase();
                let path = url
                    .as_ref()
                    .map(|u| {
                        format!(
                            "{}{}",
                            u.path(),
                            u.query().map(|q| format!("?{q}")).unwrap_or_default()
                        )
                    })
                    .unwrap_or_default()
                    .to_lowercase();
                let search = format!(
                    "{} {} {} {}",
                    i64::try_from(s.id)?,
                    s.method,
                    s.url,
                    s.status.map(|v| v.to_string()).unwrap_or_default()
                )
                .to_lowercase();
                insert.execute(params![
                    i64::try_from(s.id)?,
                    s.method.to_lowercase(),
                    s.url.to_lowercase(),
                    host,
                    path,
                    s.status,
                    s.size as i64,
                    search,
                    serde_json::to_string(s)?,
                    serde_json::to_string(row)?,
                    if s.status == Some(101)
                        || row
                            .request
                            .headers
                            .iter()
                            .any(|(k, v)| k.eq_ignore_ascii_case("upgrade")
                                && v.eq_ignore_ascii_case("websocket"))
                    {
                        "ws"
                    } else {
                        "http"
                    }
                ])?;
            }
        }
        tx.execute("INSERT INTO metadata(key,value) VALUES ('next_id', coalesce((SELECT max(id) FROM traffic),0)) ON CONFLICT(key) DO UPDATE SET value=max(value,excluded.value)", [])?;
        tx.commit()?;
        Ok(())
    }
    pub fn detail(&self, id: u64) -> Result<Option<SavedExchange>> {
        let json: Option<String> = self
            .0
            .query_row(
                "SELECT detail FROM traffic WHERE id=?",
                [i64::try_from(id)?],
                |r| r.get(0),
            )
            .optional()?;
        json.map(|s| serde_json::from_str(&s).map_err(Into::into))
            .transpose()
    }
    pub fn ws_start(&self, id: u64) -> Result<()> {
        self.0.execute(
            "INSERT OR REPLACE INTO ws_sessions VALUES (?,'open',NULL)",
            [id as i64],
        )?;
        Ok(())
    }
    pub fn ws_end(&self, id: u64, error: Option<String>) -> Result<()> {
        self.0.execute(
            "UPDATE ws_sessions SET state='closed',error=? WHERE exchange_id=?",
            params![error, id as i64],
        )?;
        Ok(())
    }
    pub fn ws_record(&self, id: u64, message: &crate::websocket::Message) -> Result<()> {
        self.0.execute("INSERT INTO ws_messages(exchange_id,data) SELECT ?,? WHERE EXISTS(SELECT 1 FROM ws_sessions WHERE exchange_id=?)",params![id as i64,serde_json::to_string(message)?,id as i64])?;
        Ok(())
    }
    pub fn ws_page(&self, id: u64, before: Option<i64>) -> Result<serde_json::Value> {
        let session: Option<(String, Option<String>)> = self
            .0
            .query_row(
                "SELECT state,error FROM ws_sessions WHERE exchange_id=?",
                [id as i64],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let total: i64 = self.0.query_row(
            "SELECT count(*) FROM ws_messages WHERE exchange_id=?",
            [id as i64],
            |r| r.get(0),
        )?;
        let mut statement=self.0.prepare("SELECT id,data FROM ws_messages WHERE exchange_id=? AND id<? ORDER BY id DESC LIMIT 100")?;
        let records = statement.query_map(params![id as i64, before.unwrap_or(i64::MAX)], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut messages = Vec::new();
        for record in records {
            let (id, json) = record?;
            let mut value: serde_json::Value = serde_json::from_str(&json)?;
            value["id"] = id.into();
            messages.push(value);
        }
        messages.reverse();
        let oldest = messages.first().and_then(|v| v["id"].as_i64()).unwrap_or(0);
        let older: bool = self.0.query_row(
            "SELECT EXISTS(SELECT 1 FROM ws_messages WHERE exchange_id=? AND id<?)",
            params![id as i64, oldest],
            |r| r.get(0),
        )?;
        let (state, error) = session.unwrap_or(("not_recorded".into(), None));
        Ok(
            serde_json::json!({"messages":messages,"total":total,"state":state,"error":error,"older":older}),
        )
    }
    pub fn clear(&mut self) -> Result<()> {
        let tx = self.0.transaction()?;
        tx.execute_batch("DELETE FROM ws_messages; DELETE FROM ws_sessions; DELETE FROM traffic;")?;
        tx.commit()?;
        Ok(())
    }
    pub fn search(&self, search: &Search) -> Result<Page> {
        let mut predicates = vec!["1=1".to_string()];
        let mut values: Vec<Value> = vec![];
        if search.rules.len() > 32 || search.query.len() > 4096 || search.offset > i64::MAX as usize
        {
            bail!("Invalid search");
        }
        if !search.query.is_empty() {
            predicates.push("instr(search, ?) > 0".into());
            values.push(search.query.to_lowercase().into());
        }
        if !search.traffic_type.is_empty() {
            if !["http", "ws"].contains(&search.traffic_type.as_str()) {
                bail!("Invalid traffic type");
            }
            predicates.push("kind = ?".into());
            values.push(search.traffic_type.clone().into());
        }
        if !search.method.is_empty() {
            predicates.push("method = ?".into());
            values.push(search.method.to_lowercase().into());
        }
        if !search.status.is_empty() {
            if search.status == "pending" {
                predicates.push("status IS NULL".into());
            } else {
                let class: i64 = search.status.parse()?;
                if !(1..=5).contains(&class) {
                    bail!("Invalid status");
                }
                predicates.push("status >= ? AND status < ?".into());
                values.extend([
                    Value::Integer(class * 100),
                    Value::Integer((class + 1) * 100),
                ]);
            }
        }
        if let Some(before) = search.before {
            predicates.push("id <= ?".into());
            values.push(Value::Integer(before.try_into()?));
        }
        for rule in &search.rules {
            let column = match rule.field.as_str() {
                "id" => "id",
                "method" => "method",
                "url" => "url",
                "host" => "host",
                "path" => "path",
                "status" => "status",
                "size" => "size",
                _ => bail!("Invalid field"),
            };
            let numeric = matches!(column, "id" | "status" | "size");
            if rule.value.is_empty() || rule.value.len() > 4096 {
                bail!("Invalid value");
            }
            let predicate = match rule.op.as_str() {
                "eq" => format!("{column} = ?"),
                "ne" => format!("{column} != ?"),
                "gte" if numeric => format!("{column} >= ?"),
                "lte" if numeric => format!("{column} <= ?"),
                "contains" if !numeric => format!("instr({column}, ?) > 0"),
                "not_contains" if !numeric => format!("instr({column}, ?) = 0"),
                _ => bail!("Invalid operator"),
            };
            predicates.push(predicate);
            values.push(if numeric {
                let n: i64 = rule.value.parse()?;
                if n < 0 {
                    bail!("Invalid number");
                }
                Value::Integer(n)
            } else {
                rule.value.to_lowercase().into()
            });
        }
        let column = match search.sort.as_str() {
            "" | "id" => "id",
            "method" => "method",
            "url" => "host",
            "status" => "status",
            "size" => "size",
            _ => bail!("Invalid sort field"),
        };
        let direction = match search.order.as_str() {
            "" | "desc" => "DESC",
            "asc" => "ASC",
            _ => bail!("Invalid sort direction"),
        };
        let ordering = if column == "host" {
            format!("host {direction},path {direction},url {direction},id DESC")
        } else {
            format!("{column} IS NULL ASC,{column} {direction},id DESC")
        };
        let filter = predicates.join(" AND ");
        let total = self
            .0
            .query_row("SELECT count(*) FROM traffic", [], |r| r.get(0))?;
        let matched = self.0.query_row(
            &format!("SELECT count(*) FROM traffic WHERE {filter}"),
            params_from_iter(&values),
            |r| r.get(0),
        )?;
        values.push(Value::Integer(if search.limit == 0 {
            500
        } else {
            search.limit.min(1000)
        } as i64));
        values.push(Value::Integer(search.offset as i64));
        let mut statement = self.0.prepare(&format!(
            "SELECT summary FROM traffic WHERE {filter} ORDER BY {ordering} LIMIT ? OFFSET ?"
        ))?;
        let records = statement.query_map(params_from_iter(&values), |r| r.get::<_, String>(0))?;
        let mut rows = Vec::new();
        for record in records {
            rows.push(serde_json::from_str(&record?)?);
        }
        Ok(Page {
            rows,
            total,
            matched,
            newest: self.max_id()?,
        })
    }
}
