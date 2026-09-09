use crate::capture::{SavedExchange, Summary};
use crate::websocket::Event;
use anyhow::{Result, bail};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params, params_from_iter, types::Value};
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
    fn stars_and_notes_are_kept_and_searchable() {
        let (dir, file) = temp_file("marks");
        let mut h = History::open(&file).unwrap();
        let mut rows: Vec<_> = (1..=3).map(saved).collect();
        let mut mocked = saved(4);
        mocked.summary.mock = true;
        rows.push(mocked);
        h.restore_json(&serde_json::to_string(&rows).unwrap())
            .unwrap();
        h.flush().unwrap();
        // is:mock reads the flag out of the summary; the plain rows do not match it.
        let flag = |reader: &Store, value: &str| {
            reader
                .search(&Search {
                    rules: vec![Rule {
                        field: "mock".into(),
                        op: "eq".into(),
                        value: value.into(),
                    }],
                    ..Search::default()
                })
                .unwrap()
        };
        {
            let reader = Store::open_reader(&file).unwrap();
            let mocks = flag(&reader, "1");
            assert_eq!(mocks.matched, 1);
            assert_eq!(mocks.rows[0].id, 4);
            assert!(mocks.rows[0].mock);
            assert_eq!(flag(&reader, "0").matched, 3);
            // header: scans the "name: value" lines of both sides.
            let header = |value: &str| {
                reader
                    .search(&Search {
                        rules: vec![Rule {
                            field: "header".into(),
                            op: "contains".into(),
                            value: value.into(),
                        }],
                        ..Search::default()
                    })
                    .unwrap()
                    .matched
            };
            assert_eq!(header("Content-Type: image/PNG"), 4, "case does not matter");
            assert_eq!(header("set-cookie"), 0);
        }
        // frame: looks into the socket frames of an exchange.
        {
            use crate::websocket::{Event, Message};
            h.ws_event(Event::Start(3));
            h.ws_event(Event::Message(
                3,
                Message::new(0, "in", "text", b"Hello, Frame!"),
            ));
            h.flush().unwrap();
            let reader = Store::open_reader(&file).unwrap();
            let frame = |op: &str, value: &str| {
                reader
                    .search(&Search {
                        rules: vec![Rule {
                            field: "frame".into(),
                            op: op.into(),
                            value: value.into(),
                        }],
                        ..Search::default()
                    })
                    .unwrap()
            };
            let hits = frame("contains", "hello, frame");
            assert_eq!(hits.matched, 1);
            assert_eq!(hits.rows[0].id, 3);
            assert_eq!(frame("not_contains", "hello").matched, 3);
            assert!(
                reader
                    .search(&Search {
                        rules: vec![Rule {
                            field: "frame".into(),
                            op: "eq".into(),
                            value: "x".into(),
                        }],
                        ..Search::default()
                    })
                    .is_err(),
                "only contains / not_contains make sense for frames"
            );
        }
        assert!(h.mark(2, Some(true), Some("Check this Later")).unwrap());
        assert!(
            !h.mark(99, Some(true), None).unwrap(),
            "unknown ids are reported"
        );
        h.flush().unwrap();
        let reader = Store::open_reader(&file).unwrap();
        let starred = reader
            .search(&Search {
                rules: vec![Rule {
                    field: "starred".into(),
                    op: "eq".into(),
                    value: "1".into(),
                }],
                ..Search::default()
            })
            .unwrap();
        assert_eq!(starred.matched, 1);
        assert_eq!(starred.rows[0].id, 2);
        assert!(starred.rows[0].starred);
        assert_eq!(starred.rows[0].note, "Check this Later");
        let by_note = reader
            .search(&Search {
                query: "later".into(),
                ..Search::default()
            })
            .unwrap();
        assert_eq!(by_note.matched, 1, "plain words search the note too");
        let note_rule = reader
            .search(&Search {
                rules: vec![Rule {
                    field: "note".into(),
                    op: "contains".into(),
                    value: "check".into(),
                }],
                ..Search::default()
            })
            .unwrap();
        assert_eq!(note_rule.matched, 1);
        assert!(reader.detail(2).unwrap().unwrap().summary.starred);
        assert!(h.mark(2, Some(false), Some("")).unwrap());
        h.flush().unwrap();
        assert_eq!(
            reader
                .search(&Search {
                    rules: vec![Rule {
                        field: "starred".into(),
                        op: "eq".into(),
                        value: "1".into(),
                    }],
                    ..Search::default()
                })
                .unwrap()
                .matched,
            0
        );
        drop(h);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn stats_aggregate_the_matching_rows() {
        let (dir, file) = temp_file("stats");
        let mut h = History::open(&file).unwrap();
        let mut rows: Vec<serde_json::Value> = (1..=20)
            .map(|id| serde_json::to_value(saved(id)).unwrap())
            .collect();
        rows[0]["summary"]["status"] = serde_json::json!(500);
        rows[1]["summary"]["status"] = serde_json::Value::Null;
        rows[1]["summary"]["error"] = serde_json::json!("boom");
        rows[2]["summary"]["url"] = serde_json::json!("https://other.test/x");
        rows[2]["summary"]["elapsed_ms"] = serde_json::json!(900);
        rows[3]["summary"]["status"] = serde_json::Value::Null;
        rows[4]["summary"]["mock"] = serde_json::json!(true);
        rows[5]["summary"]["mock"] = serde_json::json!(true);
        h.restore_json(&serde_json::to_string(&rows).unwrap())
            .unwrap();
        h.flush().unwrap();
        let reader = Store::open_reader(&file).unwrap();
        let all = reader.stats(&Search::default()).unwrap();
        assert_eq!(all["matched"], 20);
        assert_eq!(all["bytes"], 60);
        assert_eq!(all["errors"], 2, "a 5xx and a failed exchange");
        assert_eq!(all["pending"], 1, "no status and no error");
        assert_eq!(all["mocked"], 2, "answered by mocks");
        assert_eq!(all["elapsed"]["count"], 20);
        assert_eq!(all["elapsed"]["p50"], 1);
        assert_eq!(all["elapsed"]["p95"], 1);
        assert_eq!(all["elapsed"]["max"], 900);
        assert_eq!(all["hosts"][0]["host"], "example.test");
        assert_eq!(all["hosts"][0]["count"], 19);
        assert_eq!(all["hosts"][0]["errors"], 2);
        assert_eq!(all["hosts"][1]["host"], "other.test");
        assert_eq!(all["hosts"][1]["elapsed_avg"], 900);
        assert_eq!(all["classes"].as_array().unwrap().len(), 2, "2xx and 5xx");
        assert_eq!(all["classes"][0]["class"], 2);
        assert_eq!(all["classes"][0]["count"], 17);
        assert_eq!(all["methods"][0]["method"], "get");
        let some = reader
            .stats(&Search {
                query: "other".into(),
                ..Search::default()
            })
            .unwrap();
        assert_eq!(some["matched"], 1);
        assert_eq!(some["elapsed"]["p95"], 900);
        assert_eq!(some["hosts"].as_array().unwrap().len(), 1);
        let none = reader
            .stats(&Search {
                query: "nothing-like-this".into(),
                ..Search::default()
            })
            .unwrap();
        assert_eq!(none["matched"], 0);
        assert_eq!(none["elapsed"]["p50"], serde_json::Value::Null);
        drop(h);
        std::fs::remove_dir_all(dir).unwrap();
    }
    fn temp_file(name: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("librium-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("history.sqlite3");
        (dir, file)
    }
    #[test]
    fn large_history_survives_restart_filters_pages_and_explicit_clear() {
        let (dir, file) = temp_file("history");
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
            assert_eq!(h.revision, 1);
            h.flush().unwrap();
            assert_eq!(h.revision, 1, "an idle flush must not look like a change");
        }
        {
            let mut h = History::open(&file).unwrap();
            let store = h.store.as_mut().unwrap();
            assert_eq!(store.detail(1).unwrap().unwrap().summary.id, 1);
            let page = store.search(&Search::default()).unwrap();
            assert_eq!(page.total, 2500);
            assert_eq!(page.rows.len(), 500);
            assert_eq!(page.rows[0].id, 2500);
            store.save(&[saved(2501)], std::iter::empty()).unwrap();
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
            store.save(&[ws], std::iter::empty()).unwrap();
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
            // A second, read-only connection serves the interface without the history lock.
            let reader = Store::open_reader(&file).unwrap();
            assert_eq!(reader.search(&Search::default()).unwrap().total, 2502);
            let mut typed = saved(2503);
            typed.summary.content_type = "image/png".into();
            store.save(&[typed], std::iter::empty()).unwrap();
            let by_type = reader
                .search(&Search {
                    rules: vec![Rule {
                        field: "type".into(),
                        op: "contains".into(),
                        value: "png".into(),
                    }],
                    ..Search::default()
                })
                .unwrap();
            assert_eq!(by_type.matched, 1);
            assert_eq!(by_type.rows[0].id, 2503);
            let mut spoken = saved(2504);
            spoken.response.text = "{\"Greeting\":\"Hello, Body Search\"}".into();
            store.save(&[spoken], std::iter::empty()).unwrap();
            let gone = store
                .delete_matching(&Search {
                    rules: vec![Rule {
                        field: "id".into(),
                        op: "lte".into(),
                        value: "3".into(),
                    }],
                    ..Search::default()
                })
                .unwrap();
            assert_eq!(gone, vec![1, 2, 3]);
            assert_eq!(reader.search(&Search::default()).unwrap().total, 2501);
            assert!(reader.detail(2).unwrap().is_none());
            let mut broken = saved(2505);
            broken.summary.time = 1_700_000_000_000;
            broken.summary.error = Some("Transfer interrupted before the full body arrived".into());
            let mut waiting = saved(2506);
            waiting.summary.status = None;
            store.save(&[broken, waiting], std::iter::empty()).unwrap();
            let flag = |field: &str, value: &str| {
                reader
                    .search(&Search {
                        rules: vec![Rule {
                            field: field.into(),
                            op: "eq".into(),
                            value: value.into(),
                        }],
                        ..Search::default()
                    })
                    .unwrap()
            };
            assert_eq!(
                flag("error", "1")
                    .rows
                    .iter()
                    .map(|r| r.id)
                    .collect::<Vec<_>>(),
                vec![2505]
            );
            assert_eq!(
                flag("pending", "1")
                    .rows
                    .iter()
                    .map(|r| r.id)
                    .collect::<Vec<_>>(),
                vec![2506]
            );
            assert_eq!(
                flag("error", "0").matched + flag("error", "1").matched,
                reader.search(&Search::default()).unwrap().total,
                "every row is either flagged or not"
            );
            let recent = reader
                .search(&Search {
                    rules: vec![Rule {
                        field: "time".into(),
                        op: "gte".into(),
                        value: "1000".into(),
                    }],
                    ..Search::default()
                })
                .unwrap();
            assert_eq!(
                recent.rows.iter().map(|r| r.id).collect::<Vec<_>>(),
                vec![2505],
                "since: compares the request time"
            );
            let by_body = reader
                .search(&Search {
                    rules: vec![Rule {
                        field: "body".into(),
                        op: "contains".into(),
                        value: "hello, BODY".into(),
                    }],
                    ..Search::default()
                })
                .unwrap();
            assert_eq!(
                by_body.matched, 1,
                "body text is searched case-insensitively"
            );
            assert_eq!(by_body.rows[0].id, 2504);
            let on_disk = |file: &std::path::Path| {
                std::fs::metadata(file).map(|m| m.len()).unwrap_or(0)
                    + std::fs::metadata(file.with_extension("sqlite3-wal"))
                        .map(|m| m.len())
                        .unwrap_or(0)
            };
            let before_clear = on_disk(&file);
            assert_eq!(
                reader.detail(2502).unwrap().unwrap().summary.status,
                Some(403)
            );
            assert!(
                reader.save(&[saved(2503)], std::iter::empty()).is_err(),
                "the reader must not write"
            );
            let revision = h.revision;
            h.clear().unwrap();
            assert_eq!(h.revision, revision + 1);
            assert_eq!(reader.search(&Search::default()).unwrap().total, 0);
            assert!(
                on_disk(&file) < before_clear / 4,
                "clearing must give the disk space back: {} -> {}",
                before_clear,
                on_disk(&file)
            );
            h.close().unwrap();
            let wal = std::fs::metadata(file.with_extension("sqlite3-wal")).map(|m| m.len());
            assert!(
                matches!(wal, Ok(0) | Err(_)),
                "close must checkpoint the WAL while the reader is still open: {wal:?}"
            );
        }
        {
            let store = Store::open(&file).unwrap();
            assert_eq!(store.search(&Search::default()).unwrap().total, 0);
            assert_eq!(
                store.max_id().unwrap(),
                2506,
                "clear and restart must not reuse IDs"
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn failed_save_keeps_unsaved_requests_in_memory() {
        let shared = std::sync::Arc::new(std::sync::Mutex::new(
            History::open(std::path::Path::new(":memory:")).unwrap(),
        ));
        let pragma = |sql: &str| {
            let h = shared.lock().unwrap();
            h.store.as_ref().unwrap().0.execute_batch(sql).unwrap();
        };
        shared
            .lock()
            .unwrap()
            .restore_json(&serde_json::to_string(&vec![saved(1)]).unwrap())
            .unwrap();
        crate::websocket::start_in(&mut shared.lock().unwrap(), 1);
        pragma("PRAGMA query_only=ON");
        assert!(crate::capture::flush_shared(&shared).is_err());
        {
            let h = shared.lock().unwrap();
            assert_eq!(h.rows.len(), 1);
            assert!(
                h.rows[0].unsaved(),
                "an unsaved row must be written next time"
            );
            assert!(h.storage_error.as_deref().unwrap().contains("readonly"));
            assert!(h.store.is_some(), "the store is back after a failed write");
        }
        // Events that arrive while a write is failing keep their order behind the retried ones.
        crate::websocket::end_in(&mut shared.lock().unwrap(), 1, None);
        pragma("PRAGMA query_only=OFF");
        crate::capture::flush_shared(&shared).unwrap();
        let h = shared.lock().unwrap();
        assert!(h.storage_error.is_none());
        assert!(!h.rows[0].unsaved());
        assert!(h.store.as_ref().unwrap().detail(1).unwrap().is_some());
        assert_eq!(
            h.store.as_ref().unwrap().ws_page(1, None, None).unwrap()["state"],
            "closed"
        );
    }
    #[test]
    fn interrupted_transfers_are_marked_at_startup_via_the_pending_flag() {
        let (dir, file) = temp_file("pending");
        {
            // A file from a version without the flag: the migration scans it once.
            let db = Connection::open(&file).unwrap();
            db.execute_batch("CREATE TABLE traffic (id INTEGER PRIMARY KEY, method TEXT NOT NULL, url TEXT NOT NULL, host TEXT NOT NULL, path TEXT NOT NULL, status INTEGER, size INTEGER NOT NULL, search TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT NOT NULL, kind TEXT);").unwrap();
            let mut old = saved(1);
            old.summary.status = None;
            old.summary.elapsed_ms = Some(777);
            old.response.complete = false;
            db.execute("INSERT INTO traffic VALUES (1,'get','https://example.test/','example.test','/',NULL,0,'',?,?,'http')",
                params![serde_json::to_string(&old.summary).unwrap(), serde_json::to_string(&old).unwrap()]).unwrap();
        }
        {
            let store = Store::open(&file).unwrap();
            let backfilled: Option<i64> = store
                .0
                .query_row("SELECT elapsed FROM traffic WHERE id=1", [], |r| r.get(0))
                .unwrap();
            assert_eq!(
                backfilled,
                Some(777),
                "the migration fills elapsed from the summary"
            );
            let (time, error): (Option<i64>, i64) = store
                .0
                .query_row("SELECT time, error FROM traffic WHERE id=1", [], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .unwrap();
            assert_eq!(time, Some(0), "the migration fills time from the summary");
            let headers: String = store
                .0
                .query_row("SELECT headers FROM traffic WHERE id=1", [], |r| r.get(0))
                .unwrap();
            assert_eq!(
                headers, "\n\ncontent-type: image/png",
                "the migration fills the header lines from the detail"
            );
            assert_eq!(error, 1, "the interrupted row is flagged as an error");
            let row = store.detail(1).unwrap().unwrap();
            assert_eq!(
                row.summary.error.as_deref(),
                Some("Connection interrupted when Librium stopped")
            );
            let flagged: i64 = store
                .0
                .query_row("SELECT count(*) FROM traffic WHERE pending=1", [], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(flagged, 0);
            let mut streaming = saved(2);
            streaming.response.complete = false;
            streaming.summary.finished = false;
            let mut failed = saved(3);
            failed.response.complete = false;
            failed.summary.error = Some("upstream reset".into());
            let mut half = saved(5);
            half.request.complete = false;
            half.summary.finished = false;
            half.summary.error = Some("Transfer interrupted before the full body arrived".into());
            store
                .save(&[streaming, failed, saved(4), half], std::iter::empty())
                .unwrap();
            // A row an older build wrote after us: no flag, no `finished` key, one side open.
            let mut foreign = saved(6);
            foreign.response.complete = false;
            let mut json: serde_json::Value = serde_json::to_value(&foreign).unwrap();
            json["summary"].as_object_mut().unwrap().remove("finished");
            store.0.execute("INSERT INTO traffic(id,method,url,host,path,status,size,search,summary,detail,kind,pending,body,elapsed) VALUES (6,'get','https://example.test/old','example.test','/old',200,0,'',?,?,'http',0,'',NULL)",
                params![json["summary"].to_string(), json.to_string()]).unwrap();
            let flagged: i64 = store
                .0
                .query_row("SELECT count(*) FROM traffic WHERE pending=1", [], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(
                flagged, 2,
                "transfers that may still finish are pending, including one with an error on one side"
            );
        }
        {
            let store = Store::open(&file).unwrap();
            let rows = store.search(&Search::default()).unwrap().rows;
            let error = |id: u64| rows.iter().find(|r| r.id == id).unwrap().error.clone();
            assert_eq!(
                error(2).as_deref(),
                Some("Connection interrupted when Librium stopped")
            );
            assert_eq!(error(3).as_deref(), Some("upstream reset"));
            assert_eq!(error(4), None);
            assert_eq!(
                error(5).as_deref(),
                Some("Transfer interrupted before the full body arrived"),
                "an error recorded before the stop is kept"
            );
            assert_eq!(
                error(6).as_deref(),
                Some("Connection interrupted when Librium stopped"),
                "a row written by another build is checked the slow way once"
            );
            assert!(
                rows.iter().all(|r| r.finished),
                "after a restart every stored row is final"
            );
            assert_eq!(
                store.detail(2).unwrap().unwrap().summary.error.as_deref(),
                Some("Connection interrupted when Librium stopped")
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn sorting_is_global_numeric_stable_and_keeps_pending_status_last() {
        let store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let mut rows: Vec<_> = (1..=650).map(saved).collect();
        rows[0].summary.size = 90000;
        rows[1].summary.size = 800;
        rows[2].summary.status = None;
        rows[3].summary.status = Some(500);
        rows[4].summary.elapsed_ms = Some(900);
        rows[5].summary.elapsed_ms = None;
        store.save(&rows, std::iter::empty()).unwrap();
        let slowest = store
            .search(&Search {
                sort: "elapsed".into(),
                order: "desc".into(),
                limit: 1000,
                ..Search::default()
            })
            .unwrap();
        assert_eq!(slowest.rows[0].id, 5, "the slowest exchange comes first");
        assert_eq!(
            slowest.rows.last().unwrap().id,
            6,
            "an exchange without a response is last"
        );
        let fastest = store
            .search(&Search {
                sort: "elapsed".into(),
                order: "asc".into(),
                limit: 1000,
                ..Search::default()
            })
            .unwrap();
        assert_eq!(
            fastest.rows.last().unwrap().id,
            6,
            "pending stays last in both directions"
        );
        let slow = store
            .search(&Search {
                rules: vec![Rule {
                    field: "elapsed".into(),
                    op: "gte".into(),
                    value: "500".into(),
                }],
                ..Search::default()
            })
            .unwrap();
        assert_eq!(slow.rows.iter().map(|r| r.id).collect::<Vec<_>>(), vec![5]);
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

const INTERRUPTED: &str = "Connection interrupted when Librium stopped";
const BODY_SEARCH_LIMIT: usize = 16 * 1024;
/// `header:` scans this many bytes of "name: value" lines per exchange, request then response.
const HEADER_SEARCH_LIMIT: usize = 8 * 1024;
/// The searchable header text of an exchange: one lowercase `name: value` line per header,
/// request lines first, then a blank line, then the response's.
fn header_lines(request: &[(String, String)], response: &[(String, String)]) -> String {
    let mut text = String::new();
    for (name, value) in request {
        text.push_str(name);
        text.push_str(": ");
        text.push_str(value);
        text.push('\n');
    }
    text.push('\n');
    for (name, value) in response {
        text.push_str(name);
        text.push_str(": ");
        text.push_str(value);
        text.push('\n');
    }
    text.to_lowercase()
}

/// The first `limit` bytes of `text`, cut at a character boundary.
fn head(text: &str, limit: usize) -> &str {
    if text.len() <= limit {
        return text;
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn columns(db: &Connection, table: &str) -> Result<Vec<String>> {
    let mut stmt = db.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(names)
}
fn max_id_in(db: &Connection) -> Result<u64> {
    Ok(db.query_row("SELECT max(coalesce((SELECT max(id) FROM traffic),0), coalesce((SELECT value FROM metadata WHERE key='next_id'),0))", [], |r| r.get::<_, i64>(0))? as u64)
}

impl Store {
    pub fn open(path: &std::path::Path) -> Result<Self> {
        let db = Connection::open(path)?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        // WAL with synchronous=NORMAL survives a process crash without an fsync per commit;
        // only a power loss can cost the last moments of traffic, and the file stays consistent.
        db.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
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
            CREATE INDEX IF NOT EXISTS traffic_method ON traffic(method, id);
            CREATE INDEX IF NOT EXISTS traffic_size ON traffic(size, id);
            CREATE INDEX IF NOT EXISTS traffic_path ON traffic(host, path, id);",
        )?;
        let existing = columns(&db, "traffic")?;
        if !existing.iter().any(|n| n == "kind") {
            db.execute_batch("BEGIN; ALTER TABLE traffic ADD COLUMN kind TEXT; UPDATE traffic SET kind=CASE WHEN status=101 OR EXISTS(SELECT 1 FROM json_each(detail,'$.request.headers') WHERE lower(json_extract(value,'$[0]'))='upgrade' AND lower(json_extract(value,'$[1]'))='websocket') THEN 'ws' ELSE 'http' END; CREATE INDEX IF NOT EXISTS traffic_kind ON traffic(kind,id); COMMIT;")?;
        }
        if !existing.iter().any(|n| n == "elapsed") {
            // Time to the first response byte, for sorting and elapsed: conditions. Existing rows
            // are filled from their summaries once, so an old history sorts correctly too.
            db.execute_batch("BEGIN; ALTER TABLE traffic ADD COLUMN elapsed INTEGER; UPDATE traffic SET elapsed=json_extract(summary,'$.elapsed_ms'); CREATE INDEX IF NOT EXISTS traffic_elapsed ON traffic(elapsed, id); COMMIT;")?;
        }
        if !existing.iter().any(|n| n == "body") {
            // Older files have no searchable body text; rows written from now on get it.
            db.execute_batch("ALTER TABLE traffic ADD COLUMN body TEXT NOT NULL DEFAULT ''")?;
        }
        if !existing.iter().any(|n| n == "headers") {
            // Searchable header lines; existing rows are filled from their details once.
            db.execute_batch("BEGIN; ALTER TABLE traffic ADD COLUMN headers TEXT NOT NULL DEFAULT ''; UPDATE traffic SET headers=substr(lower(coalesce((SELECT group_concat(json_extract(value,'$[0]')||': '||json_extract(value,'$[1]'),char(10)) FROM json_each(detail,'$.request.headers')),'')||char(10)||char(10)||coalesce((SELECT group_concat(json_extract(value,'$[0]')||': '||json_extract(value,'$[1]'),char(10)) FROM json_each(detail,'$.response.headers')),'')),1,8192); COMMIT;")?;
        }
        if !existing.iter().any(|n| n == "pending") {
            // Files written before the flag existed are scanned once the slow way, parsing every
            // detail document; from then on only flagged rows are touched at startup.
            db.execute_batch(&format!(
                "BEGIN;
                UPDATE traffic SET summary=json_set(summary,'$.error','{INTERRUPTED}','$.finished',json('true')), detail=json_set(detail,'$.summary.error','{INTERRUPTED}','$.summary.finished',json('true'))
                WHERE json_extract(summary,'$.error') IS NULL
                AND (json_extract(detail,'$.request.complete')=0 OR json_extract(detail,'$.response.complete')=0);
                ALTER TABLE traffic ADD COLUMN pending INTEGER NOT NULL DEFAULT 0;
                CREATE INDEX IF NOT EXISTS traffic_pending ON traffic(pending) WHERE pending=1;
                COMMIT;"
            ))?;
        }
        if !existing.iter().any(|n| n == "error") {
            // Request time and the error flag as indexed columns: since:/until:, is:error and the
            // summary then run on indexes instead of parsing every summary document. After the
            // pending migration above, so interrupted rows it marked count as errors here.
            db.execute_batch("BEGIN; ALTER TABLE traffic ADD COLUMN time INTEGER; ALTER TABLE traffic ADD COLUMN error INTEGER NOT NULL DEFAULT 0; UPDATE traffic SET time=json_extract(summary,'$.time'), error=(json_extract(summary,'$.error') IS NOT NULL); CREATE INDEX IF NOT EXISTS traffic_time ON traffic(time, id); CREATE INDEX IF NOT EXISTS traffic_error ON traffic(error) WHERE error=1; COMMIT;")?;
        }
        if !existing.iter().any(|n| n == "starred") {
            // User marks: a star to find an exchange again and a note to remember why.
            db.execute_batch("BEGIN; ALTER TABLE traffic ADD COLUMN starred INTEGER NOT NULL DEFAULT 0; ALTER TABLE traffic ADD COLUMN note TEXT NOT NULL DEFAULT ''; CREATE INDEX IF NOT EXISTS traffic_starred ON traffic(starred) WHERE starred=1; COMMIT;")?;
        }
        // A process restart cannot resume an old socket, but its captured data must remain
        // inspectable instead of appearing pending forever. An error already recorded for one
        // direction is kept. Rows above `marked_id` were written by another build of Librium
        // (the flag is unknown to older releases), so they get the slow check once.
        let marked: i64 = db.query_row(
            "SELECT coalesce((SELECT value FROM metadata WHERE key='marked_id'),0)",
            [],
            |r| r.get(0),
        )?;
        db.execute_batch(&format!(
            "BEGIN;
            UPDATE traffic SET summary=json_set(summary,'$.error','{INTERRUPTED}'), detail=json_set(detail,'$.summary.error','{INTERRUPTED}'), error=1
            WHERE (pending=1 OR id > {marked}) AND json_extract(summary,'$.error') IS NULL
            AND (json_extract(detail,'$.request.complete')=0 OR json_extract(detail,'$.response.complete')=0);
            UPDATE traffic SET summary=json_set(summary,'$.finished',json('true')), detail=json_set(detail,'$.summary.finished',json('true')), pending=0
            WHERE pending=1 OR (id > {marked} AND json_extract(summary,'$.finished') IS NULL AND json_extract(summary,'$.error') IS NOT NULL);
            INSERT INTO metadata(key,value) VALUES ('marked_id', coalesce((SELECT max(id) FROM traffic),0)) ON CONFLICT(key) DO UPDATE SET value=max(value,excluded.value);
            COMMIT;"
        ))?;
        db.execute("UPDATE ws_sessions SET state='closed',error='Connection closed when Librium restarted' WHERE state='open'", [])?;
        Ok(Self(db))
    }
    /// A read-only connection to the same file. In WAL mode it reads committed data while the
    /// writer keeps going, so interface queries never hold up capture.
    pub fn open_reader(path: &std::path::Path) -> Result<Self> {
        let db = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_URI,
        )?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(Self(db))
    }
    pub fn max_id(&self) -> Result<u64> {
        max_id_in(&self.0)
    }
    pub fn save<'a>(
        &self,
        rows: &[SavedExchange],
        events: impl IntoIterator<Item = &'a Event>,
    ) -> Result<()> {
        let tx = self.0.unchecked_transaction()?;
        {
            let mut insert = tx.prepare_cached("INSERT OR REPLACE INTO traffic(id,method,url,host,path,status,size,search,summary,detail,kind,pending,body,elapsed,time,error,starred,note,headers) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")?;
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
                    "{} {} {} {} {}",
                    i64::try_from(s.id)?,
                    s.method,
                    s.url,
                    s.status.map(|v| v.to_string()).unwrap_or_default(),
                    s.content_type
                )
                .to_lowercase();
                let websocket = s.status == Some(101)
                    || row.request.headers.iter().any(|(k, v)| {
                        k.eq_ignore_ascii_case("upgrade") && v.eq_ignore_ascii_case("websocket")
                    });
                let pending = !s.finished;
                // Searchable text is capped per side: `body:` scans this column for the whole history.
                let body = format!(
                    "{}\n{}",
                    head(&row.request.text, BODY_SEARCH_LIMIT),
                    head(&row.response.text, BODY_SEARCH_LIMIT)
                )
                .to_lowercase();
                let header_text = header_lines(&row.request.headers, &row.response.headers);
                let headers = head(&header_text, HEADER_SEARCH_LIMIT).to_string();
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
                    if websocket { "ws" } else { "http" },
                    pending as i64,
                    body,
                    s.elapsed_ms.map(|ms| ms.min(i64::MAX as u128) as i64),
                    s.time as i64,
                    s.error.is_some() as i64,
                    s.starred as i64,
                    &s.note,
                    headers,
                ])?;
            }
            let mut start =
                tx.prepare_cached("INSERT OR REPLACE INTO ws_sessions VALUES (?,'open',NULL)")?;
            let mut end = tx.prepare_cached(
                "UPDATE ws_sessions SET state='closed',error=? WHERE exchange_id=?",
            )?;
            let mut message = tx.prepare_cached("INSERT INTO ws_messages(exchange_id,data) SELECT ?,? WHERE EXISTS(SELECT 1 FROM ws_sessions WHERE exchange_id=?)")?;
            for event in events {
                match event {
                    Event::Start(id) => start.execute([*id as i64])?,
                    Event::End(id, error) => end.execute(params![error, *id as i64])?,
                    Event::Message(id, data) => message.execute(params![
                        *id as i64,
                        serde_json::to_string(data)?,
                        *id as i64
                    ])?,
                };
            }
        }
        if !rows.is_empty() {
            tx.execute("INSERT INTO metadata(key,value) VALUES ('next_id', coalesce((SELECT max(id) FROM traffic),0)) ON CONFLICT(key) DO UPDATE SET value=max(value,excluded.value)", [])?;
            tx.execute("INSERT INTO metadata(key,value) VALUES ('marked_id', coalesce((SELECT max(id) FROM traffic),0)) ON CONFLICT(key) DO UPDATE SET value=max(value,excluded.value)", [])?;
        }
        tx.commit()?;
        Ok(())
    }
    /// Stores a star and/or a note on one exchange, inside its documents too so pages and
    /// details show them. False when the id is unknown.
    pub fn mark(&self, id: u64, starred: Option<bool>, note: Option<&str>) -> Result<bool> {
        let id = i64::try_from(id)?;
        let tx = self.0.unchecked_transaction()?;
        let mut changed = 0;
        if let Some(starred) = starred {
            changed += tx.execute(
                "UPDATE traffic SET starred=?1, summary=json_set(summary,'$.starred',json(?2)), detail=json_set(detail,'$.summary.starred',json(?2)) WHERE id=?3",
                params![starred as i64, if starred { "true" } else { "false" }, id],
            )?;
        }
        if let Some(note) = note {
            changed += tx.execute(
                "UPDATE traffic SET note=?1, summary=json_set(summary,'$.note',?1), detail=json_set(detail,'$.summary.note',?1) WHERE id=?2",
                params![note, id],
            )?;
        }
        tx.commit()?;
        Ok(changed > 0)
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
    /// A page of frames: the newest 100 (or those before `before`) for the inspector, or the
    /// 100 after `after`, oldest first, for an export walking a socket from its beginning.
    pub fn ws_page(
        &self,
        id: u64,
        before: Option<i64>,
        after: Option<i64>,
    ) -> Result<serde_json::Value> {
        let tx = self.0.unchecked_transaction()?;
        let session: Option<(String, Option<String>)> = tx
            .query_row(
                "SELECT state,error FROM ws_sessions WHERE exchange_id=?",
                [id as i64],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let total: i64 = tx.query_row(
            "SELECT count(*) FROM ws_messages WHERE exchange_id=?",
            [id as i64],
            |r| r.get(0),
        )?;
        let forward = after.is_some();
        let mut statement = tx.prepare(if forward {
            "SELECT id,data FROM ws_messages WHERE exchange_id=? AND id>? ORDER BY id ASC LIMIT 100"
        } else {
            "SELECT id,data FROM ws_messages WHERE exchange_id=? AND id<? ORDER BY id DESC LIMIT 100"
        })?;
        let cursor = if forward {
            after.unwrap_or(0)
        } else {
            before.unwrap_or(i64::MAX)
        };
        let records = statement.query_map(params![id as i64, cursor], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut messages = Vec::new();
        for record in records {
            let (id, json) = record?;
            let mut value: serde_json::Value = serde_json::from_str(&json)?;
            value["id"] = id.into();
            messages.push(value);
        }
        if !forward {
            messages.reverse();
        }
        let oldest = messages.first().and_then(|v| v["id"].as_i64()).unwrap_or(0);
        let newest = messages
            .last()
            .and_then(|v| v["id"].as_i64())
            .unwrap_or(i64::MAX);
        let older: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM ws_messages WHERE exchange_id=? AND id<?)",
            params![id as i64, oldest],
            |r| r.get(0),
        )?;
        let more: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM ws_messages WHERE exchange_id=? AND id>?)",
            params![id as i64, newest],
            |r| r.get(0),
        )?;
        let (state, error) = session.unwrap_or(("not_recorded".into(), None));
        Ok(
            serde_json::json!({"messages":messages,"total":total,"state":state,"error":error,"older":older,"more":more}),
        )
    }
    /// Folds the WAL back into the database file. A read-only connection cannot do this when it
    /// happens to be the last one closed, so the writer does it explicitly before the process ends.
    pub fn checkpoint(&self) -> Result<()> {
        self.0.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
        Ok(())
    }
    /// Removes one exchange with its socket frames; true when it existed.
    pub fn delete(&mut self, id: u64) -> Result<bool> {
        let tx = self.0.transaction()?;
        let id = i64::try_from(id)?;
        tx.execute("DELETE FROM ws_messages WHERE exchange_id=?", [id])?;
        tx.execute("DELETE FROM ws_sessions WHERE exchange_id=?", [id])?;
        let removed = tx.execute("DELETE FROM traffic WHERE id=?", [id])?;
        tx.commit()?;
        Ok(removed > 0)
    }
    /// Deletes everything and gives the space back to the file system; the footer shows the
    /// size, so a clear that left a large file behind would look like it did nothing.
    pub fn clear(&mut self) -> Result<()> {
        let tx = self.0.transaction()?;
        tx.execute_batch("DELETE FROM ws_messages; DELETE FROM ws_sessions; DELETE FROM traffic;")?;
        tx.commit()?;
        self.0
            // VACUUM rewrites the file through the WAL; the checkpoint afterwards folds it back and
            // truncates the log, so both files shrink.
            .execute_batch("VACUUM; PRAGMA wal_checkpoint(TRUNCATE);")?;
        Ok(())
    }
    /// The WHERE clauses of a search: the general one (for counting and deleting) and the
    /// page variant (the status class may prefer a scan), with their bound values.
    fn predicates(search: &Search) -> Result<(Vec<String>, Vec<String>, Vec<Value>)> {
        let mut predicates = vec!["1=1".to_string()];
        let mut values: Vec<Value> = vec![];
        if search.rules.len() > 48 || search.query.len() > 4096 || search.offset > i64::MAX as usize
        {
            bail!("Invalid search");
        }
        if !search.query.is_empty() {
            // Plain words match the searchable row text and the user's note.
            predicates.push("(instr(search, ?) > 0 OR instr(lower(note), ?) > 0)".into());
            values.push(search.query.to_lowercase().into());
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
        // The page query gets a copy: a status class is dense, so when the page is ordered by id
        // a plain scan in id order finds 500 rows almost at once, while the index on status would
        // collect the whole class and sort it. The count still uses the index (the `+` disables it).
        let mut page_predicates = predicates.clone();
        if !search.status.is_empty() {
            if search.status == "pending" {
                predicates.push("status IS NULL".into());
                page_predicates.push("status IS NULL".into());
            } else {
                let class: i64 = search.status.parse()?;
                if !(1..=5).contains(&class) {
                    bail!("Invalid status");
                }
                predicates.push("status >= ? AND status < ?".into());
                page_predicates.push(if matches!(search.sort.as_str(), "" | "id") {
                    "+status >= ? AND +status < ?".into()
                } else {
                    "status >= ? AND status < ?".into()
                });
                values.extend([
                    Value::Integer(class * 100),
                    Value::Integer((class + 1) * 100),
                ]);
            }
        }
        if let Some(before) = search.before {
            predicates.push("id <= ?".into());
            page_predicates.push("id <= ?".into());
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
                "elapsed" => "elapsed",
                // Stored inside the summary; a scan, like the free-text search.
                "type" => "json_extract(summary,'$.content_type')",
                // The decoded text previews of both bodies; a scan as well.
                "body" => "body",
                // Lowercase "name: value" lines of both sides, request first.
                "header" => "headers",
                // Handled above (an EXISTS over ws_messages); listed so the field is known.
                "frame" => "frame",
                // Flags: is:error / is:pending compare these expressions with 1 or 0.
                "error" => "error",
                "starred" => "starred",
                // Set by mocks only; rare, so it lives in the summary rather than a column.
                "mock" => "coalesce(json_extract(summary,'$.mock'),0)",
                "note" => "lower(note)",
                "pending" => "(status IS NULL)",
                // Milliseconds since the epoch, for since:/until: in the search box.
                "time" => "time",
                _ => bail!("Invalid field"),
            };
            let numeric = matches!(
                rule.field.as_str(),
                "id" | "status"
                    | "size"
                    | "error"
                    | "pending"
                    | "time"
                    | "elapsed"
                    | "starred"
                    | "mock"
            );
            if rule.value.is_empty() || rule.value.len() > 4096 {
                bail!("Invalid value");
            }
            // Socket frames live in their own table: a frame condition is an EXISTS over them.
            if rule.field == "frame" {
                let hit = "EXISTS(SELECT 1 FROM ws_messages WHERE ws_messages.exchange_id=traffic.id AND instr(lower(json_extract(ws_messages.data,'$.text')), ?) > 0)";
                let predicate = match rule.op.as_str() {
                    "contains" => hit.to_string(),
                    "not_contains" => format!("NOT {hit}"),
                    _ => bail!("Invalid operator"),
                };
                page_predicates.push(predicate.clone());
                predicates.push(predicate);
                values.push(rule.value.to_lowercase().into());
                continue;
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
            page_predicates.push(predicate.clone());
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
        Ok((predicates, page_predicates, values))
    }
    /// Removes every exchange the search matches, with their socket frames; returns the ids.
    pub fn delete_matching(&mut self, search: &Search) -> Result<Vec<u64>> {
        let (predicates, _, values) = Self::predicates(search)?;
        let filter = predicates.join(" AND ");
        let tx = self.0.transaction()?;
        let ids: Vec<u64> = {
            let mut statement = tx.prepare(&format!("SELECT id FROM traffic WHERE {filter}"))?;
            let rows = statement.query_map(params_from_iter(&values), |r| r.get::<_, i64>(0))?;
            rows.map(|r| r.map(|id| id as u64))
                .collect::<rusqlite::Result<_>>()?
        };
        for table in ["ws_messages", "ws_sessions"] {
            tx.execute(
                &format!("DELETE FROM {table} WHERE exchange_id IN (SELECT id FROM traffic WHERE {filter})"),
                params_from_iter(&values),
            )?;
        }
        tx.execute(
            &format!("DELETE FROM traffic WHERE {filter}"),
            params_from_iter(&values),
        )?;
        tx.commit()?;
        Ok(ids)
    }
    /// Aggregates over everything the search matches: totals, latency percentiles, status
    /// classes, methods and the busiest hosts. One read transaction, like `search`.
    pub fn stats(&self, search: &Search) -> Result<serde_json::Value> {
        let (predicates, _, values) = Self::predicates(search)?;
        let filter = predicates.join(" AND ");
        let error = "error=1";
        let tx = self.0.unchecked_transaction()?;
        let (matched, bytes, errors, pending, timed, mocked): (i64, i64, i64, i64, i64, i64) = tx.query_row(
            &format!("SELECT count(*), coalesce(sum(size),0), coalesce(sum({error} OR status >= 400),0), coalesce(sum(status IS NULL AND error=0),0), coalesce(sum(elapsed IS NOT NULL),0), coalesce(sum(coalesce(json_extract(summary,'$.mock'),0)),0) FROM traffic WHERE {filter}"),
            params_from_iter(&values),
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )?;
        let percentile = |share: f64| -> Result<Option<i64>> {
            if timed == 0 {
                return Ok(None);
            }
            let mut values = values.clone();
            values.push(Value::Integer(((timed - 1) as f64 * share).round() as i64));
            Ok(Some(tx.query_row(
                &format!("SELECT elapsed FROM traffic WHERE {filter} AND elapsed IS NOT NULL ORDER BY elapsed LIMIT 1 OFFSET ?"),
                params_from_iter(&values),
                |r| r.get(0),
            )?))
        };
        let elapsed = serde_json::json!({"count": timed, "p50": percentile(0.5)?, "p95": percentile(0.95)?, "max": percentile(1.0)?});
        let mut statement = tx.prepare(&format!(
            "SELECT status/100, count(*) FROM traffic WHERE {filter} AND status IS NOT NULL GROUP BY 1 ORDER BY 1"
        ))?;
        let classes: Vec<serde_json::Value> = statement
            .query_map(params_from_iter(&values), |r| {
                Ok(serde_json::json!({"class": r.get::<_, i64>(0)?, "count": r.get::<_, i64>(1)?}))
            })?
            .collect::<rusqlite::Result<_>>()?;
        let mut statement = tx.prepare(&format!(
            "SELECT method, count(*) FROM traffic WHERE {filter} GROUP BY method ORDER BY 2 DESC, method LIMIT 8"
        ))?;
        let methods: Vec<serde_json::Value> = statement
            .query_map(params_from_iter(&values), |r| {
                Ok(serde_json::json!({"method": r.get::<_, String>(0)?, "count": r.get::<_, i64>(1)?}))
            })?
            .collect::<rusqlite::Result<_>>()?;
        let mut statement = tx.prepare(&format!(
            "SELECT host, count(*), coalesce(sum(size),0), coalesce(sum({error} OR status >= 400),0), avg(elapsed), max(elapsed) FROM traffic WHERE {filter} GROUP BY host ORDER BY 2 DESC, host LIMIT 15"
        ))?;
        let hosts: Vec<serde_json::Value> = statement
            .query_map(params_from_iter(&values), |r| {
                Ok(serde_json::json!({
                    "host": r.get::<_, String>(0)?,
                    "count": r.get::<_, i64>(1)?,
                    "bytes": r.get::<_, i64>(2)?,
                    "errors": r.get::<_, i64>(3)?,
                    "elapsed_avg": r.get::<_, Option<f64>>(4)?.map(|v| v.round() as i64),
                    "elapsed_max": r.get::<_, Option<i64>>(5)?,
                }))
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(serde_json::json!({
            "matched": matched, "bytes": bytes, "errors": errors, "pending": pending, "mocked": mocked,
            "elapsed": elapsed, "classes": classes, "methods": methods, "hosts": hosts,
        }))
    }
    pub fn search(&self, search: &Search) -> Result<Page> {
        let (predicates, page_predicates, mut values) = Self::predicates(search)?;
        let column = match search.sort.as_str() {
            "" | "id" => "id",
            "method" => "method",
            "url" => "host",
            "status" => "status",
            "size" => "size",
            "elapsed" => "elapsed",
            _ => bail!("Invalid sort field"),
        };
        let direction = match search.order.as_str() {
            "" | "desc" => "DESC",
            "asc" => "ASC",
            _ => bail!("Invalid sort direction"),
        };
        // Every ordering walks an index: the tiebreaker follows the direction, and a pending
        // status (NULL) stays last both ways without an expression SQLite would have to sort by.
        let ordering = match (column, direction) {
            ("host", _) => format!("host {direction},path {direction},id {direction}"),
            ("status", "ASC") => "status ASC NULLS LAST,id ASC".to_string(),
            ("elapsed", "ASC") => "elapsed ASC NULLS LAST,id ASC".to_string(),
            _ => format!("{column} {direction},id {direction}"),
        };
        let filter = predicates.join(" AND ");
        let scan_filter = page_predicates.join(" AND ");
        // One read transaction, so the counts and the page describe the same snapshot
        // even while the writer commits new traffic in between.
        let tx = self.0.unchecked_transaction()?;
        let total: i64 = tx.query_row("SELECT count(*) FROM traffic", [], |r| r.get(0))?;
        let matched = if predicates.len() == 1 {
            total
        } else {
            tx.query_row(
                &format!("SELECT count(*) FROM traffic WHERE {filter}"),
                params_from_iter(&values),
                |r| r.get(0),
            )?
        };
        let limit = if search.limit == 0 {
            500
        } else {
            search.limit.min(1000)
        } as i64;
        // Walking the table in id order finds a page after about (offset+limit)·total/matched rows,
        // while the index has to collect and sort all `matched` rows: pick whichever is cheaper.
        let page_filter = if scan_filter != filter
            && matched.saturating_mul(matched)
                > (search.offset as i64 + limit).saturating_mul(total)
        {
            &scan_filter
        } else {
            &filter
        };
        values.push(Value::Integer(limit));
        values.push(Value::Integer(search.offset as i64));
        let mut statement = tx.prepare(&format!(
            "SELECT summary FROM traffic WHERE {page_filter} ORDER BY {ordering} LIMIT ? OFFSET ?"
        ))?;
        let records = statement.query_map(params_from_iter(&values), |r| r.get::<_, String>(0))?;
        let mut rows = Vec::new();
        for record in records {
            rows.push(serde_json::from_str(&record?)?);
        }
        let newest = max_id_in(&tx)?;
        Ok(Page {
            rows,
            total,
            matched,
            newest,
        })
    }
}
