use crate::capture::{SavedExchange, Summary};
use anyhow::{Result, bail};
use rusqlite::{Connection, OptionalExtension, params, params_from_iter, types::Value};
use serde::{Deserialize, Serialize};

pub struct Store(Connection);

fn ws_message_preview(mut message: serde_json::Value) -> serde_json::Value {
    let text = message["text"].as_str().unwrap_or_default();
    let preview = if text.is_empty() {
        use base64::Engine;
        let encoded = message["base64"].as_str().unwrap_or_default();
        let prefix = encoded.get(..encoded.len().min(64)).unwrap_or_default();
        base64::prelude::BASE64_STANDARD
            .decode(prefix)
            .unwrap_or_default()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        text.chars().take(160).collect()
    };
    let object = message.as_object_mut().unwrap();
    object.remove("base64");
    object.remove("text");
    message["preview"] = preview.into();
    message
}

pub struct WsFilter<'a> {
    pub field_exact: Option<&'a crate::ws_fields::FieldExact>,
    pub socketio_exact: Option<&'a crate::socketio::EventKey>,
    pub query: &'a str,
    pub kind: &'a str,
    pub format: &'a str,
    pub direction: &'a str,
    pub pointer: &'a str,
}

#[derive(Default, Serialize)]
struct WsTotals {
    count: i64,
    bytes: f64,
    stored_bytes: f64,
    truncated: i64,
}
impl WsTotals {
    fn add(&mut self, other: &Self) {
        self.count += other.count;
        self.bytes += other.bytes;
        self.stored_bytes += other.stored_bytes;
        self.truncated += other.truncated;
    }
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub struct Search {
    pub offset: usize,
    pub limit: usize,
    pub query: String,
    pub method: String,
    pub status: String,
    pub traffic_type: String,
    pub source: Option<crate::capture::Source>,
    pub capture_context: Option<String>,
    pub ws_role: String,
    pub sort: String,
    pub order: String,
    pub rules: Vec<Rule>,
    pub before: Option<u64>,
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ContextsQuery {
    pub search: String,
    pub before: Option<u64>,
    pub through: Option<u64>,
}
impl ContextsQuery {
    pub fn valid(&self) -> bool {
        self.search.len() <= 1024
            && self.search.chars().count() <= 256
            && self.before.is_none_or(|value| value <= i64::MAX as u64)
            && self.through.is_none_or(|value| value <= i64::MAX as u64)
    }
}

struct PreparedWsFilter {
    predicate: String,
    values: Vec<Value>,
    field: Option<crate::ws_fields::Prepared>,
    mask: Option<crate::ws_search::MaskPattern>,
    query: String,
    format: String,
    pointer: String,
    rpc_id: Option<crate::jsonrpc::IdQuery>,
    content_kind: Option<crate::ws_profile::Kind>,
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ArchiveWsQuery {
    pub before: Option<i64>,
    pub through: Option<i64>,
    pub source: Option<crate::capture::Source>,
    pub capture_context: Option<String>,
    pub url: String,
    pub search: String,
    pub kind: String,
    pub format: String,
    pub direction: String,
    pub pointer: String,
    pub exact: Option<crate::json_pointer::ScalarFilter>,
    pub socketio_exact: Option<crate::socketio::EventKey>,
    pub field_exact: Option<crate::ws_fields::FieldExact>,
}
pub struct PreparedArchiveWs {
    query: ArchiveWsQuery,
    filter: PreparedWsFilter,
}
impl ArchiveWsQuery {
    pub fn prepare(self) -> Result<PreparedArchiveWs> {
        if self.before.is_some_and(|v| v < 0)
            || self.through.is_some_and(|v| v < 0)
            || self.url.len() > 4096
            || self
                .capture_context
                .as_deref()
                .is_some_and(|v| !crate::capture::valid_context(v))
        {
            bail!("Invalid archive scope");
        }
        let filter = PreparedWsFilter::new(
            WsFilter {
                field_exact: self.field_exact.as_ref(),
                socketio_exact: self.socketio_exact.as_ref(),
                query: &self.search,
                kind: &self.kind,
                format: &self.format,
                direction: &self.direction,
                pointer: &self.pointer,
            },
            self.exact.as_ref(),
        )?;
        Ok(PreparedArchiveWs {
            query: self,
            filter,
        })
    }
}
impl PreparedWsFilter {
    fn new(
        filter: WsFilter<'_>,
        exact: Option<&crate::json_pointer::ScalarFilter>,
    ) -> Result<Self> {
        let WsFilter {
            field_exact,
            socketio_exact,
            query,
            kind,
            format,
            direction,
            pointer,
        } = filter;
        if (format == "protocol_field") != field_exact.is_some()
            || (field_exact.is_some()
                && (!query.is_empty() || exact.is_some() || socketio_exact.is_some()))
        {
            bail!("Protocol field requires an exclusive exact field condition");
        }
        let prepared = field_exact
            .map(|field| {
                field
                    .prepare()
                    .ok_or_else(|| anyhow::anyhow!("Invalid protocol field"))
            })
            .transpose()?;
        let field_offset = prepared.as_ref().map_or(0, |field| field.offset as i64);
        let field_needle: &[u8] = prepared
            .as_ref()
            .map_or(&[], |field| field.needle.as_slice());
        let field_mode = prepared.as_ref().map_or("bytes", |field| field.mode);
        let exact_key = exact
            .map(|exact| {
                exact
                    .key()
                    .ok_or_else(|| anyhow::anyhow!("Invalid exact scalar"))
            })
            .transpose()?;
        if socketio_exact.is_some()
            && (exact.is_some() || format != "socketio_event" || !query.is_empty())
        {
            bail!("Exact Socket.IO event requires event mode without substring query");
        }
        let exact_key = if let Some(event) = socketio_exact {
            Some(
                event
                    .key()
                    .ok_or_else(|| anyhow::anyhow!("Invalid Socket.IO event"))?,
            )
        } else {
            exact_key
        };
        if exact.is_some() && (format != "jsonpointer" || !query.is_empty()) {
            bail!("Exact scalar requires a JSON field without substring query");
        }
        if (format == "jsonpointer" && crate::json_pointer::tokens(pointer).is_none())
            || (format != "jsonpointer" && !pointer.is_empty())
        {
            bail!("Invalid JSON field path");
        }
        if query.len() > if format == "jsonrpc_id" { 65536 } else { 4096 }
            || !["", "sent", "received"].contains(&direction)
            || ![
                "",
                "text",
                "utf8",
                "msgpack",
                "protobuf",
                "hex",
                "hex_mask",
                "protocol_field",
                "socketio_event",
                "cdp_method",
                "cdp_id",
                "jsonrpc_method",
                "jsonrpc_id",
                "content_kind",
                "jsonpointer",
            ]
            .contains(&format)
            || ![
                "",
                "TEXT",
                "BINARY",
                "PING",
                "PONG",
                "CLOSE",
                "CONTINUATION",
                "DATA",
                "CONTROL",
            ]
            .contains(&kind)
        {
            bail!("Invalid WebSocket search");
        }
        let content_kind = if format == "content_kind" {
            Some(
                crate::ws_profile::Kind::parse(query)
                    .ok_or_else(|| anyhow::anyhow!("Invalid content kind"))?,
            )
        } else {
            None
        };
        let normalized;
        let query = if format == "jsonrpc_id" {
            normalized = crate::jsonrpc::normalize_id_query(query)
                .ok_or_else(|| anyhow::anyhow!("Invalid JSON-RPC ID"))?;
            &normalized
        } else if format == "cdp_id" {
            normalized = crate::cdp_related::normalize_id(query)
                .ok_or_else(|| anyhow::anyhow!("Invalid CDP ID"))?;
            &normalized
        } else if format == "hex_mask" {
            normalized = crate::ws_search::normalize_hex_mask(query)
                .ok_or_else(|| anyhow::anyhow!("Invalid masked byte search"))?;
            &normalized
        } else if format == "hex" {
            normalized = crate::ws_search::normalize_hex(query)
                .ok_or_else(|| anyhow::anyhow!("Invalid byte search"))?;
            &normalized
        } else {
            query
        };
        let mask = if format == "hex_mask" {
            crate::ws_search::MaskPattern::new(query)
        } else {
            None
        };
        let selector = if format == "jsonpointer" {
            pointer
        } else {
            query
        };
        let direction_filter = if direction.is_empty() {
            "?7=''"
        } else {
            "json_extract(data,'$.direction')=?7"
        };
        let filter = format!(
            "{direction_filter} AND (?4='' OR (?4='DATA' AND json_extract(data,'$.kind') IN ('TEXT','BINARY')) OR (?4='CONTROL' AND json_extract(data,'$.kind') IN ('PING','PONG','CLOSE')) OR json_extract(data,'$.kind')=?5) AND (?9 IS NULL OR CASE WHEN ?6='socketio_event' THEN librium_socketio_key(data) ELSE librium_json_scalar(data,?2) END=?9) AND (CASE WHEN ?6='protocol_field' THEN librium_field_match(data,?10,?11,?12) WHEN ?6='jsonpointer' THEN librium_json_field_match(data,?2,?3) WHEN ?6='socketio_event' THEN (?9 IS NOT NULL OR librium_socketio_match(data,?3)) WHEN ?6='content_kind' THEN librium_ws_content_match(data,?3) WHEN ?6 IN ('jsonrpc_method','jsonrpc_id') THEN librium_jsonrpc_match(data,?6,?3) WHEN ?2='' THEN 1 WHEN ?6 IN ('cdp_method','cdp_id') THEN librium_cdp_match(data,?6,?3) WHEN ?6='hex_mask' THEN librium_hex_mask_offset(json_extract(data,'$.base64'),?3) IS NOT NULL WHEN ?6='hex' THEN librium_hex_offset(json_extract(data,'$.base64'),?3) IS NOT NULL WHEN ?6='protobuf' AND json_extract(data,'$.kind')='BINARY' THEN librium_protobuf_match(json_extract(data,'$.base64'),coalesce(json_extract(data,'$.truncated'),0),?3) WHEN ?6='msgpack' AND json_extract(data,'$.kind')='BINARY' THEN librium_msgpack_match(json_extract(data,'$.base64'),coalesce(json_extract(data,'$.truncated'),0),?3) WHEN ?6='utf8' AND json_extract(data,'$.kind')='BINARY' THEN librium_utf8_match(json_extract(data,'$.base64'),coalesce(json_extract(data,'$.truncated'),0),?3) ELSE librium_text_match(json_extract(data,'$.text'),?3) END)"
        );

        let values = vec![
            Value::Null,
            Value::Text(selector.to_owned()),
            Value::Text(query.to_owned()),
            Value::Text(kind.to_owned()),
            Value::Text(kind.to_owned()),
            Value::Text(format.to_owned()),
            Value::Text(direction.to_owned()),
            Value::Null,
            exact_key.map(Value::Text).unwrap_or(Value::Null),
            Value::Integer(field_offset),
            Value::Blob(field_needle.to_vec()),
            Value::Text(field_mode.to_owned()),
        ];
        Ok(Self {
            predicate: filter,
            values,
            field: prepared,
            mask,
            query: query.to_owned(),
            format: format.to_owned(),
            pointer: pointer.to_owned(),
            content_kind,
            rpc_id: if format == "jsonrpc_id" {
                crate::jsonrpc::IdQuery::new(query)
            } else {
                None
            },
        })
    }
    fn params(&self, id: i64, before: Option<i64>) -> Vec<Value> {
        let mut values = self.values.clone();
        values[0] = Value::Integer(id);
        values[7] = before.map(Value::Integer).unwrap_or(Value::Null);
        values
    }
    fn annotate(&self, mut value: serde_json::Value) -> serde_json::Value {
        if let Some(kind) = self.content_kind {
            value["content_kind"] = serde_json::to_value(kind).unwrap();
            if kind == crate::ws_profile::Kind::JsonRpc {
                value["rpc_entries"] =
                    serde_json::json!([crate::ws_profile::classify(&value).entry]);
            }
        }

        if self.format.starts_with("jsonrpc_") {
            value["rpc_entries"] = serde_json::to_value(crate::jsonrpc::matching_entries(
                &value,
                (self.format == "jsonrpc_method").then_some(self.query.as_str()),
                self.rpc_id.as_ref(),
            ))
            .unwrap();
        }
        if let Some(field) = &self.field {
            value["match_offset"] = field.offset.into();
            value["match_length"] = field.width().into();
        }
        if self.format == "jsonpointer"
            && let Some(field) = crate::json_pointer::field(&value, &self.pointer)
        {
            let mut chars = field.chars();
            let preview: String = chars.by_ref().take(160).collect();
            value["field_preview"] = if chars.next().is_some() {
                preview + "…"
            } else {
                preview
            }
            .into();
        }
        if self.format == "hex"
            && !self.query.is_empty()
            && let Some(offset) = crate::ws_search::hex_offset(
                value["base64"].as_str().unwrap_or_default(),
                &self.query,
            )
        {
            value["match_offset"] = offset.into();
        }

        if let Some(pattern) = &self.mask
            && let Some(offset) = pattern.offset(value["base64"].as_str().unwrap_or_default())
        {
            value["match_offset"] = offset.into();
            value["match_length"] = pattern.width().into();
        }

        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::History;
    #[test]
    fn content_group_search_matches_profile_before_paging_and_intersects_filters() {
        use base64::{Engine, prelude::BASE64_STANDARD};
        let file = std::env::temp_dir().join(format!(
            "librium-content-search-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        {
            let mut store = Store::open(&file).unwrap();
            store.save(&[saved(1), saved(2)]).unwrap();
            store.ws_start(1).unwrap();
            store.ws_start(2).unwrap();
            let put = |id, bytes: &[u8], kind: &str, direction: &str, truncated| {
                store
                    .ws_record(
                        id,
                        &crate::websocket::Message {
                            time: 1,
                            direction: direction.into(),
                            kind: kind.into(),
                            text: if kind == "TEXT" {
                                String::from_utf8_lossy(bytes).into()
                            } else {
                                String::new()
                            },
                            base64: BASE64_STANDARD.encode(bytes),
                            size: bytes.len(),
                            truncated,
                        },
                    )
                    .unwrap()
            };
            for _ in 0..225 {
                put(1, &[255, 1], "BINARY", "sent", false);
            }
            for (bytes, kind, partial) in [
                (
                    br#"[7,{"jsonrpc":"2.0","method":"notice"}]"#.as_slice(),
                    "TEXT",
                    false,
                ),
                (br#"42["ready"]"#.as_slice(), "TEXT", false),
                (br#"{"method":"Runtime.ready"}"#.as_slice(), "TEXT", false),
                (b"1e400".as_slice(), "TEXT", false),
                (b"plain".as_slice(), "TEXT", false),
                (b"plain".as_slice(), "BINARY", false),
                (&[255, 2], "BINARY", false),
                (&[31, 139, 8, 0, 0, 0, 0, 0, 0, 3], "BINARY", false),
                (&[120, 156], "BINARY", false),
                (b"".as_slice(), "TEXT", false),
                (b"partial".as_slice(), "TEXT", true),
                (b"ping".as_slice(), "PING", false),
            ] {
                put(1, bytes, kind, "received", partial);
            }
            put(2, &[255, 3], "BINARY", "received", false);
            let profile = store.ws_profile(1).unwrap().unwrap();
            assert_eq!(profile["groups"].as_array().unwrap().len(), 12);
            let search = |query, kind, direction, before| {
                store
                    .ws_search_exact(
                        1,
                        before,
                        WsFilter {
                            format: "content_kind",
                            query,
                            kind,
                            direction,
                            pointer: "",
                            field_exact: None,
                            socketio_exact: None,
                        },
                        None,
                    )
                    .unwrap()
            };
            for group in profile["groups"].as_array().unwrap() {
                let key = group["kind"].as_str().unwrap();
                let page = search(key, "", "", None);
                assert_eq!(page["matched"], group["count"], "{key}");
                assert!(
                    page["messages"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .all(|m| m["content_kind"] == key)
                );
                assert_eq!(
                    search(key, "", "received", None)["matched"],
                    group["received"]
                );
                let global=store.ws_archive_search(&serde_json::from_value::<ArchiveWsQuery>(serde_json::json!({"format":"content_kind","search":key,"url":"assets/1.png"})).unwrap().prepare().unwrap()).unwrap();
                assert_eq!(global["matched"], group["count"]);
            }
            let first = search("binary", "", "", None);
            assert_eq!(first["matched"], 226);
            assert_eq!(first["messages"].as_array().unwrap().len(), 100);
            assert_eq!(first["older"], true);
            let second = search("binary", "", "", first["messages"][0]["id"].as_i64());
            assert_eq!(second["messages"].as_array().unwrap().len(), 100);
            let last = search("binary", "", "", second["messages"][0]["id"].as_i64());
            assert_eq!(last["messages"].as_array().unwrap().len(), 26);
            assert_eq!(last["older"], false);
            assert_eq!(
                search("json_rpc", "", "", None)["messages"][0]["rpc_entries"],
                serde_json::json!([1])
            );
            assert_eq!(search("control", "DATA", "", None)["matched"], 0);
            assert_eq!(search("control", "CONTROL", "", None)["matched"], 1);
            assert!(store.ws_message(1, 1).unwrap().unwrap()["content_kind"].is_null());
            for invalid in ["", "unknown", "JsonRpc", "TEXT"] {
                assert!(
                    store
                        .ws_search_exact(
                            1,
                            None,
                            WsFilter {
                                format: "content_kind",
                                query: invalid,
                                kind: "",
                                direction: "",
                                pointer: "",
                                field_exact: None,
                                socketio_exact: None
                            },
                            None
                        )
                        .is_err()
                );
                assert!(
                    serde_json::from_value::<ArchiveWsQuery>(
                        serde_json::json!({"format":"content_kind","search":invalid})
                    )
                    .unwrap()
                    .prepare()
                    .is_err()
                );
            }
        }
        let store = Store::open(&file).unwrap();
        let q = serde_json::from_value::<ArchiveWsQuery>(
            serde_json::json!({"format":"content_kind","search":"binary"}),
        )
        .unwrap()
        .prepare()
        .unwrap();
        assert_eq!(store.ws_archive_search(&q).unwrap()["matched"], 227);
        drop(store);
        std::fs::remove_file(file).unwrap();
    }
    #[test]
    fn ambiguous_cdp_members_do_not_search_pair_or_profile_as_cdp() {
        use base64::{Engine, prelude::BASE64_STANDARD};
        let file = std::env::temp_dir().join(format!(
            "librium-rpc-unique-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        {
            let mut store = Store::open(&file).unwrap();
            store.save(&[saved(1)]).unwrap();
            store.ws_start(1).unwrap();
            let put = |text: &str, direction: &str| {
                store
                    .ws_record(
                        1,
                        &crate::websocket::Message {
                            time: 1,
                            direction: direction.into(),
                            kind: "TEXT".into(),
                            text: text.into(),
                            base64: BASE64_STANDARD.encode(text),
                            size: text.len(),
                            truncated: false,
                        },
                    )
                    .unwrap();
                store.0.last_insert_rowid()
            };
            let ambiguous = put(r#"{"id":1,"id":2,"method":"Runtime.evaluate"}"#, "sent");
            let command = put(
                r#"{"id":2,"method":"Runtime.evaluate","params":{"x":1,"x":2}}"#,
                "sent",
            );
            put(r#"{"id":2,"result":{}}"#, "received");
            put(
                r#"{"id":2,"error":{"code":1,"code":2,"message":"bad"}}"#,
                "received",
            );
            put(
                r#"{"method":"Runtime.ready","method":"Runtime.evaluate"}"#,
                "received",
            );
            assert_eq!(
                store.ws_cdp_related(1, ambiguous).unwrap().unwrap()["supported"],
                false
            );
            let pair = store.ws_cdp_related(1, command).unwrap().unwrap();
            assert_eq!(pair["status"], "matched");
            assert_eq!(pair["command_count"], 1);
            assert_eq!(pair["response_count"], 1);
            for (format, query, count) in
                [("cdp_id", "2", 2), ("cdp_method", "Runtime.evaluate", 1)]
            {
                let value = store
                    .ws_search_exact(
                        1,
                        None,
                        WsFilter {
                            format,
                            query,
                            kind: "",
                            direction: "",
                            pointer: "",
                            field_exact: None,
                            socketio_exact: None,
                        },
                        None,
                    )
                    .unwrap();
                assert_eq!(value["matched"], count);
                let global = store
                    .ws_archive_search(
                        &serde_json::from_value::<ArchiveWsQuery>(
                            serde_json::json!({"format":format,"search":query}),
                        )
                        .unwrap()
                        .prepare()
                        .unwrap(),
                    )
                    .unwrap();
                assert_eq!(global["matched"], count);
            }
            let profile = store.ws_profile(1).unwrap().unwrap();
            let groups = profile["groups"].as_array().unwrap();
            assert_eq!(
                groups.iter().find(|g| g["kind"] == "cdp_like").unwrap()["count"],
                2
            );
            assert_eq!(
                groups.iter().find(|g| g["kind"] == "json").unwrap()["count"],
                3
            );
            let raw = store.ws_message(1, ambiguous).unwrap().unwrap();
            assert_eq!(
                raw["text"],
                r#"{"id":1,"id":2,"method":"Runtime.evaluate"}"#
            );
        }
        drop(Store::open(&file).unwrap());
        std::fs::remove_file(file).unwrap();
    }
    #[test]
    fn ws_profile_covers_archive_keeps_bounded_direction_examples_and_one_snapshot() {
        use base64::{Engine, prelude::BASE64_STANDARD};
        let file = std::env::temp_dir().join(format!(
            "librium-ws-profile-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        {
            let mut store = Store::open(&file).unwrap();
            store.save(&[saved(1), saved(2)]).unwrap();
            store.ws_start(1).unwrap();
            store.ws_start(2).unwrap();
            let mut message = crate::websocket::Message {
                time: 1,
                direction: "sent".into(),
                kind: "TEXT".into(),
                text: "private-payload-".repeat(2000),
                base64: BASE64_STANDARD.encode("private-payload-".repeat(2000)),
                size: "private-payload-".len() * 2000,
                truncated: false,
            };
            for _ in 0..225 {
                store.ws_record(1, &message).unwrap();
            }
            message.direction = "received".into();
            for _ in 0..5 {
                store.ws_record(1, &message).unwrap();
            }
            message.direction = "sent".into();
            store.ws_record(2, &message).unwrap();
            let source = r#"[7,{"jsonrpc":"2.0","id":1,"result":0}]"#;
            store
                .ws_record(
                    1,
                    &crate::websocket::Message {
                        time: 1,
                        direction: "received".into(),
                        kind: "BINARY".into(),
                        text: String::new(),
                        base64: BASE64_STANDARD.encode(source),
                        size: source.len(),
                        truncated: false,
                    },
                )
                .unwrap();
            let reader = store.read_snapshot().unwrap();
            let before = reader.ws_profile(1).unwrap().unwrap();
            assert_eq!(before["total"], 231);
            assert!(!before.to_string().contains("private-payload-"));
            assert!(before.to_string().len() < 6000);
            let groups = before["groups"].as_array().unwrap();
            assert_eq!(groups.len(), 2);
            assert_eq!(groups[0]["kind"], "text");
            assert_eq!(groups[0]["count"], 230);
            assert_eq!(groups[0]["sent"], 225);
            assert_eq!(groups[0]["received"], 5);
            assert_eq!(groups[0]["examples"].as_array().unwrap().len(), 4);
            assert_eq!(groups[0]["examples"][0]["id"], 1);
            assert_eq!(groups[1]["examples"][0]["entry"], 1);
            store.ws_record(1, &message).unwrap();
            assert_eq!(reader.ws_profile(1).unwrap().unwrap(), before);
            assert_eq!(store.ws_profile(1).unwrap().unwrap()["total"], 232);
            assert!(store.ws_profile(999).unwrap().is_none());
            assert_eq!(store.ws_profile(2).unwrap().unwrap()["total"], 1);
            store.ws_start(999).unwrap();
            assert!(store.ws_profile(999).unwrap().is_none());
        }
        let mut store = Store::open(&file).unwrap();
        assert_eq!(store.ws_profile(1).unwrap().unwrap()["total"], 232);
        store.clear().unwrap();
        assert!(store.ws_profile(1).unwrap().is_none());
        drop(store);
        std::fs::remove_file(file).unwrap();
    }
    #[test]
    fn jsonrpc_structured_search_covers_batches_before_pages_and_global_scope() {
        use base64::{Engine, prelude::BASE64_STANDARD};
        let file = std::env::temp_dir().join(format!(
            "librium-jsonrpc-search-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        {
            let mut store = Store::open(&file).unwrap();
            store.save(&[saved(1), saved(2)]).unwrap();
            store.ws_start(1).unwrap();
            store.ws_start(2).unwrap();
            let put = |id, text: &str, kind: &str, direction: &str, truncated| {
                store
                    .ws_record(
                        id,
                        &crate::websocket::Message {
                            time: 1,
                            direction: direction.into(),
                            kind: kind.into(),
                            text: if kind == "TEXT" {
                                text.into()
                            } else {
                                String::new()
                            },
                            base64: BASE64_STANDARD.encode(text),
                            size: text.len(),
                            truncated,
                        },
                    )
                    .unwrap();
                store.0.last_insert_rowid()
            };
            let first = put(
                1,
                r#"[{"jsonrpc":"2.0","method":"notice"},{"jsonrpc":"2.0","method":"load","id":200},{"jsonrpc":"2.0","method":"other","id":"200"},{"id":200,"method":"load"}]"#,
                "BINARY",
                "sent",
                false,
            );
            for _ in 0..150 {
                put(
                    1,
                    r#"{"jsonrpc":"2.0","method":"noise"}"#,
                    "TEXT",
                    "sent",
                    false,
                );
            }
            let reply = put(
                1,
                r#"[{"jsonrpc":"2.0","result":0,"id":200.0},{"jsonrpc":"2.0","result":1,"id":null}]"#,
                "TEXT",
                "received",
                false,
            );
            put(
                1,
                r#"{"id":200,"method":"load","text":"jsonrpc"}"#,
                "TEXT",
                "sent",
                false,
            );
            put(
                1,
                r#"{"jsonrpc":"2.0","method":"load","id":200}"#,
                "TEXT",
                "sent",
                true,
            );
            put(
                2,
                r#"{"jsonrpc":"2.0","method":"load","id":200}"#,
                "TEXT",
                "sent",
                false,
            );
            let search = |format, query, kind, direction, before| {
                store
                    .ws_search_exact(
                        1,
                        before,
                        WsFilter {
                            format,
                            query,
                            kind,
                            direction,
                            pointer: "",
                            field_exact: None,
                            socketio_exact: None,
                        },
                        None,
                    )
                    .unwrap()
            };
            let found = search("jsonrpc_id", "2e2", "", "", None);
            assert_eq!(found["matched"], 2);
            assert_eq!(found["messages"][0]["id"], first);
            assert_eq!(found["messages"][0]["rpc_entries"], serde_json::json!([1]));
            assert_eq!(found["messages"][1]["id"], reply);
            assert_eq!(found["messages"][1]["rpc_entries"], serde_json::json!([0]));
            assert_eq!(search("jsonrpc_id", r#""200""#, "", "", None)["matched"], 1);
            assert_eq!(search("jsonrpc_id", "null", "", "", None)["matched"], 1);
            assert_eq!(search("jsonrpc_id", "", "", "", None)["matched"], 2);
            assert_eq!(
                search("jsonrpc_id", "200", "BINARY", "sent", None)["matched"],
                1
            );
            assert_eq!(
                search("jsonrpc_id", "200", "", "received", None)["matched"],
                1
            );
            assert_eq!(search("jsonrpc_method", "load", "", "", None)["matched"], 1);
            assert_eq!(search("jsonrpc_method", "LOAD", "", "", None)["matched"], 0);
            let page = search("jsonrpc_method", "", "", "", None);
            assert_eq!(page["matched"], 151);
            assert_eq!(page["older"], true);
            assert_eq!(page["messages"].as_array().unwrap().len(), 100);
            let older = search(
                "jsonrpc_method",
                "",
                "",
                "",
                page["messages"][0]["id"].as_i64(),
            );
            assert_eq!(older["messages"].as_array().unwrap().len(), 51);
            assert_eq!(older["messages"][0]["id"], first);
            assert_eq!(
                older["messages"][0]["rpc_entries"],
                serde_json::json!([0, 1, 2])
            );
            let global = store
                .ws_archive_search(
                    &serde_json::from_value::<ArchiveWsQuery>(
                        serde_json::json!({"format":"jsonrpc_id","search":"200"}),
                    )
                    .unwrap()
                    .prepare()
                    .unwrap(),
                )
                .unwrap();
            assert_eq!(global["matched"], 3);
            assert_eq!(
                global["matches"][0]["message"]["rpc_entries"],
                serde_json::json!([0])
            );
            let literal = format!("\"{}\"", "я".repeat(10000));
            let packet = format!("{{\"jsonrpc\":\"2.0\",\"id\":{literal},\"result\":0}}");
            put(1, &packet, "TEXT", "received", false);
            assert_eq!(search("jsonrpc_id", &literal, "", "", None)["matched"], 1);
            assert!(store.ws_message(1, first).unwrap().unwrap()["rpc_entries"].is_null());
        }
        let store = Store::open(&file).unwrap();
        let q: ArchiveWsQuery =
            serde_json::from_value(serde_json::json!({"format":"jsonrpc_method","search":"load"}))
                .unwrap();
        assert_eq!(
            store.ws_archive_search(&q.prepare().unwrap()).unwrap()["matched"],
            2
        );
        drop(store);
        std::fs::remove_file(file).unwrap();
    }
    #[test]
    fn jsonrpc_pairs_keep_exact_ids_batch_positions_and_do_not_guess_reuse() {
        use base64::{Engine, prelude::BASE64_STANDARD};
        let file =
            std::env::temp_dir().join(format!("librium-jsonrpc-{}.sqlite3", uuid::Uuid::new_v4()));
        let (command, response);
        {
            let mut store = Store::open(&file).unwrap();
            store.save(&[saved(1), saved(2)]).unwrap();
            store.ws_start(1).unwrap();
            store.ws_start(2).unwrap();
            let put = |id, text: &str, direction: &str, time, truncated| {
                store
                    .ws_record(
                        id,
                        &crate::websocket::Message {
                            time,
                            direction: direction.into(),
                            kind: "BINARY".into(),
                            text: String::new(),
                            base64: BASE64_STANDARD.encode(text),
                            size: text.len(),
                            truncated,
                        },
                    )
                    .unwrap();
                store.0.last_insert_rowid()
            };
            command = put(
                1,
                r#"[{"jsonrpc":"2.0","method":"notice"},{"jsonrpc":"2.0","method":"load","params":[],"id":9007199254740993},{"jsonrpc":"2.0","method":"string","id":"1"},{"jsonrpc":"2.0","method":"unknown","id":null},7]"#,
                "sent",
                10,
                false,
            );
            for _ in 0..150 {
                put(
                    1,
                    r#"{"jsonrpc":"2.0","method":"notice"}"#,
                    "sent",
                    11,
                    false,
                );
            }
            // A different connection and the reverse RPC direction do not merge.
            put(
                2,
                r#"{"jsonrpc":"2.0","id":9007199254740993,"result":0}"#,
                "received",
                20,
                false,
            );
            put(
                1,
                r#"{"jsonrpc":"2.0","id":9007199254740993,"method":"reverse"}"#,
                "received",
                20,
                false,
            );
            put(
                1,
                r#"{"jsonrpc":"2.0","id":9007199254740993,"result":0}"#,
                "sent",
                21,
                false,
            );
            response = put(
                1,
                r#"[{"jsonrpc":"2.0","id":"1","result":0},{"jsonrpc":"2.0","id":9007199254740993.0,"error":{"code":-32601,"message":"bad"}},{"jsonrpc":"2.0","id":1,"result":0}]"#,
                "received",
                25,
                false,
            );
            let value = store.ws_jsonrpc_related(1, command, None).unwrap().unwrap();
            assert_eq!(value["selected"], 1);
            assert_eq!(value["status"], "matched");
            assert_eq!(value["latency_ms"], 15);
            assert_eq!(value["id_value"], "9007199254740993");
            assert_eq!(value["responses"][0]["entry"], 1);
            assert_eq!(value["responses"][0]["id"], response);
            let back = store
                .ws_jsonrpc_related(1, response, Some(1))
                .unwrap()
                .unwrap();
            assert_eq!(back["commands"][0]["id"], command);
            assert_eq!(back["commands"][0]["entry"], 1);
            assert_eq!(back["status"], "matched");
            let string = store
                .ws_jsonrpc_related(1, command, Some(2))
                .unwrap()
                .unwrap();
            assert_eq!(string["response_count"], 1);
            assert_eq!(string["id_kind"], "string");
            assert_eq!(string["status"], "matched");
            for entry in [0, 3, 4, 250] {
                assert_eq!(
                    store
                        .ws_jsonrpc_related(1, command, Some(entry))
                        .unwrap()
                        .unwrap()["supported"],
                    false
                );
            }
            assert!(
                store
                    .ws_jsonrpc_related(2, command, None)
                    .unwrap()
                    .is_none()
            );
            let huge = put(
                1,
                r#"{"jsonrpc":"2.0","method":"huge","id":1e400}"#,
                "received",
                50,
                false,
            );
            put(
                1,
                r#"{"jsonrpc":"2.0","result":0,"id":10e399}"#,
                "sent",
                49,
                false,
            );
            let value = store.ws_jsonrpc_related(1, huge, None).unwrap().unwrap();
            assert_eq!(value["status"], "matched");
            assert!(value["latency_ms"].is_null());
            put(
                1,
                r#"{"jsonrpc":"2.0","result":0,"id":9007199254740993}"#,
                "received",
                30,
                true,
            );
            put(
                1,
                r#"{"jsonrpc":"2.0","result":0,"id":9007199254740993,"id":9007199254740993}"#,
                "received",
                30,
                false,
            );
            assert_eq!(
                store.ws_jsonrpc_related(1, command, None).unwrap().unwrap()["status"],
                "matched"
            );
            put(
                1,
                r#"{"jsonrpc":"2.0","method":"reuse","id":9007199254740993}"#,
                "sent",
                40,
                false,
            );
            for _ in 0..25 {
                put(
                    1,
                    r#"{"jsonrpc":"2.0","result":0,"id":9007199254740993}"#,
                    "received",
                    50,
                    false,
                );
            }
            let ambiguous = store.ws_jsonrpc_related(1, command, None).unwrap().unwrap();
            assert_eq!(ambiguous["status"], "ambiguous");
            assert_eq!(ambiguous["response_count"], 26);
            assert_eq!(ambiguous["responses"].as_array().unwrap().len(), 20);
            assert!(ambiguous["latency_ms"].is_null());
        }
        let mut store = Store::open(&file).unwrap();
        assert_eq!(
            store
                .ws_jsonrpc_related(1, response, Some(1))
                .unwrap()
                .unwrap()["status"],
            "ambiguous"
        );
        store.clear().unwrap();
        assert!(
            store
                .ws_jsonrpc_related(1, command, None)
                .unwrap()
                .is_none()
        );
        drop(store);
        std::fs::remove_file(file).unwrap();
    }
    #[test]
    fn ws_context_seeks_old_messages_without_crossing_connections_or_clock_order() {
        use base64::{Engine, prelude::BASE64_STANDARD};
        let file = std::env::temp_dir().join(format!(
            "librium-ws-context-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        let anchor;
        {
            let mut store = Store::open(&file).unwrap();
            store.save(&[saved(1), saved(2)]).unwrap();
            store.ws_start(1).unwrap();
            store.ws_start(2).unwrap();
            let mut ids = Vec::new();
            for n in 0..150 {
                let text = if n == 25 {
                    "<img src=x>".repeat(300)
                } else {
                    format!("packet-{n}")
                };
                let message = crate::websocket::Message {
                    time: 150 - n,
                    direction: if n % 2 == 0 { "sent" } else { "received" }.into(),
                    kind: if n == 24 { "PING" } else { "TEXT" }.into(),
                    base64: BASE64_STANDARD.encode(&text),
                    size: text.len() + 1,
                    text,
                    truncated: true,
                };
                store.ws_record(1, &message).unwrap();
                ids.push(store.0.last_insert_rowid());
                store.ws_record(2, &message).unwrap();
            }
            anchor = ids[25];
            let context = store.ws_context(1, anchor).unwrap().unwrap();
            let messages = context["messages"].as_array().unwrap();
            assert_eq!(messages.len(), 11);
            assert_eq!(context["previous"], ids[24]);
            assert_eq!(context["next"], ids[26]);
            assert_eq!(
                messages
                    .iter()
                    .map(|m| m["id"].as_i64().unwrap())
                    .collect::<Vec<_>>(),
                ids[20..31]
            );
            assert_eq!(messages[4]["kind"], "PING");
            assert!(messages[4]["time"].as_u64() > messages[5]["time"].as_u64());
            assert_eq!(
                messages[5]["preview"].as_str().unwrap().chars().count(),
                160
            );
            assert_eq!(messages[5]["truncated"], true);
            assert!(
                messages
                    .iter()
                    .all(|m| m["base64"].is_null() && m["text"].is_null())
            );
            let first = store.ws_context(1, ids[0]).unwrap().unwrap();
            assert!(first["previous"].is_null());
            assert_eq!(first["messages"].as_array().unwrap().len(), 6);
            let last = store.ws_context(1, ids[149]).unwrap().unwrap();
            assert!(last["next"].is_null());
            assert_eq!(last["messages"].as_array().unwrap().len(), 6);
            assert!(store.ws_context(2, anchor).unwrap().is_none());
            assert!(store.ws_context(1, i64::MAX).unwrap().is_none());
            assert!(store.ws_message(1, anchor).unwrap().unwrap()["base64"].is_string());
        }
        let mut store = Store::open(&file).unwrap();
        assert_eq!(
            store.ws_context(1, anchor).unwrap().unwrap()["messages"]
                .as_array()
                .unwrap()
                .len(),
            11
        );
        store.clear().unwrap();
        assert!(store.ws_context(1, anchor).unwrap().is_none());
        drop(store);
        std::fs::remove_file(file).unwrap();
    }
    #[test]
    fn archive_ws_search_uses_same_typed_protocol_conditions_as_connection_search() {
        use base64::{Engine, prelude::BASE64_STANDARD};
        let file = std::env::temp_dir().join(format!(
            "librium-ws-archive-protocols-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        {
            let mut store = Store::open(&file).unwrap();
            store.save(&[saved(1), saved(2)]).unwrap();
            for id in [1, 2] {
                store.ws_start(id).unwrap();
                for text in [
                    r#"{"event":"ready","id":17,"method":"Runtime.ready"}"#,
                    r#"42/game,["ready",{}]"#,
                ] {
                    store
                        .ws_record(
                            id,
                            &crate::websocket::Message {
                                time: 1,
                                direction: "received".into(),
                                kind: "TEXT".into(),
                                text: text.into(),
                                base64: BASE64_STANDARD.encode(text),
                                size: text.len(),
                                truncated: false,
                            },
                        )
                        .unwrap();
                }
                for bytes in [
                    b"ready".as_slice(),
                    b"\x81\xa5event\xa5ready".as_slice(),
                    b"\x08\x07\x12\x05ready".as_slice(),
                ] {
                    store
                        .ws_record(
                            id,
                            &crate::websocket::Message {
                                time: 1,
                                direction: "sent".into(),
                                kind: "BINARY".into(),
                                text: String::new(),
                                base64: BASE64_STANDARD.encode(bytes),
                                size: bytes.len(),
                                truncated: false,
                            },
                        )
                        .unwrap();
                }
            }
            for value in [
                serde_json::json!({"format":"text","search":"ready"}),
                serde_json::json!({"format":"utf8","search":"ready","kind":"BINARY"}),
                serde_json::json!({"format":"msgpack","search":"ready","kind":"BINARY"}),
                serde_json::json!({"format":"protobuf","search":"ready","kind":"BINARY"}),
                serde_json::json!({"format":"cdp_method","search":"Runtime.ready"}),
                serde_json::json!({"format":"cdp_id","search":"17"}),
                serde_json::json!({"format":"jsonpointer","pointer":"/event","exact":{"kind":"string","value":"ready"}}),
                serde_json::json!({"format":"socketio_event","socketio_exact":{"namespace":"/game","kind":"string","value":"ready"}}),
                serde_json::json!({"format":"protocol_field","field_exact":{"type":"uint8","offset":0,"endian":"le","value":"129"}}),
            ] {
                let q: ArchiveWsQuery = serde_json::from_value(value.clone()).unwrap();
                let mut expected = 0;
                for id in [1, 2] {
                    expected += store
                        .ws_search_exact(
                            id,
                            None,
                            WsFilter {
                                field_exact: q.field_exact.as_ref(),
                                socketio_exact: q.socketio_exact.as_ref(),
                                query: &q.search,
                                kind: &q.kind,
                                format: &q.format,
                                direction: &q.direction,
                                pointer: &q.pointer,
                            },
                            q.exact.as_ref(),
                        )
                        .unwrap()["matched"]
                        .as_i64()
                        .unwrap();
                }
                assert!(expected > 0, "{value}");
                let found = store.ws_archive_search(&q.prepare().unwrap()).unwrap();
                assert_eq!(found["matched"], expected, "{value}");
                assert!(
                    found["matches"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .all(|row| row["message"]["base64"].is_null())
                );
            }
        }
        std::fs::remove_file(file).unwrap();
    }
    #[test]
    fn archive_ws_search_spans_connections_scopes_and_stable_pages() {
        use base64::{Engine, prelude::BASE64_STANDARD};
        let file = std::env::temp_dir().join(format!(
            "librium-ws-archive-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        {
            let mut store = Store::open(&file).unwrap();
            let mut second = saved(2);
            second.summary.capture_context = Some("Scope/B".into());
            second.summary.source = crate::capture::Source::CdpNode;
            store.save(&[saved(1), second]).unwrap();
            store.ws_start(1).unwrap();
            store.ws_start(2).unwrap();
            let message = crate::websocket::Message {
                time: 1,
                direction: "sent".into(),
                kind: "TEXT".into(),
                text: "hello".repeat(1000),
                base64: BASE64_STANDARD.encode("hello".repeat(1000)),
                size: 5000,
                truncated: false,
            };
            for n in 0..225 {
                store.ws_record(1 + n % 2, &message).unwrap();
            }
            let run = |value: serde_json::Value| {
                store
                    .ws_archive_search(
                        &serde_json::from_value::<ArchiveWsQuery>(value)
                            .unwrap()
                            .prepare()
                            .unwrap(),
                    )
                    .unwrap()
            };
            let first = run(serde_json::json!({"search":"hello"}));
            assert_eq!(first["total"], 225);
            assert_eq!(first["matched"], 225);
            assert_eq!(first["matches"].as_array().unwrap().len(), 100);
            assert_eq!(first["older"], true);
            assert!(first.to_string().len() < 80000);
            assert!(first["matches"][0]["message"]["base64"].is_null());
            assert!(first["matches"][0]["message"]["text"].is_null());
            assert_eq!(
                first["matches"][0]["message"]["preview"]
                    .as_str()
                    .unwrap()
                    .len(),
                160
            );
            store.ws_record(2, &message).unwrap();
            let page = run(
                serde_json::json!({"search":"hello","through":first["through"],"before":first["next_before"]}),
            );
            assert_eq!(page["matched"], 225);
            assert_eq!(page["matches"][0]["message"]["id"], 125);
            let last = run(
                serde_json::json!({"search":"hello","through":first["through"],"before":page["next_before"]}),
            );
            assert_eq!(last["matches"].as_array().unwrap().len(), 25);
            assert_eq!(last["older"], false);
            for scope in [
                serde_json::json!({"source":"cdp_node"}),
                serde_json::json!({"capture_context":"Scope/B"}),
                serde_json::json!({"url":"ASSETS/2.PNG"}),
            ] {
                let value = run(scope);
                assert_eq!(value["total"], 113);
                assert_eq!(value["matched"], 113);
                assert!(
                    value["matches"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .all(|row| row["exchange_id"] == 2)
                );
            }
            assert_eq!(run(serde_json::json!({"search":"absent"}))["matched"], 0);
            assert_eq!(
                run(serde_json::json!({"direction":"received"}))["matched"],
                0
            );
            let binary = crate::websocket::Message {
                kind: "BINARY".into(),
                text: String::new(),
                base64: BASE64_STANDARD.encode([1, 2, 255]),
                size: 3,
                ..message
            };
            store.ws_record(2, &binary).unwrap();
            for (format, search) in [("hex", "02 ff"), ("hex_mask", "@1: ?? ff")] {
                let value =
                    run(serde_json::json!({"format":format,"search":search,"kind":"BINARY"}));
                assert_eq!(value["matched"], 1);
                assert_eq!(value["matches"][0]["message"]["match_offset"], 1);
                assert_eq!(value["matches"][0]["message"]["match_length"], 2);
            }
        }
        let mut store = Store::open(&file).unwrap();
        assert_eq!(
            store
                .ws_archive_search(&ArchiveWsQuery::default().prepare().unwrap())
                .unwrap()["matched"],
            227
        );
        store.clear().unwrap();
        assert_eq!(
            store
                .ws_archive_search(&ArchiveWsQuery::default().prepare().unwrap())
                .unwrap()["total"],
            0
        );
        drop(store);
        std::fs::remove_file(file).unwrap();
        for value in [
            serde_json::json!({"before":-1}),
            serde_json::json!({"through":-1}),
            serde_json::json!({"capture_context":"bad\n"}),
            serde_json::json!({"format":"hex_mask","search":"bad"}),
        ] {
            assert!(
                serde_json::from_value::<ArchiveWsQuery>(value)
                    .unwrap()
                    .prepare()
                    .is_err()
            );
        }
    }
    #[test]
    fn empty_ws_search_decodes_each_archived_message_once_and_preserves_session_metadata() {
        use base64::{Engine, prelude::BASE64_STANDARD};
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        let file = std::env::temp_dir().join(format!(
            "librium-empty-search-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        let mut store = Store::open(&file).unwrap();
        store.save(&[saved(1), saved(2)]).unwrap();
        store.ws_start(1).unwrap();
        store.ws_start(2).unwrap();
        let bytes = vec![7u8; 4096];
        let mut message = crate::websocket::Message {
            time: 1,
            direction: "received".into(),
            kind: "BINARY".into(),
            text: String::new(),
            base64: BASE64_STANDARD.encode(&bytes),
            size: bytes.len(),
            truncated: false,
        };
        let count = 700;
        for _ in 0..count {
            store.ws_record(1, &message).unwrap();
        }
        store
            .ws_end_with_close(
                1,
                Some("fixture close error".into()),
                Some(&crate::websocket::CloseInfo {
                    code: 4001,
                    reason: "fixture close".into(),
                    direction: Some("received".into()),
                }),
            )
            .unwrap();
        let reader = store.read_snapshot().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        reader
            .0
            .create_scalar_function(
                "librium_field_match",
                4,
                rusqlite::functions::FunctionFlags::SQLITE_UTF8
                    | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
                move |context| {
                    counter.fetch_add(1, Ordering::Relaxed);
                    let data: String = context.get(0)?;
                    let offset: i64 = context.get(1)?;
                    let needle: Vec<u8> = context.get(2)?;
                    let mode: String = context.get(3)?;
                    Ok(offset >= 0
                        && serde_json::from_str::<serde_json::Value>(&data).is_ok_and(|message| {
                            crate::ws_fields::matches(&message, offset as usize, &needle, &mode)
                        }))
                },
            )
            .unwrap();
        let query = |store: &Store, id, value: &str| {
            let field = crate::ws_fields::FieldExact {
                kind: "uint8".into(),
                offset: 0,
                endian: "le".into(),
                length: None,
                value: value.into(),
            };
            store
                .ws_search_filter(
                    id,
                    None,
                    WsFilter {
                        field_exact: Some(&field),
                        socketio_exact: None,
                        query: "",
                        kind: "DATA",
                        format: "protocol_field",
                        direction: "",
                        pointer: "",
                    },
                )
                .unwrap()
        };
        let started = std::time::Instant::now();
        let result = query(&reader, 1, "255");
        let decoded = calls.load(Ordering::Relaxed);
        println!(
            "empty WS field search: records={count}, decoder_calls={decoded}, elapsed_ms={}",
            started.elapsed().as_millis()
        );
        assert_eq!(
            result,
            serde_json::json!({"messages":[],"total":count,"matched":0,"older":false,"state":"closed","error":"fixture close error","close":{"code":4001,"reason":"fixture close","direction":"received"}})
        );
        assert_eq!(
            decoded, count,
            "an empty result must not repeat full message decoding to fetch an empty page"
        );
        let positive = query(&reader, 1, "7");
        assert_eq!(positive["matched"], count);
        assert_eq!(positive["messages"].as_array().unwrap().len(), 100);
        assert_eq!(positive["older"], true);
        assert_eq!(query(&reader, 2, "255")["matched"], 0);
        message.base64 = BASE64_STANDARD.encode(vec![255u8; 4096]);
        store.ws_record(2, &message).unwrap();
        assert_eq!(query(&reader, 2, "255")["matched"], 0);
        assert_eq!(
            query(&store.read_snapshot().unwrap(), 2, "255")["matched"],
            1
        );
        drop(reader);
        drop(store);
        std::fs::remove_file(file).unwrap();
    }
    #[test]
    fn declared_field_statistics_count_archive_groups_and_match_exact_query_semantics() {
        use crate::ws_fields::{FieldExact, FieldSpec};
        use base64::{Engine, prelude::BASE64_STANDARD};
        let file = std::env::temp_dir().join(format!(
            "librium-field-values-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        let field = FieldSpec {
            kind: "uint16".into(),
            offset: 1,
            endian: "be".into(),
            length: None,
        };
        let put = |store: &Store, id, bytes: &[u8], kind: &str, direction: &str, size| {
            store
                .ws_record(
                    id,
                    &crate::websocket::Message {
                        time: 1,
                        direction: direction.into(),
                        kind: kind.into(),
                        text: String::new(),
                        base64: BASE64_STANDARD.encode(bytes),
                        size,
                        truncated: size > bytes.len(),
                    },
                )
                .unwrap()
        };
        let packet = |value: u16| {
            let mut bytes = vec![0x41];
            bytes.extend(value.to_be_bytes());
            bytes
        };
        {
            let mut store = Store::open(&file).unwrap();
            store
                .save(&[saved(1), saved(2), saved(3), saved(4)])
                .unwrap();
            for id in [1, 2, 4] {
                store.ws_start(id).unwrap();
            }
            for n in 0..130 {
                put(
                    &store,
                    1,
                    &packet(42),
                    "BINARY",
                    if n % 2 == 0 { "sent" } else { "received" },
                    3,
                );
            }
            for n in 0..110 {
                put(&store, 1, &packet(n), "BINARY", "sent", 3);
            }
            put(&store, 1, &packet(42), "BINARY", "received", 30);
            put(&store, 1, &[0x41], "BINARY", "sent", 30);
            put(&store, 1, &packet(42), "PING", "sent", 3);
            put(&store, 1, &[0x41], "BINARY", "sent", 1);
            let snapshot = store.read_snapshot().unwrap();
            let stats = snapshot.ws_field_values(1, &field).unwrap().unwrap();
            assert_eq!(stats["total"], 244);
            assert_eq!(stats["matched"], 241);
            assert_eq!(stats["excluded"], 3);
            assert_eq!(stats["distinct"], 110);
            assert_eq!(stats["other"], 10);
            assert_eq!(stats["rows"].as_array().unwrap().len(), 100);
            assert_eq!(stats["rows"][0]["base64"], BASE64_STANDARD.encode([0, 42]));
            assert_eq!(stats["rows"][0]["count"], 132);
            assert_eq!(stats["rows"][0]["sent"], 66);
            assert_eq!(stats["rows"][0]["received"], 66);
            let exact = FieldExact {
                kind: "uint16".into(),
                offset: 1,
                endian: "be".into(),
                length: None,
                value: "42".into(),
            };
            let matches = store
                .ws_search_filter(
                    1,
                    None,
                    WsFilter {
                        field_exact: Some(&exact),
                        socketio_exact: None,
                        query: "",
                        kind: "",
                        format: "protocol_field",
                        direction: "",
                        pointer: "",
                    },
                )
                .unwrap();
            assert_eq!(matches["matched"], stats["rows"][0]["count"]);
            assert!(store.ws_field_values(3, &field).unwrap().is_none());
            assert!(store.ws_field_values(99, &field).unwrap().is_none());
            assert_eq!(
                store.ws_field_values(2, &field).unwrap().unwrap()["matched"],
                0
            );
            put(&store, 1, &packet(42), "BINARY", "sent", 3);
            assert_eq!(
                snapshot.ws_field_values(1, &field).unwrap().unwrap()["matched"],
                241
            );
            assert_eq!(
                store.ws_field_values(1, &field).unwrap().unwrap()["matched"],
                242
            );
            drop(snapshot);
            for bits in [
                0u64,
                1u64 << 63,
                0x7ff0000000000001,
                0x7ff8000000000000,
                0xfff0000000000001,
            ] {
                put(&store, 2, &bits.to_be_bytes(), "BINARY", "sent", 8);
            }
            let float = FieldSpec {
                kind: "float64".into(),
                offset: 0,
                endian: "be".into(),
                length: None,
            };
            let floats = store.ws_field_values(2, &float).unwrap().unwrap();
            assert_eq!(floats["matched"], 5);
            assert_eq!(floats["distinct"], 3);
            assert_eq!(floats["rows"][0]["count"], 3);
            assert_eq!(
                floats["rows"][0]["base64"],
                BASE64_STANDARD.encode(0x7ff8000000000000u64.to_be_bytes())
            );
            for (bytes, kind) in [
                (vec![0xd1, 0x8f], "BINARY"),
                (vec![0xd0, 0xaf], "BINARY"),
                (vec![0xff, 0], "BINARY"),
                (vec![0x61], "BINARY"),
                (vec![0x61, 0], "BINARY"),
                (vec![0xd1, 0x8f], "PING"),
            ] {
                put(&store, 4, &bytes, kind, "received", bytes.len());
            }
            let utf8 = FieldSpec {
                kind: "utf8".into(),
                offset: 0,
                endian: "le".into(),
                length: Some(2),
            };
            let strings = store.ws_field_values(4, &utf8).unwrap().unwrap();
            assert_eq!(strings["total"], 6);
            assert_eq!(strings["matched"], 3);
            assert_eq!(strings["distinct"], 3);
        }
        let store = Store::open(&file).unwrap();
        assert_eq!(
            store.ws_field_values(1, &field).unwrap().unwrap()["matched"],
            242
        );
        drop(store);
        std::fs::remove_file(file).unwrap();
    }
    #[test]
    fn declared_field_search_prepares_values_before_archive_paging_and_preserves_prefixes() {
        use crate::ws_fields::FieldExact;
        use base64::{Engine, prelude::BASE64_STANDARD};
        let file = std::env::temp_dir().join(format!(
            "librium-field-search-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        let descriptor = FieldExact {
            kind: "uint64".into(),
            offset: 2,
            endian: "le".into(),
            length: None,
            value: "42".into(),
        };
        let packet = |value: u64, le: bool| {
            let mut bytes = vec![0x41, 0x42];
            bytes.extend(if le {
                value.to_le_bytes()
            } else {
                value.to_be_bytes()
            });
            bytes
        };
        let put = |store: &Store, id, bytes: &[u8], kind: &str, direction: &str, size| {
            store
                .ws_record(
                    id,
                    &crate::websocket::Message {
                        time: 1,
                        direction: direction.into(),
                        kind: kind.into(),
                        text: if kind == "TEXT" {
                            String::from_utf8_lossy(bytes).into_owned()
                        } else {
                            String::new()
                        },
                        base64: BASE64_STANDARD.encode(bytes),
                        size,
                        truncated: size > bytes.len(),
                    },
                )
                .unwrap();
        };
        let search = |store: &Store, id, field: &FieldExact, before, kind, direction| {
            store
                .ws_search_filter(
                    id,
                    before,
                    WsFilter {
                        field_exact: Some(field),
                        socketio_exact: None,
                        query: "",
                        kind,
                        format: "protocol_field",
                        direction,
                        pointer: "",
                    },
                )
                .unwrap()
        };
        {
            let mut store = Store::open(&file).unwrap();
            store.save(&[saved(1), saved(2)]).unwrap();
            store.ws_start(1).unwrap();
            store.ws_start(2).unwrap();
            for n in 0..230 {
                put(
                    &store,
                    1,
                    &packet(42, true),
                    "BINARY",
                    if n % 2 == 0 { "sent" } else { "received" },
                    10,
                );
            }
            put(&store, 1, &packet(43, true), "BINARY", "sent", 10);
            put(&store, 1, &packet(42, false), "BINARY", "sent", 10);
            put(
                &store,
                1,
                &[42, 0, 0, 0, 0, 0, 0, 0, 0, 0],
                "BINARY",
                "sent",
                10,
            );
            put(&store, 1, &packet(42, true), "TEXT", "sent", 10);
            put(&store, 1, &packet(42, true), "BINARY", "received", 20);
            put(&store, 1, &packet(42, true)[..4], "BINARY", "sent", 20);
            put(&store, 1, &packet(42, true), "PING", "sent", 10);
            put(&store, 1, &packet(u64::MAX, true), "BINARY", "sent", 10);
            let page = search(&store, 1, &descriptor, None, "DATA", "");
            assert_eq!(page["total"], 238);
            assert_eq!(page["matched"], 232);
            assert_eq!(page["messages"].as_array().unwrap().len(), 100);
            assert_eq!(page["older"], true);
            let before = page["messages"][0]["id"].as_i64().unwrap();
            assert_eq!(
                search(&store, 1, &descriptor, Some(before), "DATA", "")["messages"]
                    .as_array()
                    .unwrap()
                    .len(),
                100
            );
            assert_eq!(
                search(&store, 1, &descriptor, None, "DATA", "sent")["matched"],
                116
            );
            assert_eq!(
                search(&store, 1, &descriptor, None, "CONTROL", "")["matched"],
                0
            );
            assert_eq!(
                search(&store, 1, &descriptor, None, "TEXT", "")["matched"],
                1
            );
            assert_eq!(page["messages"][0]["match_offset"], 2);
            assert_eq!(page["messages"][0]["match_length"], 8);
            let original = store
                .ws_message(1, page["messages"][0]["id"].as_i64().unwrap())
                .unwrap()
                .unwrap();
            assert!(original.get("match_offset").is_none());
            assert!(original.get("match_length").is_none());
            let snapshot = store.read_snapshot().unwrap();
            assert_eq!(
                search(&snapshot, 1, &descriptor, None, "", "")["matched"],
                232
            );
            put(&store, 1, &packet(42, true), "BINARY", "received", 10);
            assert_eq!(
                search(&snapshot, 1, &descriptor, None, "", "")["matched"],
                232
            );
            assert_eq!(search(&store, 1, &descriptor, None, "", "")["matched"], 233);
            drop(snapshot);
            for bits in [
                0u64,
                1u64 << 63,
                0x7ff0000000000001,
                0x7ff8000000000000,
                0xfff0000000000001,
            ] {
                put(&store, 2, &bits.to_be_bytes(), "BINARY", "sent", 8);
            }
            for (value, expected) in [("0", 1), ("-0", 1), ("NaN", 3)] {
                let field = FieldExact {
                    kind: "float64".into(),
                    offset: 0,
                    endian: "be".into(),
                    length: None,
                    value: value.into(),
                };
                assert_eq!(search(&store, 2, &field, None, "", "")["matched"], expected);
            }
            assert!(
                store
                    .ws_search_filter(
                        1,
                        None,
                        WsFilter {
                            field_exact: Some(&descriptor),
                            socketio_exact: None,
                            query: "other",
                            kind: "",
                            format: "protocol_field",
                            direction: "",
                            pointer: ""
                        }
                    )
                    .is_err()
            );
        }
        let store = Store::open(&file).unwrap();
        assert_eq!(search(&store, 1, &descriptor, None, "", "")["matched"], 233);
        drop(store);
        std::fs::remove_file(file).unwrap();
    }
    #[test]
    fn socketio_ack_pairs_are_scoped_ordered_snapshot_consistent_and_bounded() {
        use base64::{Engine, prelude::BASE64_STANDARD};
        let file = std::env::temp_dir().join(format!(
            "librium-socketio-ack-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        let put = |store: &Store, connection, text: &str, direction: &str, time| {
            store
                .ws_record(
                    connection,
                    &crate::websocket::Message {
                        time,
                        direction: direction.into(),
                        kind: "TEXT".into(),
                        text: text.into(),
                        base64: BASE64_STANDARD.encode(text),
                        size: text.len(),
                        truncated: false,
                    },
                )
                .unwrap();
            store.0.last_insert_rowid()
        };
        let (event_id, ack_id);
        {
            let mut store = Store::open(&file).unwrap();
            store.save(&[saved(1), saved(2)]).unwrap();
            store.ws_start(1).unwrap();
            store.ws_start(2).unwrap();
            event_id = put(&store, 1, r#"42/admin,17["event",{}]"#, "sent", 100);
            for _ in 0..700 {
                put(&store, 1, "unrelated", "received", 110);
            }
            put(&store, 2, r#"42/admin,17["other-connection"]"#, "sent", 100);
            put(&store, 2, r#"43/admin,17[]"#, "received", 101);
            put(&store, 1, r#"42/other,17["other-namespace"]"#, "sent", 100);
            put(&store, 1, r#"43/other,17[]"#, "received", 101);
            let reverse_event = put(&store, 1, r#"42/admin,17["reverse"]"#, "received", 100);
            let reverse_ack = put(&store, 1, r#"43/admin,17[]"#, "sent", 102);
            ack_id = put(&store, 1, r#"43/admin,0017[{"ok":true}]"#, "received", 125);
            let data = store.ws_socketio_related(1, event_id).unwrap().unwrap();
            assert_eq!(data["status"], "matched");
            assert_eq!(data["ack_id"], "17");
            assert_eq!(data["namespace"], "/admin");
            assert_eq!(data["pair"], ack_id);
            assert_eq!(data["latency_ms"], 25);
            assert_eq!(data["event_count"], 1);
            assert_eq!(data["ack_count"], 1);
            assert_eq!(data["inspected"], 706);
            assert_eq!(
                store.ws_socketio_related(1, ack_id).unwrap().unwrap()["pair"],
                event_id
            );
            assert_eq!(
                store
                    .ws_socketio_related(1, reverse_event)
                    .unwrap()
                    .unwrap()["pair"],
                reverse_ack
            );
            assert!(store.ws_socketio_related(2, event_id).unwrap().is_none());
            let no_ack = put(&store, 1, r#"42["event"]"#, "sent", 100);
            assert_eq!(
                store.ws_socketio_related(1, no_ack).unwrap().unwrap()["supported"],
                false
            );
            let missing = put(&store, 1, r#"4299["pending"]"#, "sent", 100);
            let snapshot = store.read_snapshot().unwrap();
            assert_eq!(
                snapshot.ws_socketio_related(1, missing).unwrap().unwrap()["status"],
                "missing"
            );
            put(&store, 1, "4399[]", "received", 130);
            assert_eq!(
                snapshot.ws_socketio_related(1, missing).unwrap().unwrap()["status"],
                "missing"
            );
            assert_eq!(
                store.ws_socketio_related(1, missing).unwrap().unwrap()["status"],
                "matched"
            );
            drop(snapshot);
            let binary_event = put(
                &store,
                1,
                r#"451-/files,9007199254740993["file",{"_placeholder":true,"num":0}]"#,
                "sent",
                200,
            );
            put(
                &store,
                1,
                r#"461-/files,9007199254740992[{"_placeholder":true,"num":0}]"#,
                "received",
                201,
            );
            let binary_ack = put(
                &store,
                1,
                r#"461-/files,9007199254740993[{"_placeholder":true,"num":0}]"#,
                "received",
                205,
            );
            let data = store.ws_socketio_related(1, binary_event).unwrap().unwrap();
            assert_eq!(data["pair"], binary_ack);
            assert_eq!(data["headers_only"], true);
            assert_eq!(data["events"][0]["binary_header"], true);
            assert_eq!(data["acks"][0]["binary_header"], true);
            assert_eq!(data["ack_id"], "9007199254740993");
            let clock_event = put(&store, 1, r#"4255["clock"]"#, "sent", 200);
            put(&store, 1, "4355[]", "received", 199);
            let clock = store.ws_socketio_related(1, clock_event).unwrap().unwrap();
            assert_eq!(clock["status"], "matched");
            assert!(clock["latency_ms"].is_null());
            put(&store, 1, "4366[]", "received", 100);
            let wrong_order = put(&store, 1, r#"4266["late"]"#, "sent", 101);
            assert_eq!(
                store.ws_socketio_related(1, wrong_order).unwrap().unwrap()["status"],
                "ambiguous"
            );
            put(&store, 1, r#"42/admin,17["reused"]"#, "sent", 140);
            for _ in 0..22 {
                put(&store, 1, "43/admin,17[]", "received", 141);
            }
            for (kind, truncated) in [("BINARY", false), ("TEXT", true)] {
                let text = "43/admin,17[]";
                store
                    .ws_record(
                        1,
                        &crate::websocket::Message {
                            time: 142,
                            direction: "received".into(),
                            kind: kind.into(),
                            text: if kind == "TEXT" {
                                text.into()
                            } else {
                                String::new()
                            },
                            base64: BASE64_STANDARD.encode(text),
                            size: text.len() + usize::from(truncated),
                            truncated,
                        },
                    )
                    .unwrap();
            }
            let data = store.ws_socketio_related(1, event_id).unwrap().unwrap();
            assert_eq!(data["status"], "ambiguous");
            assert_eq!(data["event_count"], 2);
            assert_eq!(data["ack_count"], 23);
            assert_eq!(data["acks"].as_array().unwrap().len(), 20);
            assert!(data["pair"].is_null());
            assert!(data["latency_ms"].is_null());
        }
        let store = Store::open(&file).unwrap();
        assert_eq!(
            store.ws_socketio_related(1, ack_id).unwrap().unwrap()["status"],
            "ambiguous"
        );
        drop(store);
        std::fs::remove_file(file).unwrap();
    }
    #[test]
    fn socketio_catalogue_counts_typed_namespaces_and_exact_searches_full_archive() {
        use crate::socketio::EventKey;
        use base64::{Engine, prelude::BASE64_STANDARD};
        let file = std::env::temp_dir().join(format!(
            "librium-socketio-events-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        let long = "событие😀".repeat(1200);
        {
            let mut store = Store::open(&file).unwrap();
            store.save(&[saved(1), saved(2)]).unwrap();
            store.ws_start(1).unwrap();
            let put = |text: &str, kind: &str, direction: &str, truncated: bool| {
                store
                    .ws_record(
                        1,
                        &crate::websocket::Message {
                            time: 1,
                            direction: direction.into(),
                            kind: kind.into(),
                            text: if kind == "TEXT" {
                                text.into()
                            } else {
                                String::new()
                            },
                            base64: BASE64_STANDARD.encode(text),
                            size: text.len() + usize::from(truncated),
                            truncated,
                        },
                    )
                    .unwrap();
            };
            for n in 0..230 {
                put(
                    r#"42/admin,17["chat",{}]"#,
                    "TEXT",
                    if n % 2 == 0 { "sent" } else { "received" },
                    false,
                );
            }
            for _ in 0..2 {
                put(r#"42["chat",{}]"#, "TEXT", "sent", false);
            }
            for text in [
                r#"42/admin,["chat:message"]"#,
                r#"42/admin,[17]"#,
                r#"42/admin,["17"]"#,
                r#"42/admin,[1]"#,
                r#"42/admin,[1.0]"#,
                r#"451-/files,["upload",{"_placeholder":true,"num":0}]"#,
                r#"42/admin,["ch\u0061t"]"#,
            ] {
                put(text, "TEXT", "received", false);
            }
            let long_packet = format!("42[{}]", serde_json::to_string(&long).unwrap());
            for _ in 0..2 {
                put(&long_packet, "TEXT", "received", false);
            }
            for n in 0..105 {
                put(&format!(r#"42["unique-{n}"]"#), "TEXT", "sent", false);
            }
            for (text, kind, truncated) in [
                (r#"43["chat"]"#, "TEXT", false),
                (r#"42["chat"]"#, "BINARY", false),
                (r#"42["chat"]"#, "TEXT", true),
                (r#"42["chat",]"#, "TEXT", false),
            ] {
                put(text, kind, "sent", truncated);
            }
            assert!(store.ws_socketio_events(2).unwrap().is_none());
            assert!(store.ws_socketio_events(99).unwrap().is_none());
            let snapshot = store.read_snapshot().unwrap();
            let data = snapshot.ws_socketio_events(1).unwrap().unwrap();
            assert_eq!(data["total"], 350);
            assert_eq!(data["matched"], 346);
            assert_eq!(data["excluded"], 4);
            assert_eq!(data["distinct"], 114);
            assert_eq!(data["other"], 14);
            assert_eq!(data["rows"].as_array().unwrap().len(), 100);
            assert_eq!(data["rows"][0]["value"], "chat");
            assert_eq!(data["rows"][0]["namespace"], "/admin");
            assert_eq!(data["rows"][0]["count"], 231);
            assert_eq!(data["rows"][0]["sent"], 115);
            assert_eq!(data["rows"][0]["received"], 116);
            let search = |namespace: &str, kind: &str, value: &str, before, direction: &str| {
                let exact = EventKey {
                    namespace: namespace.into(),
                    kind: kind.into(),
                    value: value.into(),
                };
                snapshot
                    .ws_search_filter(
                        1,
                        before,
                        WsFilter {
                            field_exact: None,
                            socketio_exact: Some(&exact),
                            query: "",
                            kind: "TEXT",
                            format: "socketio_event",
                            direction,
                            pointer: "",
                        },
                    )
                    .unwrap()
            };
            let page = search("/admin", "string", "chat", None, "");
            assert_eq!(page["matched"], 231);
            assert_eq!(page["messages"].as_array().unwrap().len(), 100);
            assert_eq!(page["older"], true);
            let before = page["messages"][0]["id"].as_i64().unwrap();
            assert_eq!(
                search("/admin", "string", "chat", Some(before), "")["messages"]
                    .as_array()
                    .unwrap()
                    .len(),
                100
            );
            assert_eq!(
                search("/admin", "string", "chat", None, "sent")["matched"],
                115
            );
            assert_eq!(search("/", "string", "chat", None, "")["matched"], 2);
            for (kind, value) in [
                ("number", "17"),
                ("string", "17"),
                ("number", "1"),
                ("number", "1.0"),
            ] {
                assert_eq!(search("/admin", kind, value, None, "")["matched"], 1);
            }
            assert_eq!(search("/", "string", &long, None, "")["matched"], 2);
            let raw = search("/", "string", &long, None, "")["messages"][0]["text"]
                .as_str()
                .unwrap()
                .to_owned();
            assert_eq!(raw, long_packet);
        }
        let store = Store::open(&file).unwrap();
        assert_eq!(
            store.ws_socketio_events(1).unwrap().unwrap()["matched"],
            346
        );
        drop(store);
        std::fs::remove_file(file).unwrap();
    }
    #[test]
    fn socketio_event_search_scans_archive_before_paging_and_survives_restart() {
        use base64::{Engine, prelude::BASE64_STANDARD};
        let file =
            std::env::temp_dir().join(format!("librium-socketio-{}.sqlite3", uuid::Uuid::new_v4()));
        {
            let mut store = Store::open(&file).unwrap();
            store.save(&[saved(1)]).unwrap();
            store.ws_start(1).unwrap();
            let put = |text: &str, kind: &str, truncated: bool| {
                store
                    .ws_record(
                        1,
                        &crate::websocket::Message {
                            time: 1,
                            direction: "sent".into(),
                            kind: kind.into(),
                            text: if kind == "TEXT" {
                                text.into()
                            } else {
                                String::new()
                            },
                            base64: BASE64_STANDARD.encode(text),
                            size: text.len() + usize::from(truncated),
                            truncated,
                        },
                    )
                    .unwrap();
            };
            put(
                r#"42/admin,17["old-event",{"event":"new-event"}]"#,
                "TEXT",
                false,
            );
            for _ in 0..230 {
                put(r#"42["new-event",{}]"#, "TEXT", false);
            }
            for (text, kind, truncated) in [
                (r#"42["other",{"name":"new-event"}]"#, "TEXT", false),
                (r#"43["new-event"]"#, "TEXT", false),
                (r#"42["new-event"]"#, "BINARY", false),
                (r#"42["new-event"]"#, "TEXT", true),
                (r#"42["new-event",]"#, "TEXT", false),
                (
                    r#"451-/files,9["upload",{"_placeholder":true,"num":0}]"#,
                    "TEXT",
                    false,
                ),
            ] {
                put(text, kind, truncated);
            }
            let search = |before, query, kind, direction| {
                store
                    .ws_search_direction(1, before, query, kind, "socketio_event", direction)
                    .unwrap()
            };
            let page = search(None, "new-event", "DATA", "sent");
            assert_eq!(page["total"], 237);
            assert_eq!(page["matched"], 230);
            assert_eq!(page["messages"].as_array().unwrap().len(), 100);
            assert_eq!(page["older"], true);
            let before = page["messages"][0]["id"].as_i64().unwrap();
            let second = search(Some(before), "new-event", "DATA", "sent");
            assert_eq!(second["matched"], 230);
            assert_eq!(second["messages"].as_array().unwrap().len(), 100);
            assert_eq!(search(None, "old-event", "", "")["matched"], 1);
            assert_eq!(search(None, "upload", "", "")["matched"], 1);
            assert_eq!(search(None, "NEW-event", "", "")["matched"], 0);
            assert_eq!(search(None, "new-event", "BINARY", "")["matched"], 0);
            assert_eq!(search(None, "new-event", "", "received")["matched"], 0);
            assert_eq!(search(None, "", "", "")["matched"], 233);
        }
        let store = Store::open(&file).unwrap();
        let snapshot = store.read_snapshot().unwrap();
        assert_eq!(
            snapshot
                .ws_search_direction(1, None, "old-event", "", "socketio_event", "")
                .unwrap()["matched"],
            1
        );
        drop(snapshot);
        drop(store);
        std::fs::remove_file(file).unwrap();
    }
    #[test]
    fn websocket_roles_filter_archived_rows_without_guessing_legacy_metadata() {
        use crate::capture::{Source, WsRole};
        let file =
            std::env::temp_dir().join(format!("librium-ws-roles-{}.sqlite3", uuid::Uuid::new_v4()));
        {
            let mut store = Store::open(&file).unwrap();
            let rows: Vec<_> = (1..=925)
                .map(|id| {
                    let mut row = saved(id);
                    if id <= 600 {
                        row.summary.status = Some(101);
                        row.summary.source = Source::CdpNode;
                        row.summary.ws_role = Some(if id <= 300 {
                            WsRole::Client
                        } else {
                            WsRole::Server
                        });
                    } else if (901..=921).contains(&id) {
                        row.summary.status = Some(if id == 921 { 403 } else { 101 });
                        row.summary.source = Source::External;
                        row.request.headers = vec![
                            ("upgrade".into(), "websocket".into()),
                            ("x-librium-ws-role".into(), "server".into()),
                        ];
                    } else if id == 922 || id == 923 {
                        row.summary.source = Source::CdpNode;
                        row.summary.ws_role = Some(WsRole::Client);
                        row.summary.status = if id == 922 { None } else { Some(403) };
                        row.summary.url = "wss://example.test/pending".into();
                    }
                    if id == 925 {
                        row.summary.url = "wss://example.test/unconfirmed".into();
                        row.summary.status = None;
                    }
                    row
                })
                .collect();
            store.save(&rows).unwrap();
            store.ws_start(1).unwrap();
            store.ws_end(1, None).unwrap();
            for (role, count) in [("client", 302), ("server", 300), ("unknown", 22)] {
                let search = Search {
                    ws_role: role.into(),
                    limit: 100,
                    ..Search::default()
                };
                let first = store.search(&search).unwrap();
                assert_eq!(first.total, 925);
                assert_eq!(first.matched, count);
                let mut ids = std::collections::HashSet::new();
                for offset in (0..count).step_by(100) {
                    let page = store
                        .search(&Search {
                            offset: offset as usize,
                            ..Search {
                                ws_role: role.into(),
                                limit: 100,
                                ..Search::default()
                            }
                        })
                        .unwrap();
                    for row in page.rows {
                        assert!(ids.insert(row.id));
                    }
                }
                assert_eq!(ids.len(), count as usize);
            }
            assert_eq!(
                store
                    .search(&Search {
                        ws_role: "server".into(),
                        before: Some(450),
                        ..Search::default()
                    })
                    .unwrap()
                    .matched,
                150
            );
            assert_eq!(
                store
                    .search(&Search {
                        ws_role: "server".into(),
                        source: Some(Source::Proxy),
                        ..Search::default()
                    })
                    .unwrap()
                    .matched,
                0
            );
            assert_eq!(
                store
                    .search(&Search {
                        ws_role: "server".into(),
                        traffic_type: "http".into(),
                        ..Search::default()
                    })
                    .unwrap()
                    .matched,
                0
            );
            assert_eq!(
                store
                    .search(&Search {
                        ws_role: "client".into(),
                        status: "pending".into(),
                        ..Search::default()
                    })
                    .unwrap()
                    .matched,
                1
            );
            assert_eq!(
                store
                    .search(&Search {
                        ws_role: "client".into(),
                        status: "4".into(),
                        ..Search::default()
                    })
                    .unwrap()
                    .matched,
                1
            );
            assert_eq!(
                store
                    .search(&Search {
                        ws_role: "unknown".into(),
                        status: "4".into(),
                        ..Search::default()
                    })
                    .unwrap()
                    .matched,
                1
            );
            assert!(
                store
                    .search(&Search {
                        ws_role: "invalid".into(),
                        ..Search::default()
                    })
                    .is_err()
            );
            store
                .0
                .execute_batch(
                    "DROP INDEX traffic_ws_role; UPDATE traffic SET kind='http' WHERE id=925;",
                )
                .unwrap();
        }
        {
            let store = Store::open(&file).unwrap();
            assert_eq!(
                store.detail(1).unwrap().unwrap().summary.ws_role,
                Some(WsRole::Client)
            );
            assert_eq!(
                store.detail(301).unwrap().unwrap().summary.ws_role,
                Some(WsRole::Server)
            );
            assert_eq!(store.detail(901).unwrap().unwrap().summary.ws_role, None);
            assert_eq!(
                store.ws_summary(1).unwrap().unwrap()["summary"]["ws_role"],
                "client"
            );
            assert_eq!(
                store.ws_export_page(1, 0, None).unwrap().unwrap()["session"]["exchange"]["summary"]
                    ["ws_role"],
                "client"
            );
            assert_eq!(
                store
                    .search(&Search {
                        ws_role: "unknown".into(),
                        ..Search::default()
                    })
                    .unwrap()
                    .matched,
                22
            );
            assert_eq!(
                store
                    .search(&Search {
                        ws_role: "server".into(),
                        ..Search::default()
                    })
                    .unwrap()
                    .matched,
                300
            );
        }
        std::fs::remove_file(file).unwrap();
    }
    #[test]
    fn byte_search_finds_archived_raw_text_and_partial_prefixes_with_offsets() {
        use base64::{Engine, prelude::BASE64_STANDARD};
        let store = Store::open(std::path::Path::new(":memory:")).unwrap();
        store.ws_start(1).unwrap();
        let original = [vec![9; 15], vec![0, 255, 42]].concat();
        let mut message = crate::websocket::Message {
            time: 0,
            direction: "sent".into(),
            kind: "BINARY".into(),
            text: String::new(),
            base64: BASE64_STANDARD.encode(&original),
            size: 18,
            truncated: false,
        };
        store.ws_record(1, &message).unwrap();
        message.kind = "TEXT".into();
        message.text = "different display text".into();
        message.direction = "received".into();
        message.base64 = "AP8q".into();
        message.size = 3;
        store.ws_record(1, &message).unwrap();
        for _ in 0..130 {
            message.kind = "BINARY".into();
            message.direction = "sent".into();
            message.base64 = "AQI=".into();
            message.size = 2;
            store.ws_record(1, &message).unwrap();
        }
        message.base64 = "AP8q".into();
        message.size = 99;
        message.truncated = true;
        store.ws_record(1, &message).unwrap();
        let page = store
            .ws_search_format(1, None, "00 Ff 2A", "", "hex")
            .unwrap();
        assert_eq!(page["total"], 133);
        assert_eq!(page["matched"], 3);
        assert_eq!(page["messages"][0]["id"], 1);
        assert_eq!(page["messages"][0]["match_offset"], 15);
        assert_eq!(page["messages"][2]["match_offset"], 0);
        assert_eq!(page["messages"][2]["truncated"], true);
        let text = store
            .ws_search_direction(1, None, "00ff2a", "TEXT", "hex", "received")
            .unwrap();
        assert_eq!(text["matched"], 1);
        assert_eq!(text["messages"][0]["id"], 2);
        assert_eq!(
            store
                .ws_search_format(1, None, "ff 2a 01", "", "hex")
                .unwrap()["matched"],
            0
        );
        assert_eq!(
            store.ws_search_format(1, None, " \t", "", "hex").unwrap()["matched"],
            133
        );
        assert!(store.ws_search_format(1, None, "f", "", "hex").is_err());
        assert!(store.ws_page(1, Some(3)).unwrap()["messages"][0]["match_offset"].is_null());
        assert_eq!(
            page["messages"][0]["base64"],
            BASE64_STANDARD.encode(original)
        );
    }
    #[test]
    fn masked_byte_search_scans_archive_scopes_filters_and_never_guesses_missing_bytes() {
        use base64::{Engine, prelude::BASE64_STANDARD};
        let dir = std::env::temp_dir().join(format!("librium-mask-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("history.sqlite3");
        let mut store = Store::open(&path).unwrap();
        let mut row = saved(1);
        row.summary.status = Some(101);
        store.save(&[row]).unwrap();
        store.ws_start(1).unwrap();
        let mut message = crate::websocket::Message {
            time: 0,
            direction: "sent".into(),
            kind: "BINARY".into(),
            text: String::new(),
            base64: BASE64_STANDARD.encode([vec![9; 15], vec![0, 255, 42]].concat()),
            size: 18,
            truncated: false,
        };
        store.ws_record(1, &message).unwrap();
        let first_id = store.0.last_insert_rowid();
        message.kind = "TEXT".into();
        message.direction = "received".into();
        message.text = "not the source bytes".into();
        message.base64 = "AKoq".into();
        message.size = 3;
        store.ws_record(1, &message).unwrap();
        for _ in 0..130 {
            message.kind = "BINARY".into();
            message.direction = "sent".into();
            message.base64 = "AQI=".into();
            message.size = 2;
            store.ws_record(1, &message).unwrap();
        }
        message.base64 = "ALsq".into();
        message.size = 99;
        message.truncated = true;
        store.ws_record(1, &message).unwrap();
        let reader = store.read_snapshot().unwrap();
        let page = reader
            .ws_search_format(1, None, "00 ?? 2a", "", "hex_mask")
            .unwrap();
        assert_eq!(page["total"], 133);
        assert_eq!(page["matched"], 3);
        let rows = page["messages"].as_array().unwrap();
        assert_eq!(rows[0]["id"], first_id);
        assert_eq!(rows[0]["match_offset"], 15);
        assert!(rows.iter().all(|row| row["match_length"] == 3));
        let anchored = reader
            .ws_search_format(1, None, "@0x0f:00 ?? 2a", "", "hex_mask")
            .unwrap();
        assert_eq!(anchored["matched"], 1);
        assert_eq!(anchored["messages"][0]["id"], first_id);
        assert_eq!(anchored["messages"][0]["match_offset"], 15);
        assert_eq!(anchored["messages"][0]["match_length"], 3);
        assert_eq!(
            reader
                .ws_search_format(1, None, "@0:00 ?? 2a", "", "hex_mask")
                .unwrap()["matched"],
            2
        );
        assert_eq!(
            reader
                .ws_search_format(1, None, "@1:00 ?? 2a", "", "hex_mask")
                .unwrap()["matched"],
            0
        );
        assert_eq!(
            reader
                .ws_search_format(1, None, "@3:??", "", "hex_mask")
                .unwrap()["matched"],
            1
        );

        assert_eq!(
            reader
                .ws_search_direction(1, None, "00 ?? 2a", "TEXT", "hex_mask", "received")
                .unwrap()["matched"],
            1
        );
        assert_eq!(
            reader
                .ws_search_format(1, Some(first_id + 1), "00 ?? 2a", "", "hex_mask")
                .unwrap()["messages"][0]["id"],
            first_id
        );
        assert_eq!(
            reader
                .ws_search_format(1, None, "00 ?? 2a ??", "", "hex_mask")
                .unwrap()["matched"],
            0
        );
        assert_eq!(
            reader
                .ws_search_format(1, None, "?? ?? ??", "", "hex_mask")
                .unwrap()["matched"],
            3
        );
        assert_eq!(
            reader
                .ws_search_format(1, None, " ", "", "hex_mask")
                .unwrap()["matched"],
            133
        );
        assert!(
            reader
                .ws_search_format(1, None, "0?", "", "hex_mask")
                .is_err()
        );
        message.base64 = "AMwq".into();
        store.ws_record(1, &message).unwrap();
        assert_eq!(
            reader
                .ws_search_format(1, None, "00 ?? 2a", "", "hex_mask")
                .unwrap()["matched"],
            3
        );
        drop(reader);
        let fresh = store
            .ws_search_format(1, None, "00 ?? 2a", "", "hex_mask")
            .unwrap();
        assert_eq!(fresh["matched"], 4);
        assert!(store.ws_message(1, first_id).unwrap().unwrap()["match_offset"].is_null());
        drop(store);
        let reopened = Store::open(&path).unwrap();
        assert_eq!(
            reopened
                .ws_search_format(1, None, "00 ?? 2a", "", "hex_mask")
                .unwrap()["messages"],
            fresh["messages"]
        );
        drop(reopened);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn ws_message_lookup_is_scoped_and_survives_restart_until_clear() {
        let dir = std::env::temp_dir().join(format!("librium-ws-message-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("history.sqlite3");
        {
            let mut store = Store::open(&path).unwrap();
            let mut row = saved(1);
            row.summary.status = Some(101);
            store.save(&[row]).unwrap();
            store.ws_start(1).unwrap();
            let message = crate::websocket::Message {
                time: 0,
                direction: "received".into(),
                kind: "BINARY".into(),
                text: String::new(),
                base64: "AP8=".into(),
                size: 9,
                truncated: true,
            };
            store.ws_record(1, &message).unwrap();
        }
        {
            let mut store = Store::open(&path).unwrap();
            let message = store.ws_message(1, 1).unwrap().unwrap();
            assert_eq!(message["base64"], "AP8=");
            assert_eq!(message["truncated"], true);
            assert_eq!(message["id"], 1);
            assert!(store.ws_message(2, 1).unwrap().is_none());
            assert!(store.ws_message(1, 2).unwrap().is_none());
            store.clear().unwrap();
            assert!(store.ws_message(1, 1).unwrap().is_none());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn ws_summary_intervals_use_capture_order_partitioned_types_and_one_snapshot() {
        let dir = std::env::temp_dir().join(format!("librium-ws-timing-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("history.sqlite3");
        let mut store = Store::open(&path).unwrap();
        for id in [1, 2] {
            let mut row = saved(id);
            row.summary.status = Some(101);
            store.save(&[row]).unwrap();
            store.ws_start(id).unwrap();
        }
        let mut message = crate::websocket::Message {
            time: 0,
            direction: "sent".into(),
            kind: "TEXT".into(),
            text: "a".into(),
            base64: "YQ==".into(),
            size: 1000,
            truncated: true,
        };
        let mut first_ids = Vec::new();
        for n in 0..130 {
            for (direction, kind, time) in [
                ("sent", "TEXT", 1000 + n * 10),
                ("received", "TEXT", 5000 + n * 20),
                ("sent", "PING", 50000 + n * 30),
            ] {
                message.direction = direction.into();
                message.kind = kind.into();
                message.truncated = direction == "sent" && kind == "TEXT";
                message.size = if message.truncated { 1000 } else { 1 };
                message.time = time;
                store.ws_record(1, &message).unwrap();
                if n < 2 {
                    first_ids.push(store.0.last_insert_rowid());
                }
            }
        }
        message.direction = "sent".into();
        message.kind = "TEXT".into();
        message.time = 100;
        store.ws_record(1, &message).unwrap();
        store.ws_record(1, &message).unwrap();
        let before_fresh = store.0.last_insert_rowid();
        message.time = 9_007_199_254_740_992;
        store.ws_record(2, &message).unwrap();
        message.time += 1;
        store.ws_record(2, &message).unwrap();
        let timing = |data: &serde_json::Value, direction: &str, kind: &str| {
            data["kinds"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["direction"] == direction && row["kind"] == kind)
                .unwrap()["intervals"]
                .clone()
        };
        assert_eq!(
            timing(&store.ws_summary(2).unwrap().unwrap(), "sent", "TEXT")["min_ms"],
            1.0
        );
        let reader = store.read_snapshot().unwrap();
        let old = reader.ws_summary(1).unwrap().unwrap();
        let sent = timing(&old, "sent", "TEXT");
        assert_eq!(
            sent["longest"],
            serde_json::json!({"before":first_ids[0],"after":first_ids[3]})
        );
        assert_eq!(sent["count"], 130);
        assert_eq!(sent["backwards"], 1);
        assert_eq!(sent["zero"], 1);
        assert_eq!(sent["min_ms"], 0.0);
        assert_eq!(sent["max_ms"], 10.0);
        assert!((sent["mean_ms"].as_f64().unwrap() - 1290.0 / 130.0).abs() < 1e-10);
        for (direction, kind, interval, index) in
            [("received", "TEXT", 20.0, 1), ("sent", "PING", 30.0, 2)]
        {
            assert_eq!(
                timing(&old, direction, kind),
                serde_json::json!({"count":129,"backwards":0,"zero":0,"min_ms":interval,"mean_ms":interval,"max_ms":interval,"longest":{"before":first_ids[index],"after":first_ids[index+3]}})
            );
        }
        message.time = 130;
        store.ws_record(1, &message).unwrap();
        let after_fresh = store.0.last_insert_rowid();
        store.ws_end(1, None).unwrap();
        assert_eq!(
            reader.ws_summary(1).unwrap().unwrap()["kinds"],
            old["kinds"]
        );
        assert_eq!(reader.ws_summary(1).unwrap().unwrap()["state"], "open");
        drop(reader);
        let fresh = store.ws_summary(1).unwrap().unwrap();
        assert_eq!(fresh["state"], "closed");
        assert_eq!(
            timing(&fresh, "sent", "TEXT")["longest"],
            serde_json::json!({"before":before_fresh,"after":after_fresh})
        );
        assert_eq!(timing(&fresh, "sent", "TEXT")["max_ms"], 30.0);
        assert_eq!(timing(&fresh, "sent", "TEXT")["count"], 131);
        let mut row = saved(3);
        row.summary.status = Some(101);
        store.save(&[row]).unwrap();
        store.ws_start(3).unwrap();
        for time in [30, 20, 10] {
            message.time = time;
            store.ws_record(3, &message).unwrap();
        }
        let backwards = timing(&store.ws_summary(3).unwrap().unwrap(), "sent", "TEXT");
        assert_eq!(backwards["count"], 0);
        assert_eq!(backwards["backwards"], 2);
        assert!(backwards["max_ms"].is_null());
        assert!(backwards["longest"].is_null());
        let zero_before = store.0.last_insert_rowid();
        store.ws_record(3, &message).unwrap();
        let zero_after = store.0.last_insert_rowid();
        let zero = timing(&store.ws_summary(3).unwrap().unwrap(), "sent", "TEXT");
        assert_eq!(zero["count"], 1);
        assert_eq!(zero["max_ms"], 0.0);
        assert_eq!(
            zero["longest"],
            serde_json::json!({"before":zero_before,"after":zero_after})
        );
        drop(store);
        let reopened = Store::open(&path).unwrap();
        assert_eq!(
            reopened.ws_summary(1).unwrap().unwrap()["kinds"],
            fresh["kinds"]
        );
        drop(reopened);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn ws_summary_counts_all_archived_messages_and_actual_preview_bytes() {
        use base64::{Engine, prelude::BASE64_STANDARD};
        let dir = std::env::temp_dir().join(format!("librium-ws-summary-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("history.sqlite3");
        {
            let mut store = Store::open(&path).unwrap();
            let mut row = saved(1);
            row.summary.status = Some(101);
            store.save(&[row]).unwrap();
            store.ws_start(1).unwrap();
            let mut message = crate::websocket::Message {
                time: 9000,
                direction: "sent".into(),
                kind: "TEXT".into(),
                text: "a".into(),
                base64: "YQ==".into(),
                size: 1,
                truncated: false,
            };
            store.ws_record(1, &message).unwrap();
            message.direction = "received".into();
            message.kind = "BINARY".into();
            message.base64 = BASE64_STANDARD.encode([0, 1]);
            message.size = 9;
            message.truncated = true;
            message.time = 3;
            store.ws_record(1, &message).unwrap();
            message.direction = "sent".into();
            message.kind = "CLOSE".into();
            message.base64.clear();
            message.size = 0;
            message.truncated = false;
            message.time = 0;
            store.ws_record(1, &message).unwrap();
            for n in 0..130 {
                message.kind = "TEXT".into();
                message.base64 = "YWJj".into();
                message.size = 3;
                message.time = 1000 + n;
                store.ws_record(1, &message).unwrap();
            }
        }
        {
            let mut store = Store::open(&path).unwrap();
            let data = store.ws_summary(1).unwrap().unwrap();
            assert_eq!(data["total"]["count"], 133);
            assert_eq!(data["sent"]["count"], 132);
            assert_eq!(data["received"]["count"], 1);
            assert_eq!(data["total"]["bytes"].as_f64(), Some(400.0));
            assert_eq!(data["total"]["stored_bytes"].as_f64(), Some(393.0));
            assert_eq!(data["total"]["truncated"], 1);
            assert_eq!(data["first_time"].as_f64(), Some(0.0));
            assert_eq!(data["last_time"].as_f64(), Some(9000.0));
            assert_eq!(data["kinds"].as_array().unwrap().len(), 3);
            assert!(store.ws_summary(999).unwrap().is_none());
            let row = saved(2);
            store.save(&[row]).unwrap();
            assert!(store.ws_summary(2).unwrap().is_none());
            store.ws_start(2).unwrap();
            let empty = store.ws_summary(2).unwrap().unwrap();
            assert_eq!(empty["total"]["count"], 0);
            assert!(empty["first_time"].is_null());
            let message = crate::websocket::Message {
                time: 0,
                direction: "sent".into(),
                kind: "BINARY".into(),
                text: String::new(),
                base64: "AA==".into(),
                size: usize::MAX,
                truncated: true,
            };
            for _ in 0..2 {
                store.ws_record(2, &message).unwrap();
            }
            assert!(
                store.ws_summary(2).unwrap().unwrap()["total"]["bytes"]
                    .as_f64()
                    .unwrap()
                    .is_finite()
            );
            store.clear().unwrap();
            assert!(store.ws_summary(1).unwrap().is_none());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn legacy_ws_close_metadata_migrates_without_changing_messages() {
        let dir =
            std::env::temp_dir().join(format!("librium-close-migrate-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("history.sqlite3");
        {
            let db = Connection::open(&path).unwrap();
            db.execute_batch("CREATE TABLE ws_sessions (exchange_id INTEGER PRIMARY KEY,state TEXT NOT NULL,error TEXT); INSERT INTO ws_sessions VALUES (1,'closed','old error');").unwrap();
        }
        {
            let store = Store::open(&path).unwrap();
            let page = store.ws_page(1, None).unwrap();
            assert_eq!(page["error"], "old error");
            assert!(page["close"].is_null());
            store
                .ws_end_with_close(
                    1,
                    None,
                    Some(&crate::websocket::CloseInfo {
                        code: 4000,
                        reason: "Пример".into(),
                        direction: None,
                    }),
                )
                .unwrap();
        }
        {
            let store = Store::open(&path).unwrap();
            assert_eq!(
                store.ws_page(1, None).unwrap()["close"],
                serde_json::json!({"code":4000,"reason":"Пример"})
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn ws_kind_groups_filter_whole_history_before_cursor_and_search() {
        use base64::{Engine, prelude::BASE64_STANDARD};
        let store = Store::open(std::path::Path::new(":memory:")).unwrap();
        store.ws_start(1).unwrap();
        for n in 0..121 {
            for kind in ["TEXT", "BINARY", "PING", "PONG", "CLOSE", "CONTINUATION"] {
                let text = format!("sample-{n}");
                store
                    .ws_record(
                        1,
                        &crate::websocket::Message {
                            time: n,
                            direction: if n % 2 == 0 { "sent" } else { "received" }.into(),
                            kind: kind.into(),
                            text: if kind == "BINARY" {
                                String::new()
                            } else {
                                text.clone()
                            },
                            base64: BASE64_STANDARD.encode(&text),
                            size: text.len(),
                            truncated: false,
                        },
                    )
                    .unwrap();
            }
        }
        for (group, kinds, count, sent) in [
            ("DATA", vec!["TEXT", "BINARY"], 242, 122),
            ("CONTROL", vec!["PING", "PONG", "CLOSE"], 363, 183),
        ] {
            let mut before = None;
            let mut ids = std::collections::HashSet::new();
            loop {
                let page = store.ws_search(1, before, "", group).unwrap();
                assert_eq!(page["total"], 726);
                assert_eq!(page["matched"], count);
                let rows = page["messages"].as_array().unwrap();
                assert!(!rows.is_empty());
                assert!(rows.len() <= 100);
                for row in rows {
                    assert!(kinds.contains(&row["kind"].as_str().unwrap()));
                    assert!(
                        ids.insert(row["id"].as_i64().unwrap()),
                        "cursor must not repeat a message"
                    );
                }
                if !page["older"].as_bool().unwrap() {
                    break;
                }
                before = rows[0]["id"].as_i64();
            }
            assert_eq!(ids.len(), count as usize);
            assert_eq!(
                store
                    .ws_search_direction(1, None, "", group, "text", "sent")
                    .unwrap()["matched"],
                sent
            );
            let found = store
                .ws_search_direction(1, None, "sample-0", group, "utf8", "sent")
                .unwrap();
            assert_eq!(found["matched"], kinds.len());
            assert_eq!(
                store
                    .ws_search_direction(1, None, "sample-0", group, "utf8", "received")
                    .unwrap()["matched"],
                0
            );
            let hex = store
                .ws_search_direction(1, None, "73616d706c652d30", group, "hex", "")
                .unwrap();
            assert_eq!(hex["matched"], kinds.len());
            assert!(
                hex["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|row| row["match_offset"] == 0)
            );
        }
        assert_eq!(
            store.ws_search(1, None, "", "CONTINUATION").unwrap()["matched"],
            121
        );
        assert_eq!(
            store.ws_search(1, None, "", "PING").unwrap()["matched"],
            121
        );
        assert!(store.ws_search(1, None, "", "CONTROL' OR 1=1").is_err());
    }
    #[test]
    fn ws_direction_filter_pages_before_splitting_panels() {
        use base64::{Engine, prelude::BASE64_STANDARD};
        let store = Store::open(std::path::Path::new(":memory:")).unwrap();
        store.ws_start(1).unwrap();
        let mut message = crate::websocket::Message {
            time: 0,
            direction: "sent".into(),
            kind: "TEXT".into(),
            text: String::new(),
            base64: String::new(),
            size: 0,
            truncated: false,
        };
        for n in 0..121 {
            message.text = format!("sent-{n}");
            message.base64 = BASE64_STANDARD.encode(&message.text);
            message.size = message.text.len();
            store.ws_record(1, &message).unwrap();
        }
        message.kind = "BINARY".into();
        message.text.clear();
        message.base64 = BASE64_STANDARD.encode([
            0x81, 0xa5, b'e', b'v', b'e', b'n', b't', 0xa4, b'p', b'i', b'n', b'g',
        ]);
        message.size = 12;
        store.ws_record(1, &message).unwrap();
        message.kind = "TEXT".into();
        message.direction = "received".into();
        for n in 0..230 {
            message.text = format!("received-{n}");
            message.base64 = BASE64_STANDARD.encode(&message.text);
            message.size = message.text.len();
            store.ws_record(1, &message).unwrap();
        }
        let all = store.ws_page(1, None).unwrap();
        assert!(
            all["messages"]
                .as_array()
                .unwrap()
                .iter()
                .all(|row| row["direction"] == "received")
        );
        let sent = store
            .ws_search_direction(1, None, "", "", "text", "sent")
            .unwrap();
        assert_eq!(sent["total"], 352);
        assert_eq!(sent["matched"], 122);
        assert_eq!(sent["messages"].as_array().unwrap().len(), 100);
        assert_eq!(sent["older"], true);
        let before = sent["messages"][0]["id"].as_i64().unwrap();
        let older = store
            .ws_search_direction(1, Some(before), "", "", "text", "sent")
            .unwrap();
        assert_eq!(older["messages"].as_array().unwrap().len(), 22);
        assert_eq!(older["older"], false);
        assert_eq!(older["messages"][0]["text"], "sent-0");
        for (direction, count) in [("sent", 1), ("received", 0)] {
            assert_eq!(
                store
                    .ws_search_direction(1, None, "event", "BINARY", "msgpack", direction)
                    .unwrap()["matched"],
                count
            );
        }
        assert_eq!(
            store
                .ws_search_direction(1, None, "sent-0", "TEXT", "utf8", "received")
                .unwrap()["matched"],
            0
        );
        assert!(
            store
                .ws_search_direction(1, None, "", "", "text", "invalid")
                .is_err()
        );
    }
    #[test]
    fn utf8_search_reads_old_binary_pages_and_casefolds_cyrillic() {
        use base64::{Engine, prelude::BASE64_STANDARD};
        let root = std::env::temp_dir();
        let dir = root.join(format!("librium-utf8-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("history.sqlite3");
        {
            let store = Store::open(&file).unwrap();
            store.ws_start(1).unwrap();
            let mut message = crate::websocket::Message {
                time: 0,
                direction: "sent".into(),
                kind: "TEXT".into(),
                text: "ПРИВЕТ TEXT старый".into(),
                base64: BASE64_STANDARD.encode("ПРИВЕТ TEXT старый"),
                size: "ПРИВЕТ TEXT старый".len(),
                truncated: false,
            };
            store.ws_record(1, &message).unwrap();
            message.kind = "BINARY".into();
            message.text.clear();
            message.base64 = BASE64_STANDARD.encode(r#"{"event":"Привет UTF8 old-history"}"#);
            message.size = BASE64_STANDARD.decode(&message.base64).unwrap().len();
            store.ws_record(1, &message).unwrap();
            for (prefix, truncated, tail) in [
                ("prefix needle-boundary ", true, vec![0xf0, 0x9f]),
                ("prefix incomplete ", false, vec![0xf0, 0x9f]),
                ("prefix broken ", true, vec![0xff]),
            ] {
                let mut bytes = prefix.as_bytes().to_vec();
                bytes.extend(tail);
                message.base64 = BASE64_STANDARD.encode(&bytes);
                message.size = bytes.len() + usize::from(truncated);
                message.truncated = truncated;
                store.ws_record(1, &message).unwrap();
            }
            message.kind = "TEXT".into();
            message.text = "filler".into();
            message.base64 = BASE64_STANDARD.encode("filler");
            message.size = "filler".len();
            message.truncated = false;
            for _ in 0..130 {
                store.ws_record(1, &message).unwrap();
            }
        }
        let store = Store::open(&file).unwrap();
        let text = store.ws_search(1, None, "привет text", "TEXT").unwrap();
        assert_eq!(text["matched"], 1);
        assert_eq!(
            store
                .ws_search_format(1, None, "привет utf8", "BINARY", "text")
                .unwrap()["matched"],
            0
        );
        let binary = store
            .ws_search_format(1, None, "ПРИВЕТ utf8", "BINARY", "utf8")
            .unwrap();
        assert_eq!(binary["total"], 135);
        assert_eq!(binary["matched"], 1);
        assert_eq!(binary["messages"][0]["id"], 2);
        let partial = store
            .ws_search_format(1, None, "prefix", "BINARY", "utf8")
            .unwrap();
        assert_eq!(partial["matched"], 1);
        assert_eq!(partial["messages"][0]["truncated"], true);
        assert!(partial["messages"][0]["text"].as_str().unwrap().is_empty());
        assert_eq!(
            store
                .ws_search_format(1, None, "привет", "", "utf8")
                .unwrap()["matched"],
            2
        );
        drop(store);
        assert_eq!(dir.parent(), Some(root.as_path()));
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn ws_export_pages_keep_snapshot_boundaries_and_raw_payloads() {
        use base64::{Engine, prelude::BASE64_STANDARD};
        let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let mut socket = saved(1);
        socket.summary.status = Some(101);
        store.save(&[socket]).unwrap();
        store.ws_start(1).unwrap();
        let mut message = crate::websocket::Message {
            time: 7,
            direction: "sent".into(),
            kind: "BINARY".into(),
            text: String::new(),
            base64: BASE64_STANDARD.encode([0, 255, 42]),
            size: 70000,
            truncated: true,
        };
        for n in 0..160 {
            message.time = n;
            store.ws_record(1, &message).unwrap();
        }
        let first = store.ws_export_page(1, 0, None).unwrap().unwrap();
        let through = first["through"].as_i64().unwrap();
        assert_eq!(first["session"]["total"], 160);
        assert_eq!(first["session"]["state"], "open");
        assert_eq!(first["session"]["exchange"]["summary"]["id"], 1);
        store.ws_record(1, &message).unwrap();
        store.ws_end(1, None).unwrap();
        let mut all = first["messages"].as_array().unwrap().clone();
        let mut next = first["next"].as_i64().unwrap();
        let mut more = first["more"].as_bool().unwrap();
        while more {
            let page = store
                .ws_export_page(1, next, Some(through))
                .unwrap()
                .unwrap();
            assert!(page["session"].is_null());
            assert_eq!(page["through"], through);
            all.extend(page["messages"].as_array().unwrap().clone());
            next = page["next"].as_i64().unwrap();
            more = page["more"].as_bool().unwrap();
        }
        assert_eq!(all.len(), 160);
        assert_eq!(all.last().unwrap()["id"], through);
        assert!(
            all.windows(2)
                .all(|pair| pair[0]["id"].as_i64() < pair[1]["id"].as_i64())
        );
        assert_eq!(all[0]["base64"], "AP8q");
        assert_eq!(all[0]["size"], 70000);
        assert_eq!(all[0]["truncated"], true);
        assert_eq!(
            store.ws_export_page(1, 0, None).unwrap().unwrap()["session"]["total"],
            161
        );
        let mut attempt = saved(2);
        attempt.summary.status = None;
        attempt
            .request
            .headers
            .push(("upgrade".into(), "websocket".into()));
        store.save(&[attempt, saved(3)]).unwrap();
        let empty = store.ws_export_page(2, 0, None).unwrap().unwrap();
        assert_eq!(empty["session"]["total"], 0);
        assert_eq!(empty["session"]["state"], "not_recorded");
        assert_eq!(empty["more"], false);
        assert!(store.ws_export_page(3, 0, None).unwrap().is_none());
        store.clear().unwrap();
        assert!(store.ws_export_page(1, 0, Some(through)).unwrap().is_none());
    }
    #[test]
    fn context_catalogue_counts_and_pages_one_archive_snapshot_by_latest_label() {
        let file = std::env::temp_dir().join(format!(
            "librium-context-catalogue-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        let mut store = Store::open(&file).unwrap();
        assert_eq!(
            store.capture_contexts(&ContextsQuery::default()).unwrap()["through"],
            0
        );
        let mut rows = (1..=353).map(saved).collect::<Vec<_>>();
        for (index, row) in rows[..350].iter_mut().enumerate() {
            row.summary.capture_context = Some(format!("context-{}", index + 1));
            row.summary.capture_target = Some("same".into());
        }
        rows[0].summary.time = u64::MAX;
        rows[350].summary.capture_context = Some("context-1".into());
        rows[350].summary.capture_target = Some("ПЕРЕИМЕНОВАН".into());
        rows[350].summary.source = crate::capture::Source::CdpNode;
        rows[350].summary.status = Some(101);
        rows[351].summary.capture_context = Some("context-2".into());
        rows[351].summary.capture_target = Some("other".into());
        store.save(&rows).unwrap();
        store.ws_start(351).unwrap();
        for _ in 0..3 {
            store
                .ws_record(
                    351,
                    &crate::websocket::Message {
                        time: 1,
                        direction: "sent".into(),
                        kind: "TEXT".into(),
                        text: "one".into(),
                        base64: "b25l".into(),
                        size: 3,
                        truncated: false,
                    },
                )
                .unwrap();
        }
        let reader = store.read_snapshot().unwrap();
        let first = reader.capture_contexts(&ContextsQuery::default()).unwrap();
        assert_eq!(first["total"], 350);
        assert_eq!(first["matched"], 350);
        assert_eq!(first["without_context"], 1);
        assert_eq!(first["through"], 353);
        assert_eq!(first["contexts"].as_array().unwrap().len(), 100);
        assert_eq!(first["older"], true);
        let named = reader
            .capture_contexts(&ContextsQuery {
                search: "переимен".into(),
                ..ContextsQuery::default()
            })
            .unwrap();
        let item = &named["contexts"][0];
        assert_eq!(named["matched"], 1);
        assert_eq!(item["id"], "context-1");
        assert_eq!(item["http"], 1);
        assert_eq!(item["ws"], 1);
        assert_eq!(item["total"], 2);
        assert_eq!(item["source"], "cdp_node");
        assert_eq!(item["first_time"].as_u64(), Some(u64::MAX));
        assert_eq!(item["first_id"], 1);
        assert_eq!(item["last_id"], 351);
        let mut extra = saved(354);
        extra.summary.capture_context = Some("new-context".into());
        store.save(&[extra]).unwrap();
        let mut extra = saved(355);
        extra.summary.capture_context = Some("context-3".into());
        extra.summary.capture_target = Some("renamed later".into());
        store.save(&[extra]).unwrap();
        assert_eq!(
            reader.capture_contexts(&ContextsQuery::default()).unwrap()["total"],
            350
        );
        let mut seen = std::collections::HashSet::new();
        let mut before = None;
        loop {
            let result = store
                .read_snapshot()
                .unwrap()
                .capture_contexts(&ContextsQuery {
                    before,
                    through: Some(353),
                    ..ContextsQuery::default()
                })
                .unwrap();
            for row in result["contexts"].as_array().unwrap() {
                assert!(seen.insert(row["id"].as_str().unwrap().to_owned()));
                if row["id"] == "context-3" {
                    assert_eq!(row["label"], "same");
                }
            }
            if result["older"] == false {
                break;
            }
            before = result["next_before"].as_u64();
        }
        assert_eq!(seen.len(), 350);
        assert!(!seen.contains("new-context"));
        assert_eq!(
            store.capture_contexts(&ContextsQuery::default()).unwrap()["total"],
            351
        );
        for invalid in [
            ContextsQuery {
                search: "x".repeat(257),
                ..ContextsQuery::default()
            },
            ContextsQuery {
                through: Some(u64::MAX),
                ..ContextsQuery::default()
            },
            ContextsQuery {
                before: Some(u64::MAX),
                ..ContextsQuery::default()
            },
        ] {
            assert!(store.capture_contexts(&invalid).is_err());
        }
        drop(reader);
        drop(store);
        let store = Store::open(&file).unwrap();
        assert_eq!(
            store.capture_contexts(&ContextsQuery::default()).unwrap()["total"],
            351
        );
        drop(store);
        std::fs::remove_file(file).unwrap();
    }
    #[test]
    fn capture_context_is_indexed_exact_and_independent_of_titles_after_restart() {
        let file =
            std::env::temp_dir().join(format!("librium-context-{}.sqlite3", uuid::Uuid::new_v4()));
        {
            let mut store = Store::open(&file).unwrap();
            let mut rows = (1..=620).map(saved).collect::<Vec<_>>();
            for (index, context, title) in [
                (0, "Scope/A", "same"),
                (599, "Scope/A", "renamed"),
                (600, "Scope/B", "same"),
                (1, "Scope/a", "same"),
            ] {
                rows[index].summary.capture_target = Some(title.into());
                rows[index].summary.capture_context = Some(context.into());
            }
            rows[2]
                .request
                .headers
                .push(("x-librium-context".into(), "Scope/A".into()));
            store.save(&rows).unwrap();
        }
        let store = Store::open(&file).unwrap();
        let query = || Search {
            capture_context: Some("Scope/A".into()),
            ..Search::default()
        };
        let result = store.search(&query()).unwrap();
        assert_eq!(result.total, 620);
        assert_eq!(
            result.rows.iter().map(|row| row.id).collect::<Vec<_>>(),
            [600, 1]
        );
        assert_eq!(
            store
                .search(&Search {
                    limit: 1,
                    offset: 1,
                    ..query()
                })
                .unwrap()
                .rows[0]
                .id,
            1
        );
        assert_eq!(
            store
                .search(&Search {
                    before: Some(500),
                    ..query()
                })
                .unwrap()
                .matched,
            1
        );
        assert_eq!(
            store
                .search(&Search {
                    rules: vec![Rule {
                        field: "capture_target".into(),
                        op: "eq".into(),
                        value: "same".into()
                    }],
                    ..query()
                })
                .unwrap()
                .rows[0]
                .id,
            1
        );
        assert_eq!(
            store
                .search(&Search {
                    capture_context: Some("Scope/a".into()),
                    ..Search::default()
                })
                .unwrap()
                .rows[0]
                .id,
            2
        );
        assert!(
            store
                .detail(3)
                .unwrap()
                .unwrap()
                .summary
                .capture_context
                .is_none()
        );
        assert_eq!(
            store
                .detail(600)
                .unwrap()
                .unwrap()
                .summary
                .capture_context
                .as_deref(),
            Some("Scope/A")
        );
        assert_eq!(
            store
                .read_snapshot()
                .unwrap()
                .search(&query())
                .unwrap()
                .matched,
            2
        );
        for invalid in ["", "bad id", "кириллица", &"x".repeat(129)] {
            assert!(
                store
                    .search(&Search {
                        capture_context: Some(invalid.into()),
                        ..Search::default()
                    })
                    .is_err()
            );
        }
        let plan:String=store.0.query_row("EXPLAIN QUERY PLAN SELECT id FROM traffic WHERE json_extract(summary,'$.capture_context')=? ORDER BY id",["Scope/A"],|row| row.get(3)).unwrap();
        assert!(plan.contains("traffic_context"), "{plan}");
        drop(store);
        std::fs::remove_file(file).unwrap();
    }
    #[test]
    fn capture_target_filters_full_archive_and_preserves_unicode_metadata_after_restart() {
        use crate::capture::Source;
        let file =
            std::env::temp_dir().join(format!("librium-target-{}.sqlite3", uuid::Uuid::new_v4()));
        let label = "Node worker 7 · ПОТОК <img>";
        {
            // A nonempty archive from before the derived target column existed.
            let db = Connection::open(&file).unwrap();
            db.execute_batch("CREATE TABLE traffic (id INTEGER PRIMARY KEY,method TEXT NOT NULL,url TEXT NOT NULL,host TEXT NOT NULL,path TEXT NOT NULL,status INTEGER,size INTEGER NOT NULL,search TEXT NOT NULL,summary TEXT NOT NULL,detail TEXT NOT NULL);").unwrap();
            let mut row = saved(1);
            row.summary.capture_target = Some(label.into());
            db.execute("INSERT INTO traffic VALUES (1,'get','https://example.test','example.test','/',200,0,'',?,?)", params![serde_json::to_string(&row.summary).unwrap(),serde_json::to_string(&row).unwrap()]).unwrap();
        }
        {
            let mut store = Store::open(&file).unwrap();
            assert_eq!(
                store
                    .0
                    .query_row("SELECT capture_target FROM traffic WHERE id=1", [], |row| {
                        row.get::<_, String>(0)
                    })
                    .unwrap(),
                label.to_lowercase()
            );
            let mut rows = (1..=620).map(saved).collect::<Vec<_>>();
            for index in [0, 599] {
                rows[index].summary.source = Source::CdpNode;
                rows[index].summary.capture_target = Some(label.into());
            }
            rows[600].summary.capture_target = Some("another target".into());
            rows[2]
                .request
                .headers
                .push(("x-librium-target".into(), label.into()));
            store.save(&rows).unwrap();
        }
        let store = Store::open(&file).unwrap();
        let query = |op: &str| Search {
            rules: vec![Rule {
                field: "capture_target".into(),
                op: op.into(),
                value: label.to_lowercase(),
            }],
            ..Search::default()
        };
        let page = store.search(&query("eq")).unwrap();
        assert_eq!(page.total, 620);
        assert_eq!(page.matched, 2);
        assert_eq!(
            page.rows.iter().map(|row| row.id).collect::<Vec<_>>(),
            [600, 1]
        );
        assert_eq!(
            store
                .detail(1)
                .unwrap()
                .unwrap()
                .summary
                .capture_target
                .as_deref(),
            Some(label)
        );
        assert!(
            store
                .detail(3)
                .unwrap()
                .unwrap()
                .summary
                .capture_target
                .is_none()
        );
        let page = store
            .search(&Search {
                limit: 1,
                offset: 1,
                ..query("eq")
            })
            .unwrap();
        assert_eq!(page.rows[0].id, 1);
        assert_eq!(
            store
                .search(&Search {
                    before: Some(500),
                    ..query("eq")
                })
                .unwrap()
                .matched,
            1
        );
        assert_eq!(
            store
                .search(&Search {
                    source: Some(Source::CdpChromium),
                    ..query("eq")
                })
                .unwrap()
                .matched,
            0
        );
        assert_eq!(store.search(&query("ne")).unwrap().matched, 1);
        assert_eq!(
            store
                .read_snapshot()
                .unwrap()
                .search(&query("contains"))
                .unwrap()
                .matched,
            2
        );
        let plan: String = store
            .0
            .query_row(
                "EXPLAIN QUERY PLAN SELECT id FROM traffic WHERE capture_target=? ORDER BY id",
                [label.to_lowercase()],
                |row| row.get(3),
            )
            .unwrap();
        assert!(plan.contains("traffic_capture_target"), "{plan}");
        drop(store);
        // The persistent index must also work with ordinary SQLite connections.
        let db = Connection::open(&file).unwrap();
        db.execute("UPDATE traffic SET size=size WHERE id=1", [])
            .unwrap();
        drop(db);
        std::fs::remove_file(file).unwrap();
    }
    #[test]
    fn source_filter_is_global_combines_with_status_and_pages() {
        use crate::capture::Source;
        let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let mut rows: Vec<_> = (1..=620).map(saved).collect();
        for index in [0, 599] {
            rows[index].summary.source = Source::CdpNode;
        }
        rows[1].summary.source = Source::CdpChromium;
        rows[2].summary.source = Source::External;
        rows[599].summary.error = Some("Наблюдение отключено".into());
        store.save(&rows).unwrap();
        for (source, ids) in [
            (Source::CdpNode, vec![600, 1]),
            (Source::CdpChromium, vec![2]),
            (Source::External, vec![3]),
        ] {
            let page = store
                .search(&Search {
                    source: Some(source),
                    ..Search::default()
                })
                .unwrap();
            assert_eq!(page.total, 620);
            assert_eq!(page.matched, ids.len() as i64);
            assert_eq!(page.rows.iter().map(|row| row.id).collect::<Vec<_>>(), ids);
        }
        let page = store
            .search(&Search {
                source: Some(Source::Proxy),
                ..Search::default()
            })
            .unwrap();
        assert_eq!(page.matched, 616);
        let page = store
            .search(&Search {
                source: Some(Source::CdpNode),
                limit: 1,
                offset: 1,
                ..Search::default()
            })
            .unwrap();
        assert_eq!(page.rows[0].id, 1);
        let page = store
            .search(&Search {
                source: Some(Source::CdpNode),
                before: Some(500),
                ..Search::default()
            })
            .unwrap();
        assert_eq!(page.rows.len(), 1);
        assert_eq!(page.rows[0].id, 1);
        let page = store
            .search(&Search {
                source: Some(Source::CdpNode),
                status: "error".into(),
                ..Search::default()
            })
            .unwrap();
        assert_eq!(page.rows.len(), 1);
        assert_eq!(page.rows[0].id, 600);
        assert!(serde_json::from_str::<Search>(r#"{"source":"unknown"}"#).is_err());
    }
    #[test]
    fn pending_and_error_filters_distinguish_unknown_results() {
        let mut store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let mut rows: Vec<_> = (1..=5).map(saved).collect();
        for index in [0, 1, 3] {
            rows[index].summary.status = None;
            rows[index].response.complete = false;
        }
        rows[1].summary.error = Some("Захват отключён до ответа".into());
        rows[2].summary.status = Some(202);
        rows[2].summary.error = Some("Ответ не завершён до отключения".into());
        rows[3].summary.error = Some(String::new());
        store.save(&rows).unwrap();
        for (status, ids) in [
            ("pending", vec![4, 1]),
            ("error", vec![3, 2]),
            ("2", vec![5, 3]),
        ] {
            let page = store
                .search(&Search {
                    status: status.into(),
                    ..Search::default()
                })
                .unwrap();
            assert_eq!(page.total, 5);
            assert_eq!(page.matched, ids.len() as i64);
            assert_eq!(
                page.rows.iter().map(|row| row.id).collect::<Vec<_>>(),
                ids,
                "{status}"
            );
        }
    }
    #[test]
    fn protobuf_search_finds_archived_values_before_paging_and_direction() {
        use base64::{Engine, prelude::BASE64_STANDARD};
        let dir = std::env::temp_dir().join(format!("librium-protobuf-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("history.sqlite3");
        let bytes = [vec![10, 12], "Привет".as_bytes().to_vec()].concat();
        {
            let store = Store::open(&path).unwrap();
            store.ws_start(1).unwrap();
            let mut message = crate::websocket::Message {
                time: 0,
                direction: "sent".into(),
                kind: "BINARY".into(),
                text: String::new(),
                base64: BASE64_STANDARD.encode(&bytes),
                size: bytes.len(),
                truncated: false,
            };
            store.ws_record(1, &message).unwrap();
            for _ in 0..130 {
                message.base64 = "CAE=".into();
                message.size = 2;
                store.ws_record(1, &message).unwrap();
            }
            message.base64 = BASE64_STANDARD.encode(&bytes);
            message.size = bytes.len();
            message.truncated = true;
            store.ws_record(1, &message).unwrap();
            message.truncated = false;
            message.direction = "received".into();
            store.ws_record(1, &message).unwrap();
            message.base64 = "AA==".into();
            store.ws_record(1, &message).unwrap();
        }
        {
            let store = Store::open(&path).unwrap();
            assert_eq!(store.ws_page(1, None).unwrap()["total"], 134);
            let page = store
                .ws_search_direction(1, None, "ПРИВЕТ", "BINARY", "protobuf", "sent")
                .unwrap();
            assert_eq!(page["matched"], 1);
            assert_eq!(page["messages"][0]["id"], 1);
            assert_eq!(page["messages"][0]["base64"], BASE64_STANDARD.encode(bytes));
            assert_eq!(
                store
                    .ws_search_direction(1, None, "привет", "BINARY", "protobuf", "received")
                    .unwrap()["matched"],
                1
            );
            assert_eq!(
                store
                    .ws_search_format(1, None, "привет", "BINARY", "protobuf")
                    .unwrap()["matched"],
                2
            );
            assert_eq!(
                store
                    .ws_search_format(1, None, "привет", "BINARY", "text")
                    .unwrap()["matched"],
                0
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn msgpack_search_covers_archived_pages_without_changing_messages() {
        use base64::{Engine, prelude::BASE64_STANDARD};
        let dir = std::env::temp_dir().join(format!("librium-msgpack-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("history.sqlite3");
        {
            let store = Store::open(&file).unwrap();
            store.ws_start(1).unwrap();
            let packed = [
                0x81, 0xa5, b'e', b'v', b'e', b'n', b't', 0xa4, 0xd0, 0x9f, 0xd0, 0xb8,
            ];
            let mut message = crate::websocket::Message {
                time: 1,
                direction: "sent".into(),
                kind: "BINARY".into(),
                text: String::new(),
                base64: BASE64_STANDARD.encode(packed),
                size: packed.len(),
                truncated: false,
            };
            for _ in 0..129 {
                store.ws_record(1, &message).unwrap();
            }
            message.truncated = true;
            store.ws_record(1, &message).unwrap();
            message.truncated = false;
            message.base64 = "wQ==".into();
            store.ws_record(1, &message).unwrap();
        }
        let store = Store::open(&file).unwrap();
        assert_eq!(store.ws_search(1, None, "event", "").unwrap()["matched"], 0);
        let page = store
            .ws_search_format(1, None, "ПИ", "BINARY", "msgpack")
            .unwrap();
        assert_eq!(page["total"], 131);
        assert_eq!(page["matched"], 129);
        assert_eq!(page["messages"].as_array().unwrap().len(), 100);
        assert_eq!(page["older"], true);
        let first = page["messages"][0]["id"].as_i64().unwrap();
        let older = store
            .ws_search_format(1, Some(first), "пи", "BINARY", "msgpack")
            .unwrap();
        assert_eq!(older["messages"].as_array().unwrap().len(), 29);
        assert_eq!(older["older"], false);
        assert_eq!(
            store
                .ws_search_format(1, None, "event", "TEXT", "msgpack")
                .unwrap()["matched"],
            0
        );
        assert!(
            store
                .ws_search_format(1, None, "event", "", "invalid")
                .is_err()
        );
        assert_eq!(
            store
                .ws_search_format(1, None, "' OR 1=1 --", "", "msgpack")
                .unwrap()["matched"],
            0
        );
        assert_eq!(store.ws_page(1, None).unwrap()["total"], 131);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn capture_sources_migrate_and_unavailable_external_bodies_are_not_interrupted() {
        use crate::capture::Source;
        let dir = std::env::temp_dir().join(format!("librium-sources-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("history.sqlite3");
        {
            let mut store = Store::open(&path).unwrap();
            let mut proxy = saved(1);
            proxy.response.complete = false;
            let mut node = saved(2);
            node.summary.source = Source::CdpNode;
            node.request.complete = false;
            let mut legacy = saved(3);
            legacy.summary.source = Source::External;
            legacy.response.complete = false;
            legacy
                .request
                .headers
                .push(("x-librium-source".into(), "old adapter".into()));
            let mut spoof = saved(4);
            spoof.response.complete = false;
            spoof
                .request
                .headers
                .push(("x-librium-source".into(), "untrusted request header".into()));
            let mut external = saved(5);
            external.summary.source = Source::CdpChromium;
            store.save(&[proxy, node, legacy, spoof, external]).unwrap();
            store.ws_start(4).unwrap();
            store.ws_start(5).unwrap();
            assert!(!store.external_ws_open(4).unwrap());
            assert!(store.external_ws_open(5).unwrap());
            store.0.execute_batch("UPDATE traffic SET summary=json_remove(summary,'$.source'),detail=json_remove(detail,'$.summary.source') WHERE id IN(1,3)").unwrap();
        }
        {
            let store = Store::open(&path).unwrap();
            assert!(store.detail(1).unwrap().unwrap().summary.error.is_some());
            assert!(store.detail(2).unwrap().unwrap().summary.error.is_none());
            assert!(store.detail(3).unwrap().unwrap().summary.error.is_none());
            assert!(store.detail(4).unwrap().unwrap().summary.error.is_some());
            for (source, count) in [
                (Source::Proxy, 2),
                (Source::External, 1),
                (Source::CdpNode, 1),
                (Source::CdpChromium, 1),
            ] {
                assert_eq!(
                    store
                        .search(&Search {
                            source: Some(source),
                            ..Search::default()
                        })
                        .unwrap()
                        .matched,
                    count
                );
            }
            assert_eq!(
                serde_json::to_value(store.detail(2).unwrap().unwrap()).unwrap()["summary"]["source"],
                "cdp_node"
            );
            assert_eq!(
                serde_json::to_value(store.detail(3).unwrap().unwrap()).unwrap()["summary"]["source"],
                "external"
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
    fn saved(id: u64) -> SavedExchange {
        serde_json::from_value(serde_json::json!({
            "summary":{"id":id,"time":0,"method":"GET","url":format!("https://example.test/assets/{id}.png?q=100%"),"status":200,"elapsed_ms":1,"size":3,"error":null},
            "request":{"headers":[],"text":"","base64":"","size":0,"complete":true,"truncated":false},
            "response":{"headers":[["content-type","image/png"]],"text":"png","base64":"cG5n","size":3,"complete":true,"truncated":false}
        })).unwrap()
    }
    #[test]
    fn exact_json_scalar_filter_is_global_typed_and_preserves_long_values() {
        use crate::json_pointer::ScalarFilter;
        use base64::{Engine, prelude::BASE64_STANDARD};
        let file = std::env::temp_dir().join(format!(
            "librium-json-exact-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        {
            let mut store = Store::open(&file).unwrap();
            store.save(&[saved(1)]).unwrap();
            store.ws_start(1).unwrap();
            let put = |text: &str, direction: &str, partial: bool| {
                store
                    .ws_record(
                        1,
                        &crate::websocket::Message {
                            time: 1,
                            direction: direction.into(),
                            kind: "TEXT".into(),
                            text: text.into(),
                            base64: BASE64_STANDARD.encode(text),
                            size: text.len() + usize::from(partial),
                            truncated: partial,
                        },
                    )
                    .unwrap()
            };
            for value in [
                "1",
                "117",
                r#""1""#,
                "1.0",
                r#""Ready""#,
                r#""ready""#,
                "1e400",
                "18446744073709551616123456789",
                "null",
                "false",
                r#""""#,
            ] {
                put(&format!("{{\"value\":{value}}}"), "received", false);
            }
            put(r#"{"value":1,"value":1}"#, "sent", false);
            put(r#"{"value":1}"#, "sent", true);
            for _ in 0..250 {
                put(r#"{"value":1}"#, "sent", false);
            }
            let long = "я".repeat(10000);
            put(&format!("{{\"value\":\"{long}\"}}"), "received", false);
            for _ in 0..700 {
                put(r#"{"noise":true}"#, "sent", false);
            }
            let run = |kind: &str, value: &str, before, direction: &str| {
                store
                    .ws_search_exact(
                        1,
                        before,
                        WsFilter {
                            field_exact: None,
                            socketio_exact: None,
                            query: "",
                            pointer: "/value",
                            kind: "DATA",
                            format: "jsonpointer",
                            direction,
                        },
                        Some(&ScalarFilter {
                            kind: kind.into(),
                            value: value.into(),
                        }),
                    )
                    .unwrap()
            };
            let numbers = run("number", "1", None, "");
            assert_eq!(numbers["matched"], 251);
            assert_eq!(numbers["messages"].as_array().unwrap().len(), 100);
            assert_eq!(numbers["older"], true);
            assert_eq!(
                run("number", "1", numbers["messages"][0]["id"].as_i64(), "")["messages"]
                    .as_array()
                    .unwrap()
                    .len(),
                100
            );
            assert_eq!(run("number", "1", None, "received")["matched"], 1);
            for (kind, value) in [
                ("string", "1"),
                ("number", "1.0"),
                ("string", "Ready"),
                ("string", "ready"),
                ("number", "1e400"),
                ("number", "18446744073709551616123456789"),
                ("null", "null"),
                ("boolean", "false"),
                ("string", ""),
            ] {
                assert_eq!(run(kind, value, None, "")["matched"], 1, "{kind} {value}");
            }
            assert_eq!(run("string", &long, None, "")["matched"], 1);
            assert!(
                store
                    .ws_search_exact(
                        1,
                        None,
                        WsFilter {
                            field_exact: None,
                            socketio_exact: None,
                            query: "1",
                            pointer: "/value",
                            kind: "",
                            format: "jsonpointer",
                            direction: ""
                        },
                        Some(&ScalarFilter {
                            kind: "number".into(),
                            value: "1".into()
                        })
                    )
                    .is_err()
            );
        }
        {
            let store = Store::open(&file).unwrap();
            assert_eq!(
                store
                    .ws_search_exact(
                        1,
                        None,
                        WsFilter {
                            field_exact: None,
                            socketio_exact: None,
                            query: "",
                            pointer: "/value",
                            kind: "",
                            format: "jsonpointer",
                            direction: ""
                        },
                        Some(&ScalarFilter {
                            kind: "number".into(),
                            value: "1".into()
                        })
                    )
                    .unwrap()["matched"],
                251
            );
        }
        std::fs::remove_file(file).unwrap();
    }
    #[test]
    fn json_value_counts_cover_full_archive_and_keep_scalar_types_exact() {
        use base64::{Engine, prelude::BASE64_STANDARD};
        let file = std::env::temp_dir().join(format!(
            "librium-json-values-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        {
            let mut store = Store::open(&file).unwrap();
            store.save(&[saved(1), saved(2)]).unwrap();
            store.ws_start(1).unwrap();
            store.ws_start(2).unwrap();
            let put = |text: &str, kind: &str, direction: &str, partial: bool| {
                store
                    .ws_record(
                        1,
                        &crate::websocket::Message {
                            time: 1,
                            direction: direction.into(),
                            kind: kind.into(),
                            text: if kind == "TEXT" {
                                text.into()
                            } else {
                                String::new()
                            },
                            base64: BASE64_STANDARD.encode(text),
                            size: text.len() + usize::from(partial),
                            truncated: partial,
                        },
                    )
                    .unwrap()
            };
            for _ in 0..600 {
                put(r#"{"event":"ready"}"#, "TEXT", "sent", false);
            }
            put(r#"{"event":"ready"}"#, "BINARY", "received", false);
            for text in [
                r#"{"event":"Ready"}"#,
                r#"{"event":null}"#,
                r#"{"event":null}"#,
                r#"{"event":"null"}"#,
                r#"{"event":1}"#,
                r#"{"event":"1"}"#,
                r#"{"event":1.0}"#,
                r#"{"event":18446744073709551616123456789}"#,
            ] {
                put(text, "TEXT", "sent", false);
            }
            for text in [
                r#"{"event":{}}"#,
                r#"{"event":[]}"#,
                r#"{"other":"ready"}"#,
                "invalid",
                r#"{"event":"x","event":"y"}"#,
            ] {
                put(text, "TEXT", "sent", false);
            }
            put(r#"{"event":"ready"}"#, "TEXT", "sent", true);
            for n in 0..120 {
                put(
                    &format!(r#"{{"event":"unique-{n}"}}"#),
                    "TEXT",
                    "sent",
                    false,
                );
            }
            let stats = store
                .read_snapshot()
                .unwrap()
                .ws_json_values(1, "/event")
                .unwrap()
                .unwrap();
            assert_eq!(stats["total"], 735);
            assert_eq!(stats["matched"], 729);
            assert_eq!(stats["excluded"], 6);
            assert_eq!(stats["distinct"], 128);
            assert_eq!(stats["other"], 28);
            assert_eq!(stats["rows"].as_array().unwrap().len(), 100);
            assert_eq!(stats["rows"][0]["value"], "ready");
            assert_eq!(stats["rows"][0]["count"], 601);
            assert_eq!(stats["rows"][0]["sent"], 600);
            assert_eq!(stats["rows"][0]["received"], 1);
            assert!(
                stats["rows"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|row| row["kind"] == "number"
                        && row["value"] == "18446744073709551616123456789")
            );
            assert!(store.ws_json_values(3, "/event").unwrap().is_none());
            assert!(store.ws_json_values(1, "bad").is_err());
            assert_eq!(
                store.ws_json_values(2, "/event").unwrap().unwrap()["matched"],
                0
            );
            assert_eq!(
                store.ws_json_values(1, "/absent").unwrap().unwrap()["excluded"],
                735
            );
        }
        {
            let store = Store::open(&file).unwrap();
            assert_eq!(
                store.ws_json_values(1, "/event").unwrap().unwrap()["matched"],
                729
            );
        }
        std::fs::remove_file(file).unwrap();
    }
    #[test]
    fn json_field_search_reads_archive_before_paging_preserves_values_and_tests_existence() {
        use base64::{Engine, prelude::BASE64_STANDARD};
        let file = std::env::temp_dir().join(format!(
            "librium-json-field-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        {
            let mut store = Store::open(&file).unwrap();
            store.save(&[saved(1)]).unwrap();
            store.ws_start(1).unwrap();
            let put = |text: &str, kind: &str, direction: &str, truncated: bool| {
                store
                    .ws_record(
                        1,
                        &crate::websocket::Message {
                            time: 1,
                            direction: direction.into(),
                            kind: kind.into(),
                            text: if kind == "TEXT" {
                                text.into()
                            } else {
                                String::new()
                            },
                            base64: BASE64_STANDARD.encode(text),
                            size: text.len() + usize::from(truncated),
                            truncated,
                        },
                    )
                    .unwrap()
            };
            put(
                r#"{"event":"connected","params":{"state":"ready"},"items":[{"type":"alpha"}],"id":18446744073709551616123456789}"#,
                "TEXT",
                "sent",
                false,
            );
            put(
                r#"{"event":"other","params":{"state":"connected"}}"#,
                "TEXT",
                "received",
                false,
            );
            put(r#"{"event":"connected"}"#, "BINARY", "received", false);
            put(r#"{"event":"connected"}"#, "TEXT", "received", true);
            put("invalid JSON connected", "TEXT", "sent", false);
            put(r#"{"event":null}"#, "TEXT", "sent", false);
            put(r#"{"other":"connected"}"#, "TEXT", "sent", false);
            put(r#"{"event":""}"#, "TEXT", "sent", false);
            put(
                r#"{"event":"connected","event":"ambiguous"}"#,
                "TEXT",
                "sent",
                false,
            );
            for _ in 0..700 {
                put(r#"{"event":"noise"}"#, "TEXT", "sent", false);
            }
            let search = |query: &str, pointer: &str, kind: &str, direction: &str, before| {
                store
                    .ws_search_filter(
                        1,
                        before,
                        WsFilter {
                            field_exact: None,
                            socketio_exact: None,
                            query,
                            pointer,
                            kind,
                            direction,
                            format: "jsonpointer",
                        },
                    )
                    .unwrap()
            };
            let data = search("CONNECTED", "/event", "", "", None);
            assert_eq!(data["matched"], 2);
            assert_eq!(data["total"], 709);
            assert_eq!(data["messages"][0]["field_preview"], "connected");
            assert_eq!(
                search("connected", "/event", "BINARY", "received", None)["matched"],
                1
            );
            assert_eq!(
                search("connected", "/event", "TEXT", "received", None)["matched"],
                0
            );
            assert_eq!(search("ready", "/params/state", "", "", None)["matched"], 1);
            assert_eq!(search("ALPHA", "/items/0/type", "", "", None)["matched"], 1);
            assert_eq!(search("", "/event", "", "", None)["matched"], 705);
            assert_eq!(search("", "/absent", "", "", None)["matched"], 0);
            let exact = search("18446744073709551616123456789", "/id", "", "", None);
            assert_eq!(exact["matched"], 1);
            assert_eq!(
                exact["messages"][0]["field_preview"],
                "18446744073709551616123456789"
            );
            let page = search("noise", "/event", "", "", None);
            assert_eq!(page["matched"], 700);
            assert_eq!(page["messages"].as_array().unwrap().len(), 100);
            assert_eq!(page["older"], true);
            assert_eq!(
                search(
                    "noise",
                    "/event",
                    "",
                    "",
                    page["messages"][0]["id"].as_i64()
                )["messages"]
                    .as_array()
                    .unwrap()
                    .len(),
                100
            );
            for pointer in ["bad", "/~2"] {
                assert!(
                    store
                        .ws_search_filter(
                            1,
                            None,
                            WsFilter {
                                field_exact: None,
                                socketio_exact: None,
                                query: "",
                                pointer,
                                kind: "",
                                direction: "",
                                format: "jsonpointer"
                            }
                        )
                        .is_err()
                );
            }
            assert!(
                store
                    .ws_search_filter(
                        1,
                        None,
                        WsFilter {
                            field_exact: None,
                            socketio_exact: None,
                            query: "",
                            pointer: "/event",
                            kind: "",
                            direction: "",
                            format: "text"
                        }
                    )
                    .is_err()
            );
            assert!(
                store
                    .ws_message(1, 1)
                    .unwrap()
                    .unwrap()
                    .get("field_preview")
                    .is_none()
            );
        }
        {
            let store = Store::open(&file).unwrap();
            assert_eq!(
                store
                    .ws_search_filter(
                        1,
                        None,
                        WsFilter {
                            field_exact: None,
                            socketio_exact: None,
                            query: "connected",
                            pointer: "/event",
                            kind: "",
                            direction: "",
                            format: "jsonpointer"
                        }
                    )
                    .unwrap()["matched"],
                2
            );
        }
        std::fs::remove_file(file).unwrap();
    }
    #[test]
    fn cdp_structured_search_filters_before_paging_and_ignores_nested_text() {
        use base64::{Engine, prelude::BASE64_STANDARD};
        let file = std::env::temp_dir().join(format!(
            "librium-cdp-search-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        {
            let mut store = Store::open(&file).unwrap();
            store.save(&[saved(1)]).unwrap();
            store.ws_start(1).unwrap();
            let put = |text: &str, kind: &str, direction: &str, truncated: bool| {
                store
                    .ws_record(
                        1,
                        &crate::websocket::Message {
                            time: 1,
                            direction: direction.into(),
                            kind: kind.into(),
                            text: if kind == "TEXT" {
                                text.into()
                            } else {
                                String::new()
                            },
                            base64: BASE64_STANDARD.encode(text),
                            size: text.len() + usize::from(truncated),
                            truncated,
                        },
                    )
                    .unwrap()
            };
            put(
                r#"{"id":17,"method":"Runtime.evaluate","params":{}}"#,
                "TEXT",
                "received",
                false,
            );
            put(
                r#"{"id":17,"result":{"method":"Runtime.evaluate","id":117}}"#,
                "TEXT",
                "sent",
                false,
            );
            put(
                r#"{"id":17,"value":{"method":"Runtime.evaluate"}}"#,
                "TEXT",
                "sent",
                false,
            );
            put(
                r#"{"method":"Runtime.consoleAPICalled","params":{}}"#,
                "TEXT",
                "sent",
                false,
            );
            put(
                r#"{"id":117,"method":"Runtime.evaluate"}"#,
                "BINARY",
                "received",
                false,
            );
            put(
                r#"{"id":17,"method":"Runtime.evaluate"}"#,
                "TEXT",
                "received",
                true,
            );
            put(
                r#"{"jsonrpc":"2.0","id":17,"method":"Runtime.evaluate"}"#,
                "TEXT",
                "received",
                false,
            );
            put("not JSON: Runtime.evaluate id17", "TEXT", "sent", false);
            put(
                r#"{"id":17,"error":{"code":-1,"message":"bad"}}"#,
                "BINARY",
                "sent",
                false,
            );
            for _ in 0..700 {
                put(
                    r#"{"method":"Log.entryAdded","params":{}}"#,
                    "TEXT",
                    "sent",
                    false,
                );
            }
            let method = store
                .ws_search_direction(1, None, "Runtime.evaluate", "", "cdp_method", "")
                .unwrap();
            assert_eq!(method["matched"], 2);
            assert_eq!(method["total"], 709);
            assert_eq!(
                store
                    .ws_search_direction(1, None, "runtime.evaluate", "", "cdp_method", "")
                    .unwrap()["matched"],
                0
            );
            assert_eq!(
                store
                    .ws_search_direction(1, None, "Runtime.console", "", "cdp_method", "")
                    .unwrap()["matched"],
                1
            );
            assert_eq!(
                store
                    .ws_search_direction(1, None, "0017", "", "cdp_id", "")
                    .unwrap()["matched"],
                3
            );
            assert_eq!(
                store
                    .ws_search_direction(1, None, "17", "BINARY", "cdp_id", "sent")
                    .unwrap()["matched"],
                1
            );
            assert_eq!(
                store
                    .ws_search_direction(1, Some(2), "17", "", "cdp_id", "")
                    .unwrap()["messages"]
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );
            let logs = store
                .ws_search_direction(1, None, "Log.", "DATA", "cdp_method", "sent")
                .unwrap();
            assert_eq!(logs["matched"], 700);
            assert_eq!(logs["messages"].as_array().unwrap().len(), 100);
            assert_eq!(logs["older"], true);
            let before = logs["messages"][0]["id"].as_i64().unwrap();
            assert_eq!(
                store
                    .ws_search_direction(1, Some(before), "Log.", "DATA", "cdp_method", "sent")
                    .unwrap()["messages"]
                    .as_array()
                    .unwrap()
                    .len(),
                100
            );
            for query in ["-1", "17.0", "9007199254740992"] {
                assert!(
                    store
                        .ws_search_direction(1, None, query, "", "cdp_id", "")
                        .is_err()
                );
            }
        }
        {
            let store = Store::open(&file).unwrap();
            assert_eq!(
                store
                    .ws_search_direction(1, None, "17", "", "cdp_id", "")
                    .unwrap()["matched"],
                3
            );
        }
        std::fs::remove_file(file).unwrap();
    }
    #[test]
    fn cdp_pairs_scan_archived_messages_scope_ids_and_do_not_guess_reuse() {
        use base64::{Engine, prelude::BASE64_STANDARD};
        let file =
            std::env::temp_dir().join(format!("librium-cdp-{}.sqlite3", uuid::Uuid::new_v4()));
        let put = |store: &Store, connection: u64, text: &str, direction: &str, time: u64| {
            store
                .ws_record(
                    connection,
                    &crate::websocket::Message {
                        time,
                        direction: direction.into(),
                        kind: "TEXT".into(),
                        text: text.into(),
                        base64: BASE64_STANDARD.encode(text),
                        size: text.len(),
                        truncated: false,
                    },
                )
                .unwrap();
        };
        {
            let mut store = Store::open(&file).unwrap();
            store.save(&[saved(1), saved(2)]).unwrap();
            store.ws_start(1).unwrap();
            store.ws_start(2).unwrap();
            put(
                &store,
                1,
                r#"{"id":7,"method":"Runtime.enable","sessionId":"a"}"#,
                "received",
                100,
            );
            for _ in 0..700 {
                put(
                    &store,
                    1,
                    r#"{"method":"Runtime.event","params":{}}"#,
                    "sent",
                    101,
                );
            }
            put(
                &store,
                1,
                r#"{"id":7,"result":{},"sessionId":"a"}"#,
                "sent",
                125,
            );
            put(
                &store,
                1,
                r#"{"id":7,"result":{},"sessionId":"b"}"#,
                "sent",
                126,
            );
            put(&store, 1, r#"{"id":7,"result":{}}"#, "sent", 127);
            put(
                &store,
                1,
                r#"{"id":7,"result":{},"sessionId":"a"}"#,
                "received",
                128,
            );
            put(
                &store,
                2,
                r#"{"id":7,"result":{},"sessionId":"a"}"#,
                "sent",
                129,
            );
            let pair = store.ws_cdp_related(1, 1).unwrap().unwrap();
            assert_eq!(pair["status"], "matched");
            assert_eq!(pair["pair"], 702);
            assert_eq!(pair["latency_ms"], 25);
            assert_eq!(pair["inspected"], 705);
            let reverse = store.ws_cdp_related(1, 702).unwrap().unwrap();
            assert_eq!(reverse["pair"], 1);
            assert!(store.ws_cdp_related(2, 1).unwrap().is_none());
            assert_eq!(
                store.ws_cdp_related(1, 2).unwrap().unwrap()["supported"],
                false
            );
            assert_eq!(
                store.ws_cdp_related(1, 704).unwrap().unwrap()["status"],
                "missing"
            );
            let snapshot = store.read_snapshot().unwrap();
            assert_eq!(
                snapshot.ws_cdp_related(1, 1).unwrap().unwrap()["inspected"],
                705
            );
            put(
                &store,
                1,
                r#"{"method":"Runtime.event","params":{}}"#,
                "sent",
                130,
            );
            assert_eq!(
                snapshot.ws_cdp_related(1, 1).unwrap().unwrap()["inspected"],
                705
            );
            assert_eq!(
                store.ws_cdp_related(1, 1).unwrap().unwrap()["inspected"],
                706
            );
            assert!(
                snapshot.ws_end(1, None).is_err(),
                "manual scan connection must be read-only"
            );
        }
        {
            let mut store = Store::open(&file).unwrap();
            assert_eq!(
                store.ws_cdp_related(1, 1).unwrap().unwrap()["status"],
                "matched"
            );
            put(
                &store,
                1,
                r#"{"id":7,"method":"Runtime.enable","sessionId":"a"}"#,
                "received",
                150,
            );
            let ambiguous = store.ws_cdp_related(1, 1).unwrap().unwrap();
            assert_eq!(ambiguous["status"], "ambiguous");
            assert!(ambiguous["pair"].is_null());
            for _ in 0..25 {
                put(
                    &store,
                    1,
                    r#"{"id":7,"result":{},"sessionId":"a"}"#,
                    "sent",
                    160,
                );
            }
            let bounded = store.ws_cdp_related(1, 1).unwrap().unwrap();
            assert_eq!(bounded["response_count"], 26);
            assert_eq!(bounded["responses"].as_array().unwrap().len(), 20);
            store.clear().unwrap();
            assert!(store.ws_cdp_related(1, 1).unwrap().is_none());
        }
        std::fs::remove_file(file).unwrap();
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
    pub fn read_snapshot(&self) -> Result<Self> {
        let path = self
            .0
            .path()
            .ok_or_else(|| anyhow::anyhow!("History path unavailable"))?;
        let reader = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        reader.busy_timeout(std::time::Duration::from_secs(5))?;
        register_ws_functions(&reader)?;
        reader.execute_batch("BEGIN DEFERRED")?;
        Ok(Self(reader))
    }
    pub fn open(path: &std::path::Path) -> Result<Self> {
        let db = Connection::open(path)?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        register_ws_functions(&db)?;
        db.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS traffic (
                id INTEGER PRIMARY KEY, method TEXT NOT NULL, url TEXT NOT NULL,
                host TEXT NOT NULL, path TEXT NOT NULL, status INTEGER, size INTEGER NOT NULL,
                search TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS ws_sessions (exchange_id INTEGER PRIMARY KEY, state TEXT NOT NULL, error TEXT);
            CREATE TABLE IF NOT EXISTS ws_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, exchange_id INTEGER NOT NULL, data TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS ws_exchange ON ws_messages(exchange_id,id);
            CREATE INDEX IF NOT EXISTS ws_direction ON ws_messages(exchange_id,json_extract(data,'$.direction'),id);
            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS traffic_host ON traffic(host, id);
            CREATE INDEX IF NOT EXISTS traffic_status ON traffic(status, id);
            CREATE INDEX IF NOT EXISTS traffic_method ON traffic(method, id);
            CREATE INDEX IF NOT EXISTS traffic_source ON traffic(json_extract(summary,'$.source'), id);
            CREATE INDEX IF NOT EXISTS traffic_context ON traffic(json_extract(summary,'$.capture_context'), id);",
        )?;
        let has_target = {
            let mut statement = db.prepare("PRAGMA table_info(traffic)")?;
            statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<rusqlite::Result<Vec<_>>>()?
                .iter()
                .any(|name| name == "capture_target")
        };
        if !has_target {
            db.execute_batch("BEGIN; ALTER TABLE traffic ADD COLUMN capture_target TEXT;
                UPDATE traffic SET capture_target=librium_lower(json_extract(summary,'$.capture_target'));
                DROP INDEX IF EXISTS traffic_capture_target;
                CREATE INDEX traffic_capture_target ON traffic(capture_target,id); COMMIT;")?;
        } else {
            db.execute_batch(
                "CREATE INDEX IF NOT EXISTS traffic_capture_target ON traffic(capture_target,id);",
            )?;
        }
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
        let has_role_index:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='traffic_ws_role')",[],|row|row.get(0))?;
        if !has_role_index {
            db.execute_batch("UPDATE traffic SET kind='ws' WHERE kind<>'ws' AND (url LIKE 'ws:%' OR url LIKE 'wss:%');")?;
        }
        db.execute_batch("CREATE INDEX IF NOT EXISTS traffic_ws_role ON traffic(json_extract(summary,'$.ws_role'),id) WHERE kind='ws';
            CREATE INDEX IF NOT EXISTS traffic_context_catalogue ON traffic(json_extract(summary,'$.capture_context'),kind,id) WHERE json_extract(summary,'$.capture_context') IS NOT NULL;")?;
        db.execute_batch("UPDATE traffic SET summary=json_set(summary,'$.source', CASE WHEN EXISTS(SELECT 1 FROM json_each(detail,'$.request.headers') WHERE json_extract(value,'$[0]')='x-librium-source') THEN 'external' ELSE 'proxy' END) WHERE json_type(summary,'$.source') IS NULL;
            UPDATE traffic SET detail=json_set(detail,'$.summary.source',json_extract(summary,'$.source')) WHERE json_type(detail,'$.summary.source') IS NULL;")?;
        let has_close = {
            let mut stmt = db.prepare("PRAGMA table_info(ws_sessions)")?;
            stmt.query_map([], |r| r.get::<_, String>(1))?
                .collect::<rusqlite::Result<Vec<_>>>()?
                .iter()
                .any(|n| n == "close_info")
        };
        if !has_close {
            db.execute_batch("ALTER TABLE ws_sessions ADD COLUMN close_info TEXT;")?;
        }
        // A process restart cannot resume an old socket, but its captured data
        // must remain inspectable instead of appearing pending forever.
        db.execute_batch("UPDATE traffic SET
            summary=json_set(summary, '$.error', 'Соединение прервано при остановке Librium'),
            detail=json_set(detail, '$.summary.error', 'Соединение прервано при остановке Librium')
            WHERE json_extract(summary,'$.error') IS NULL
            AND json_extract(summary,'$.source')='proxy'
            AND (json_extract(detail,'$.request.complete')=0 OR json_extract(detail,'$.response.complete')=0);")?;
        db.execute("UPDATE ws_sessions SET state='closed',error='Соединение закрыто при перезапуске Librium' WHERE state='open'", [])?;
        Ok(Self(db))
    }
    pub fn max_id(&self) -> Result<u64> {
        Ok(self.0.query_row("SELECT max(coalesce((SELECT max(id) FROM traffic),0), coalesce((SELECT value FROM metadata WHERE key='next_id'),0))", [], |r| r.get::<_, i64>(0))? as u64)
    }
    pub fn save(&mut self, rows: &[SavedExchange]) -> Result<()> {
        let tx = self.0.transaction()?;
        {
            let mut insert = tx.prepare_cached("INSERT OR REPLACE INTO traffic(id,method,url,host,path,status,size,search,summary,detail,kind,capture_target) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")?;
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
                    if s.ws_role.is_some()
                        || s.url
                            .get(..3)
                            .is_some_and(|s| s.eq_ignore_ascii_case("ws:"))
                        || s.url
                            .get(..4)
                            .is_some_and(|s| s.eq_ignore_ascii_case("wss:"))
                        || s.status == Some(101)
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
                    },
                    s.capture_target
                        .as_ref()
                        .map(|target| target.to_lowercase())
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
            "INSERT OR REPLACE INTO ws_sessions(exchange_id,state,error) VALUES (?,'open',NULL)",
            [id as i64],
        )?;
        Ok(())
    }
    pub fn external_ws_open(&self, id: u64) -> Result<bool> {
        Ok(self.0.query_row("SELECT EXISTS(SELECT 1 FROM ws_sessions s JOIN traffic t ON t.id=s.exchange_id WHERE s.exchange_id=? AND s.state='open' AND json_extract(t.summary,'$.source')!='proxy')", [i64::try_from(id)?], |r| r.get(0))?)
    }
    pub fn ws_end(&self, id: u64, error: Option<String>) -> Result<()> {
        self.ws_end_with_close(id, error, None)
    }
    pub fn ws_end_with_close(
        &self,
        id: u64,
        error: Option<String>,
        close: Option<&crate::websocket::CloseInfo>,
    ) -> Result<()> {
        self.0.execute(
            "UPDATE ws_sessions SET state='closed',error=?,close_info=coalesce(?,close_info) WHERE exchange_id=?",
            params![error, close.map(serde_json::to_string).transpose()?, id as i64],
        )?;
        Ok(())
    }
    pub fn ws_record(&self, id: u64, message: &crate::websocket::Message) -> Result<()> {
        self.0.execute("INSERT INTO ws_messages(exchange_id,data) SELECT ?,? WHERE EXISTS(SELECT 1 FROM ws_sessions WHERE exchange_id=?)",params![id as i64,serde_json::to_string(message)?,id as i64])?;
        Ok(())
    }
    pub fn ws_close(&self, id: u64, close: &crate::websocket::CloseInfo) -> Result<()> {
        self.0.execute(
            "UPDATE ws_sessions SET close_info=coalesce(close_info,?) WHERE exchange_id=?",
            params![serde_json::to_string(close)?, i64::try_from(id)?],
        )?;
        Ok(())
    }
    pub fn ws_page(&self, id: u64, before: Option<i64>) -> Result<serde_json::Value> {
        self.ws_search(id, before, "", "")
    }
    pub fn ws_message(&self, id: u64, message_id: i64) -> Result<Option<serde_json::Value>> {
        let json:Option<String>=self.0.query_row("SELECT m.data FROM ws_messages m JOIN ws_sessions s ON s.exchange_id=m.exchange_id JOIN traffic t ON t.id=m.exchange_id WHERE m.exchange_id=? AND m.id=?",params![i64::try_from(id)?,message_id],|r|r.get(0)).optional()?;
        json.map(|s| {
            let mut value: serde_json::Value = serde_json::from_str(&s)?;
            value["id"] = message_id.into();
            Ok(value)
        })
        .transpose()
    }
    pub fn ws_context(&self, id: u64, message_id: i64) -> Result<Option<serde_json::Value>> {
        let id = i64::try_from(id)?;
        let exists:bool=self.0.query_row("SELECT EXISTS(SELECT 1 FROM ws_messages m JOIN ws_sessions s ON s.exchange_id=m.exchange_id JOIN traffic t ON t.id=m.exchange_id WHERE m.exchange_id=? AND m.id=?)",params![id,message_id],|r|r.get(0))?;
        if !exists {
            return Ok(None);
        }
        // Seek through the exchange/id index, rather than decoding the session.
        let mut statement=self.0.prepare("WITH earlier AS MATERIALIZED (SELECT id FROM ws_messages WHERE exchange_id=?1 AND id<?2 ORDER BY id DESC LIMIT 5),
            later AS MATERIALIZED (SELECT id FROM ws_messages WHERE exchange_id=?1 AND id>?2 ORDER BY id LIMIT 5),
            selected AS (SELECT id FROM earlier UNION ALL SELECT ?2 UNION ALL SELECT id FROM later)
            SELECT m.id,m.data FROM selected p JOIN ws_messages m ON m.id=p.id ORDER BY m.id")?;
        let records = statement.query_map(params![id, message_id], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut messages = Vec::new();
        let mut previous = None;
        let mut next = None;
        for record in records {
            let (key, data) = record?;
            if key < message_id {
                previous = Some(key)
            } else if key > message_id && next.is_none() {
                next = Some(key)
            }
            let mut message: serde_json::Value = serde_json::from_str(&data)?;
            message["id"] = key.into();
            messages.push(ws_message_preview(message));
        }
        Ok(Some(
            serde_json::json!({"id":id,"message_id":message_id,"previous":previous,"next":next,"messages":messages}),
        ))
    }
    pub fn ws_jsonrpc_related(
        &self,
        id: u64,
        message_id: i64,
        entry: Option<usize>,
    ) -> Result<Option<serde_json::Value>> {
        let Some(source) = self.ws_message(id, message_id)? else {
            return Ok(None);
        };
        let Some(entries) = crate::jsonrpc::parse(&source) else {
            return Ok(Some(
                serde_json::json!({"supported":false,"reason":"Нужно полное исходное сообщение JSON-RPC 2.0: один объект или пакет из 1–256 элементов."}),
            ));
        };
        let selected = entry.unwrap_or_else(|| {
            entries
                .iter()
                .find(|e| {
                    e.envelope
                        .as_ref()
                        .and_then(|e| e.id.as_ref())
                        .is_some_and(|id| id.kind != "null")
                })
                .map_or(0, |e| e.index)
        });
        let metadata:Vec<_>=entries.iter().map(|e|{
            let envelope=e.envelope.as_ref();let identity=envelope.and_then(|e|e.id.as_ref());
            serde_json::json!({"index":e.index,"valid":envelope.is_some(),"request":envelope.is_some_and(|e|e.method.is_some()),"method":envelope.and_then(|e|e.method.as_ref()).map(|s|s.chars().take(160).collect::<String>()),"has_id":identity.is_some(),"id_kind":identity.map(|i|i.kind),"id_value":identity.map(|i|&i.value),"correlatable":identity.is_some_and(|i|i.kind!="null")})
        }).collect();
        let unsupported = |reason: &str| {
            Some(
                serde_json::json!({"supported":false,"reason":reason,"entries":metadata,"selected":selected}),
            )
        };
        let Some(envelope) = entries.get(selected).and_then(|e| e.envelope.as_ref()) else {
            return Ok(unsupported(
                "Элемент недоступен или не является однозначным объектом JSON-RPC 2.0.",
            ));
        };
        let Some(identity) = envelope.id.as_ref() else {
            return Ok(unsupported("Уведомление без ID не предполагает ответа."));
        };
        if identity.kind == "null" {
            return Ok(unsupported(
                "ID null не связывается автоматически: он также используется для ответов с неизвестным ID.",
            ));
        }
        let direction = if envelope.method.is_some() {
            source["direction"].as_str().unwrap()
        } else if source["direction"] == "sent" {
            "received"
        } else {
            "sent"
        };
        let mut statement = self
            .0
            .prepare("SELECT id,data FROM ws_messages WHERE exchange_id=? ORDER BY id")?;
        let mut rows = statement.query([i64::try_from(id)?])?;
        let (mut commands, mut responses) = (Vec::new(), Vec::new());
        let (mut command_count, mut response_count, mut inspected) = (0u64, 0u64, 0u64);
        let (mut command_id, mut response_id, mut command_time, mut response_time) =
            (0i64, 0i64, None, None);
        while let Some(row) = rows.next()? {
            inspected += 1;
            let key: i64 = row.get(0)?;
            let message: serde_json::Value = serde_json::from_str(&row.get::<_, String>(1)?)?;
            let Some(candidates) = crate::jsonrpc::parse(&message) else {
                continue;
            };
            for candidate in candidates {
                let Some(value) = candidate.envelope else {
                    continue;
                };
                if value
                    .id
                    .as_ref()
                    .is_none_or(|i| i.kind == "null" || i.key != identity.key)
                {
                    continue;
                }
                let command = value.method.is_some();
                if (message["direction"] == direction) != command {
                    continue;
                }
                let record = serde_json::json!({"id":key,"entry":candidate.index,"time":message["time"],"direction":message["direction"],"method":value.method.map(|s|s.chars().take(160).collect::<String>())});
                if command {
                    command_count += 1;
                    command_id = key;
                    command_time = message["time"].as_u64();
                    if commands.len() < 20 {
                        commands.push(record)
                    }
                } else {
                    response_count += 1;
                    response_id = key;
                    response_time = message["time"].as_u64();
                    if responses.len() < 20 {
                        responses.push(record)
                    }
                }
            }
        }
        let unique = command_count == 1 && response_count == 1 && command_id < response_id;
        let status = if unique {
            "matched"
        } else if command_count > 1
            || response_count > 1
            || (command_count == 1 && response_count == 1)
        {
            "ambiguous"
        } else {
            "missing"
        };
        let latency = if unique {
            command_time
                .zip(response_time)
                .and_then(|(a, b)| b.checked_sub(a))
        } else {
            None
        };
        Ok(Some(
            serde_json::json!({"supported":true,"entries":metadata,"selected":selected,"id_kind":identity.kind,"id_value":identity.value,"command_count":command_count,"response_count":response_count,"commands":commands,"responses":responses,"status":status,"latency_ms":latency,"inspected":inspected}),
        ))
    }
    pub fn ws_cdp_related(&self, id: u64, message_id: i64) -> Result<Option<serde_json::Value>> {
        self.ws_related(id, message_id, false)
    }
    pub fn ws_socketio_related(
        &self,
        id: u64,
        message_id: i64,
    ) -> Result<Option<serde_json::Value>> {
        self.ws_related(id, message_id, true)
    }
    fn ws_related(
        &self,
        id: u64,
        message_id: i64,
        socketio: bool,
    ) -> Result<Option<serde_json::Value>> {
        struct Envelope {
            id: String,
            session: Option<String>,
            method: Option<String>,
            binary: bool,
        }
        let parse = |message: &serde_json::Value| -> Option<Envelope> {
            if !matches!(message["direction"].as_str()?, "sent" | "received") {
                return None;
            }
            if socketio {
                let packet = crate::socketio::packet_from_message(message)?;
                Some(Envelope {
                    id: packet.ack?,
                    session: Some(packet.namespace),
                    method: packet.event.map(|event| event.value),
                    binary: packet.binary,
                })
            } else {
                let envelope = crate::cdp_related::parse(message)?;
                Some(Envelope {
                    id: envelope.id?.to_string(),
                    session: envelope.session,
                    method: envelope.method,
                    binary: false,
                })
            }
        };
        let Some(source) = self.ws_message(id, message_id)? else {
            return Ok(None);
        };
        let Some(envelope) = parse(&source) else {
            return Ok(Some(
                serde_json::json!({"supported":false,"reason":if socketio {"Нужен полный текстовый заголовок Socket.IO EVENT / ACK с ID подтверждения. Событие без ID не запрашивает ACK; бинарные вложения не разбираются."}else{"Нужно полное сообщение CDP с однозначными полями и числовым ID; события без ID не имеют ответа."}}),
            ));
        };
        let command_direction = if envelope.method.is_some() {
            source["direction"].as_str().unwrap()
        } else if source["direction"] == "sent" {
            "received"
        } else {
            "sent"
        };
        let mut statement = self
            .0
            .prepare("SELECT id,data FROM ws_messages WHERE exchange_id=? ORDER BY id")?;
        let mut rows = statement.query([i64::try_from(id)?])?;
        let (mut commands, mut responses) = (Vec::new(), Vec::new());
        let (mut command_count, mut response_count, mut inspected) = (0u64, 0u64, 0u64);
        let (mut command_id, mut response_id, mut command_time, mut response_time) =
            (0i64, 0i64, None, None);
        while let Some(row) = rows.next()? {
            inspected += 1;
            let key: i64 = row.get(0)?;
            let message: serde_json::Value = serde_json::from_str(&row.get::<_, String>(1)?)?;
            let Some(candidate) = parse(&message) else {
                continue;
            };
            if candidate.id != envelope.id || candidate.session != envelope.session {
                continue;
            }
            let command = candidate.method.is_some();
            if (message["direction"] == command_direction) != command {
                continue;
            }
            let entry = serde_json::json!({"id":key,"time":message["time"],"method":candidate.method,"direction":message["direction"],"binary_header":candidate.binary});
            let mut entry = entry;
            if !socketio {
                entry.as_object_mut().unwrap().remove("binary_header");
            }
            if command {
                command_count += 1;
                command_id = key;
                command_time = message["time"].as_u64();
                if commands.len() < 20 {
                    commands.push(entry);
                }
            } else {
                response_count += 1;
                response_id = key;
                response_time = message["time"].as_u64();
                if responses.len() < 20 {
                    responses.push(entry);
                }
            }
        }
        let unique = command_count == 1 && response_count == 1 && command_id < response_id;
        let status = if unique {
            "matched"
        } else if command_count > 1
            || response_count > 1
            || (command_count == 1 && response_count == 1)
        {
            "ambiguous"
        } else {
            "missing"
        };
        let mut result = serde_json::json!({"supported":true,"status":status,"inspected":inspected,"pair":if unique {Some(if envelope.method.is_some(){response_id}else{command_id})}else{None},"latency_ms":if unique{response_time.zip(command_time).and_then(|(end,start)|end.checked_sub(start))}else{None}});
        let sides = if socketio {
            serde_json::json!({"ack_id":envelope.id,"namespace":envelope.session.unwrap(),"events":commands,"acks":responses,"event_count":command_count,"ack_count":response_count,"headers_only":true})
        } else {
            serde_json::json!({"rpc_id":envelope.id,"session_id":envelope.session,"commands":commands,"responses":responses,"command_count":command_count,"response_count":response_count})
        };
        result
            .as_object_mut()
            .unwrap()
            .extend(sides.as_object().unwrap().clone());
        Ok(Some(result))
    }
    // Requested explicitly, not on the one-second message polling path. A single
    // grouped scan covers all archived messages, independent of viewer filters.
    pub fn ws_socketio_events(&self, id: u64) -> Result<Option<serde_json::Value>> {
        let key = i64::try_from(id)?;
        let exists:bool=self.0.query_row("SELECT EXISTS(SELECT 1 FROM ws_sessions s JOIN traffic t ON t.id=s.exchange_id WHERE s.exchange_id=?)",[key],|row|row.get(0))?;
        if !exists {
            return Ok(None);
        }
        let total: i64 = self.0.query_row(
            "SELECT count(*) FROM ws_messages WHERE exchange_id=?",
            [key],
            |row| row.get(0),
        )?;
        let mut statement=self.0.prepare("WITH extracted AS MATERIALIZED (SELECT librium_socketio_key(data) AS value,json_extract(data,'$.direction') AS direction FROM ws_messages WHERE exchange_id=?1), grouped AS (SELECT value,count(*) AS n,sum(direction='sent') AS sent,sum(direction='received') AS received FROM extracted WHERE value IS NOT NULL GROUP BY value) SELECT value,n,sent,received,count(*) OVER (),sum(n) OVER () FROM grouped ORDER BY n DESC,value ASC LIMIT 100")?;
        let mut records = statement.query(params![key])?;
        let (mut rows, mut matched, mut distinct, mut shown) = (Vec::new(), 0i64, 0i64, 0i64);
        while let Some(record) = records.next()? {
            let mut value: serde_json::Value = serde_json::from_str(&record.get::<_, String>(0)?)?;
            let count: i64 = record.get(1)?;
            shown += count;
            distinct = record.get(4)?;
            matched = record.get(5)?;
            value["count"] = count.into();
            value["sent"] = record.get::<_, i64>(2)?.into();
            value["received"] = record.get::<_, i64>(3)?.into();
            rows.push(value);
        }
        Ok(Some(
            serde_json::json!({"id":id,"total":total,"matched":matched,"excluded":total-matched,"distinct":distinct,"other":matched-shown,"rows":rows}),
        ))
    }
    pub fn ws_field_values(
        &self,
        id: u64,
        field: &crate::ws_fields::FieldSpec,
    ) -> Result<Option<serde_json::Value>> {
        use base64::{Engine, prelude::BASE64_STANDARD};
        let width = field
            .width()
            .ok_or_else(|| anyhow::anyhow!("Invalid field definition"))?;
        let key = i64::try_from(id)?;
        let exists:bool=self.0.query_row("SELECT EXISTS(SELECT 1 FROM ws_sessions s JOIN traffic t ON t.id=s.exchange_id WHERE s.exchange_id=?)",[key],|row|row.get(0))?;
        if !exists {
            return Ok(None);
        }
        let total: i64 = self.0.query_row(
            "SELECT count(*) FROM ws_messages WHERE exchange_id=?",
            [key],
            |row| row.get(0),
        )?;
        let mut statement=self.0.prepare("WITH extracted AS MATERIALIZED (SELECT librium_field_scalar(data,?2,?3,?4,?5) AS value,json_extract(data,'$.direction') AS direction FROM ws_messages WHERE exchange_id=?1), grouped AS (SELECT value,count(*) AS n,sum(direction='sent') AS sent,sum(direction='received') AS received FROM extracted WHERE value IS NOT NULL GROUP BY value) SELECT value,n,sent,received,count(*) OVER (),sum(n) OVER () FROM grouped ORDER BY n DESC,value ASC LIMIT 100")?;
        let mut records = statement.query(params![
            key,
            field.offset as i64,
            width as i64,
            field.kind,
            field.endian
        ])?;
        let (mut rows, mut matched, mut distinct, mut shown) = (Vec::new(), 0i64, 0i64, 0i64);
        while let Some(record) = records.next()? {
            let value: Vec<u8> = record.get(0)?;
            let count: i64 = record.get(1)?;
            shown += count;
            distinct = record.get(4)?;
            matched = record.get(5)?;
            rows.push(serde_json::json!({"base64":BASE64_STANDARD.encode(value),"count":count,"sent":record.get::<_,i64>(2)?,"received":record.get::<_,i64>(3)?}));
        }
        Ok(Some(
            serde_json::json!({"id":id,"field":field,"total":total,"matched":matched,"excluded":total-matched,"distinct":distinct,"other":matched-shown,"rows":rows}),
        ))
    }
    pub fn ws_json_values(&self, id: u64, pointer: &str) -> Result<Option<serde_json::Value>> {
        if crate::json_pointer::tokens(pointer).is_none() {
            bail!("Invalid JSON pointer");
        }
        let key = i64::try_from(id)?;
        let exists:bool=self.0.query_row("SELECT EXISTS(SELECT 1 FROM ws_sessions s JOIN traffic t ON t.id=s.exchange_id WHERE s.exchange_id=?)",[key],|row|row.get(0))?;
        if !exists {
            return Ok(None);
        }
        let total: i64 = self.0.query_row(
            "SELECT count(*) FROM ws_messages WHERE exchange_id=?",
            [key],
            |row| row.get(0),
        )?;
        let mut statement=self.0.prepare("WITH extracted AS MATERIALIZED (SELECT librium_json_scalar(data,?2) AS value,json_extract(data,'$.direction') AS direction FROM ws_messages WHERE exchange_id=?1), grouped AS (SELECT value,count(*) AS n,sum(direction='sent') AS sent,sum(direction='received') AS received FROM extracted WHERE value IS NOT NULL GROUP BY value) SELECT value,n,sent,received,count(*) OVER (),sum(n) OVER () FROM grouped ORDER BY n DESC,value ASC LIMIT 100")?;
        let mut records = statement.query(params![key, pointer])?;
        let (mut rows, mut matched, mut distinct, mut shown) = (Vec::new(), 0i64, 0i64, 0i64);
        while let Some(record) = records.next()? {
            let mut value: serde_json::Value = serde_json::from_str(&record.get::<_, String>(0)?)?;
            let count: i64 = record.get(1)?;
            shown += count;
            distinct = record.get(4)?;
            matched = record.get(5)?;
            value["count"] = count.into();
            value["sent"] = record.get::<_, i64>(2)?.into();
            value["received"] = record.get::<_, i64>(3)?.into();
            rows.push(value);
        }
        Ok(Some(
            serde_json::json!({"id":id,"pointer":pointer,"total":total,"matched":matched,"excluded":total-matched,"distinct":distinct,"other":matched-shown,"rows":rows}),
        ))
    }
    pub fn ws_profile(&self, id: u64) -> Result<Option<serde_json::Value>> {
        #[derive(Serialize)]
        struct Group {
            kind: crate::ws_profile::Kind,
            count: u64,
            sent: u64,
            received: u64,
            unknown: u64,
            examples: Vec<serde_json::Value>,
        }
        let key = i64::try_from(id)?;
        let summary:Option<String>=self.0.query_row("SELECT t.summary FROM ws_sessions s JOIN traffic t ON t.id=s.exchange_id WHERE s.exchange_id=?",[key],|r|r.get(0)).optional()?;
        let Some(summary) = summary else {
            return Ok(None);
        };
        let through: i64 = self.0.query_row(
            "SELECT coalesce(max(id),0) FROM ws_messages WHERE exchange_id=?",
            [key],
            |r| r.get(0),
        )?;
        let mut statement = self
            .0
            .prepare("SELECT id,data FROM ws_messages WHERE exchange_id=? AND id<=? ORDER BY id")?;
        let mut rows = statement.query(params![key, through])?;
        let mut groups: Vec<Group> = Vec::new();
        let mut total = 0u64;
        while let Some(row) = rows.next()? {
            let message_id: i64 = row.get(0)?;
            let message: serde_json::Value = serde_json::from_str(&row.get::<_, String>(1)?)?;
            let evidence = crate::ws_profile::classify(&message);
            total += 1;
            let position = groups
                .iter()
                .position(|g| g.kind == evidence.kind)
                .unwrap_or_else(|| {
                    groups.push(Group {
                        kind: evidence.kind,
                        count: 0,
                        sent: 0,
                        received: 0,
                        unknown: 0,
                        examples: Vec::new(),
                    });
                    groups.len() - 1
                });
            let group = &mut groups[position];
            group.count += 1;
            let direction = message["direction"].as_str().unwrap_or("unknown");
            let direction = if direction == "sent" {
                group.sent += 1;
                "sent"
            } else if direction == "received" {
                group.received += 1;
                "received"
            } else {
                group.unknown += 1;
                "unknown"
            };
            if group
                .examples
                .iter()
                .filter(|m| m["direction"] == direction)
                .count()
                < 2
            {
                group.examples.push(serde_json::json!({"id":message_id,"direction":direction,"kind":message["kind"],"entry":evidence.entry}));
            }
        }
        groups.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.kind.cmp(&b.kind)));
        Ok(Some(
            serde_json::json!({"id":id,"summary":serde_json::from_str::<serde_json::Value>(&summary)?,"total":total,"through":through,"groups":groups}),
        ))
    }
    pub fn ws_summary(&self, id: u64) -> Result<Option<serde_json::Value>> {
        let key = i64::try_from(id)?;
        let session:Option<(String,String,Option<String>,Option<String>)>=self.0.query_row(
            "SELECT t.summary,s.state,s.error,s.close_info FROM ws_sessions s JOIN traffic t ON t.id=s.exchange_id WHERE s.exchange_id=?",[key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))
        ).optional()?;
        let Some((summary, state, error, close)) = session else {
            return Ok(None);
        };
        // Carry metadata through the window sort, not the base64 payloads.
        let mut statement = self.0.prepare(
            "WITH messages AS (
                SELECT id,json_extract(data,'$.direction') AS direction,json_extract(data,'$.kind') AS kind,
                    max(0.0,CAST(json_extract(data,'$.size') AS REAL)) AS size,
                    length(json_extract(data,'$.base64'))/4*3-CASE WHEN json_extract(data,'$.base64') LIKE '%==' THEN 2 WHEN json_extract(data,'$.base64') LIKE '%=' THEN 1 ELSE 0 END AS stored_bytes,
                    coalesce(json_extract(data,'$.truncated'),0) AS truncated,
                    json_extract(data,'$.time') AS time
                FROM ws_messages WHERE exchange_id=?
            ), intervals AS (
                SELECT *,lag(time) OVER (PARTITION BY direction,kind ORDER BY id) AS previous,
                    lag(id) OVER (PARTITION BY direction,kind ORDER BY id) AS previous_id FROM messages
            ), ranked AS (
                SELECT *,row_number() OVER (PARTITION BY direction,kind ORDER BY CASE WHEN time>=previous THEN time-previous END DESC,id) AS gap_rank FROM intervals
            )
            SELECT direction,kind,count(*),total(size),total(stored_bytes),
                sum(truncated),min(time),max(time),
                sum(CASE WHEN time>=previous THEN 1 ELSE 0 END),
                sum(CASE WHEN time<previous THEN 1 ELSE 0 END),
                sum(CASE WHEN time=previous THEN 1 ELSE 0 END),
                min(CASE WHEN time>=previous THEN time-previous END),
                avg(CASE WHEN time>=previous THEN time-previous END),
                max(CASE WHEN time>=previous THEN time-previous END),
                max(CASE WHEN gap_rank=1 AND time>=previous THEN previous_id END),
                max(CASE WHEN gap_rank=1 AND time>=previous THEN id END)
            FROM ranked GROUP BY direction,kind ORDER BY direction,kind",
        )?;
        let rows = statement.query_map([key], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                WsTotals {
                    count: r.get(2)?,
                    bytes: r.get(3)?,
                    stored_bytes: r.get(4)?,
                    truncated: r.get(5)?,
                },
                r.get::<_, f64>(6)?,
                r.get::<_, f64>(7)?,
                serde_json::json!({
                    "count": r.get::<_, i64>(8)?, "backwards": r.get::<_, i64>(9)?,
                    "zero": r.get::<_, i64>(10)?, "min_ms": r.get::<_, Option<f64>>(11)?,
                    "mean_ms": r.get::<_, Option<f64>>(12)?, "max_ms": r.get::<_, Option<f64>>(13)?,
                    "longest": r.get::<_, Option<i64>>(14)?.zip(r.get::<_, Option<i64>>(15)?).map(|(before,after)|serde_json::json!({"before":before,"after":after}))
                }),
            ))
        })?;
        let (mut sent, mut received, mut total) = (
            WsTotals::default(),
            WsTotals::default(),
            WsTotals::default(),
        );
        let (mut first, mut last): (Option<f64>, Option<f64>) = (None, None);
        let mut kinds = Vec::new();
        for row in rows {
            let (direction, kind, stats, start, end, intervals) = row?;
            total.add(&stats);
            match direction.as_str() {
                "sent" => sent.add(&stats),
                "received" => received.add(&stats),
                _ => {}
            }
            first = Some(first.map_or(start, |v| v.min(start)));
            last = Some(last.map_or(end, |v| v.max(end)));
            kinds.push(serde_json::json!({"direction":direction,"kind":kind,"stats":stats,"intervals":intervals}));
        }
        let close = close
            .map(|s| serde_json::from_str::<serde_json::Value>(&s))
            .transpose()?;
        Ok(Some(
            serde_json::json!({"id":id,"summary":serde_json::from_str::<serde_json::Value>(&summary)?,"state":state,"error":error,"close":close,"sent":sent,"received":received,"total":total,"kinds":kinds,"first_time":first,"last_time":last,"measured_at":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64}),
        ))
    }
    pub fn ws_export_page(
        &self,
        id: u64,
        after: i64,
        through: Option<i64>,
    ) -> Result<Option<serde_json::Value>> {
        let key = i64::try_from(id)?;
        let detail: Option<String> = self
            .0
            .query_row(
                "SELECT detail FROM traffic WHERE id=? AND kind='ws'",
                [key],
                |r| r.get(0),
            )
            .optional()?;
        let Some(detail) = detail else {
            return Ok(None);
        };
        let initial = through.is_none();
        let through = match through {
            Some(value) => value,
            None => self.0.query_row(
                "SELECT coalesce(max(id),0) FROM ws_messages WHERE exchange_id=?",
                [key],
                |r| r.get(0),
            )?,
        };
        let session = if initial {
            let (state, error, close): (String, Option<String>, Option<String>) = self
                .0
                .query_row(
                    "SELECT state,error,close_info FROM ws_sessions WHERE exchange_id=?",
                    [key],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?
                .unwrap_or(("not_recorded".into(), None, None));
            let close = close
                .map(|s| serde_json::from_str::<serde_json::Value>(&s))
                .transpose()?;
            let total: i64 = self.0.query_row(
                "SELECT count(*) FROM ws_messages WHERE exchange_id=? AND id<=?",
                params![key, through],
                |r| r.get(0),
            )?;
            Some(
                serde_json::json!({"version":1,"id":id,"exchange":serde_json::from_str::<serde_json::Value>(&detail)?,"state":state,"error":error,"close":close,"total":total,"through":through}),
            )
        } else {
            None
        };
        let mut statement=self.0.prepare("SELECT id,data FROM ws_messages WHERE exchange_id=? AND id>? AND id<=? ORDER BY id LIMIT 50")?;
        let rows = statement.query_map(params![key, after, through], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut messages = Vec::new();
        let mut next = after;
        for row in rows {
            let (id, data) = row?;
            let mut message: serde_json::Value = serde_json::from_str(&data)?;
            message["id"] = id.into();
            messages.push(message);
            next = id;
        }
        let more: bool = self.0.query_row(
            "SELECT EXISTS(SELECT 1 FROM ws_messages WHERE exchange_id=? AND id>? AND id<=?)",
            params![key, next, through],
            |r| r.get(0),
        )?;
        Ok(Some(
            serde_json::json!({"session":session,"messages":messages,"through":through,"next":next,"more":more}),
        ))
    }
    pub fn ws_search(
        &self,
        id: u64,
        before: Option<i64>,
        query: &str,
        kind: &str,
    ) -> Result<serde_json::Value> {
        self.ws_search_format(id, before, query, kind, "")
    }
    pub fn ws_search_format(
        &self,
        id: u64,
        before: Option<i64>,
        query: &str,
        kind: &str,
        format: &str,
    ) -> Result<serde_json::Value> {
        self.ws_search_direction(id, before, query, kind, format, "")
    }
    pub fn ws_search_direction(
        &self,
        id: u64,
        before: Option<i64>,
        query: &str,
        kind: &str,
        format: &str,
        direction: &str,
    ) -> Result<serde_json::Value> {
        self.ws_search_filter(
            id,
            before,
            WsFilter {
                field_exact: None,
                socketio_exact: None,
                query,
                kind,
                format,
                direction,
                pointer: "",
            },
        )
    }
    pub fn ws_search_filter(
        &self,
        id: u64,
        before: Option<i64>,
        filter: WsFilter<'_>,
    ) -> Result<serde_json::Value> {
        self.ws_search_exact(id, before, filter, None)
    }
    pub fn ws_search_exact(
        &self,
        id: u64,
        before: Option<i64>,
        filter: WsFilter<'_>,
        exact: Option<&crate::json_pointer::ScalarFilter>,
    ) -> Result<serde_json::Value> {
        let prepared = PreparedWsFilter::new(filter, exact)?;
        let filter = format!("exchange_id=?1 AND {}", prepared.predicate);
        let session: Option<(String, Option<String>, Option<String>)> = self
            .0
            .query_row(
                "SELECT state,error,close_info FROM ws_sessions WHERE exchange_id=?",
                [id as i64],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let total: i64 = self.0.query_row(
            "SELECT count(*) FROM ws_messages WHERE exchange_id=?",
            [id as i64],
            |r| r.get(0),
        )?;
        let matched: i64 = self.0.query_row(
            &format!("SELECT count(*) FROM ws_messages WHERE {filter}"),
            params_from_iter(prepared.params(id as i64, None)),
            |r| r.get(0),
        )?;
        let (state, error, close) = session.unwrap_or(("not_recorded".into(), None, None));
        let close = close
            .map(|value| serde_json::from_str::<serde_json::Value>(&value))
            .transpose()?;
        let response = |messages: Vec<serde_json::Value>, older: bool| serde_json::json!({"messages":messages,"total":total,"matched":matched,"state":state,"error":error,"close":close,"older":older});
        // The count covers this same read snapshot and all filters. When it is
        // zero, fetching a page would decode the archive again to return none.
        if matched == 0 {
            return Ok(response(Vec::new(), false));
        }
        let mut statement = self.0.prepare(&format!(
            "SELECT id,data FROM ws_messages WHERE {filter} AND id<?8 ORDER BY id DESC LIMIT 100"
        ))?;
        let records = statement.query_map(
            params_from_iter(prepared.params(id as i64, Some(before.unwrap_or(i64::MAX)))),
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
        )?;
        let mut messages = Vec::new();
        for record in records {
            let (id, json) = record?;
            let mut value: serde_json::Value = serde_json::from_str(&json)?;
            value["id"] = id.into();
            messages.push(prepared.annotate(value));
        }
        messages.reverse();
        let oldest = messages.first().and_then(|v| v["id"].as_i64()).unwrap_or(0);
        let older: bool = self.0.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM ws_messages WHERE {filter} AND id<?8)"),
            params_from_iter(prepared.params(id as i64, Some(oldest))),
            |r| r.get(0),
        )?;
        Ok(response(messages, older))
    }
    pub fn ws_archive_search(&self, prepared: &PreparedArchiveWs) -> Result<serde_json::Value> {
        let query = &prepared.query;
        let filter = &prepared.filter;
        let newest: i64 =
            self.0
                .query_row("SELECT coalesce(max(id),0) FROM ws_messages", [], |r| {
                    r.get(0)
                })?;
        let through = query.through.unwrap_or(newest).min(newest);
        let mut values = filter.params(0, query.before);
        values.extend([
            Value::Integer(through),
            query
                .capture_context
                .clone()
                .map(Value::Text)
                .unwrap_or(Value::Null),
            query
                .source
                .map(|source| {
                    Value::Text(
                        serde_json::to_value(source)
                            .unwrap()
                            .as_str()
                            .unwrap()
                            .to_owned(),
                    )
                })
                .unwrap_or(Value::Null),
            Value::Text(query.url.to_lowercase()),
        ]);
        // Materialize IDs only; decoding and fetching previews must not copy the
        // entire payload archive into SQLite's temporary result.
        let scope = "FROM ws_messages m JOIN ws_sessions s ON s.exchange_id=m.exchange_id JOIN traffic t ON t.id=m.exchange_id
            WHERE m.id<=?13 AND (?14 IS NULL OR json_extract(t.summary,'$.capture_context')=?14)
            AND (?15 IS NULL OR coalesce(json_extract(t.summary,'$.source'),'proxy')=?15)
            AND (?16='' OR instr(t.url,?16)>0)";
        let total: i64 = self.0.query_row(
            &format!("SELECT count(*) {scope} AND ?1=0"),
            params_from_iter(values.iter()),
            |r| r.get(0),
        )?;
        let sql = format!("WITH matched AS MATERIALIZED (SELECT m.id,m.exchange_id {scope} AND ({})),
            page AS (SELECT * FROM matched WHERE ?8 IS NULL OR id<?8 ORDER BY id DESC LIMIT 101),
            stats AS (SELECT count(*) AS matched FROM matched)
            SELECT stats.matched,p.id,p.exchange_id,w.data,t.summary FROM stats
            LEFT JOIN page p ON 1=1 LEFT JOIN ws_messages w ON w.id=p.id LEFT JOIN traffic t ON t.id=p.exchange_id
            ORDER BY p.id DESC", filter.predicate);
        let mut statement = self.0.prepare(&sql)?;
        let records = statement.query_map(params_from_iter(values.iter()), |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, Option<i64>>(1)?,
                r.get::<_, Option<i64>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        })?;
        let mut matched = 0;
        let mut matches = Vec::new();
        for record in records {
            let (count, id, exchange_id, data, summary) = record?;
            matched = count;
            let Some(id) = id else { continue };
            let mut message = filter.annotate(serde_json::from_str(&data.unwrap())?);
            message["id"] = id.into();
            if filter.format == "hex" && message["match_offset"].is_number() {
                message["match_length"] = (filter.query.len() / 2).into();
            }
            let message = ws_message_preview(message);
            matches.push(serde_json::json!({"exchange_id":exchange_id,"exchange":serde_json::from_str::<serde_json::Value>(&summary.unwrap())?,"message":message}));
        }
        let older = matches.len() > 100;
        matches.truncate(100);
        let next_before = matches.last().map(|row| row["message"]["id"].clone());
        Ok(
            serde_json::json!({"matches":matches,"total":total,"matched":matched,"through":through,"older":older,"next_before":next_before}),
        )
    }
    pub fn clear(&mut self) -> Result<()> {
        let tx = self.0.transaction()?;
        tx.execute_batch("DELETE FROM ws_messages; DELETE FROM ws_sessions; DELETE FROM traffic;")?;
        tx.commit()?;
        Ok(())
    }
    pub fn capture_contexts(&self, query: &ContextsQuery) -> Result<serde_json::Value> {
        if !query.valid() {
            bail!("Invalid context catalogue query");
        }
        let newest: i64 =
            self.0
                .query_row("SELECT coalesce(max(id),0) FROM traffic", [], |row| {
                    row.get(0)
                })?;
        let through = query
            .through
            .map(|value| value as i64)
            .unwrap_or(newest)
            .min(newest);
        let before = query
            .before
            .map(|value| Value::Integer(value as i64))
            .unwrap_or(Value::Null);
        let grouped = "WITH grouped AS (
            SELECT json_extract(summary,'$.capture_context') AS context_id, count(*) AS total,
                sum(kind='http') AS http, sum(kind='ws') AS ws, min(id) AS first_id, max(id) AS last_id
            FROM traffic INDEXED BY traffic_context_catalogue
            WHERE id<=?1 AND json_extract(summary,'$.capture_context') IS NOT NULL
            GROUP BY json_extract(summary,'$.capture_context'))";
        let total: i64 = self.0.query_row(
            &format!("{grouped} SELECT count(*) FROM grouped"),
            [through],
            |row| row.get(0),
        )?;
        let without_context: i64 = self.0.query_row("SELECT count(*) FROM traffic WHERE id<=? AND json_extract(summary,'$.capture_context') IS NULL", [through], |row| row.get(0))?;
        let labelled = format!("{grouped}, labelled AS (
            SELECT g.* FROM grouped g JOIN traffic t ON t.id=g.last_id
            WHERE instr(librium_lower(coalesce(json_extract(t.summary,'$.capture_target'),'Контекст захвата')),?2)>0)");
        let search = query.search.to_lowercase();
        let matched: i64 = if search.is_empty() {
            total
        } else {
            self.0.query_row(
                &format!("{labelled} SELECT count(*) FROM labelled"),
                params![through, search],
                |row| row.get(0),
            )?
        };
        let (base, name, cursor, values) = if search.is_empty() {
            (
                grouped.to_owned(),
                "grouped",
                "?2",
                vec![Value::Integer(through), before],
            )
        } else {
            (
                labelled,
                "labelled",
                "?3",
                vec![Value::Integer(through), Value::Text(search), before],
            )
        };
        let sql = format!("{base}, page AS MATERIALIZED (
            SELECT * FROM {name} WHERE {cursor} IS NULL OR last_id<{cursor} ORDER BY last_id DESC LIMIT 101)
            SELECT p.context_id,p.total,p.http,p.ws,p.first_id,p.last_id,f.summary,l.summary
            FROM page p JOIN traffic f ON f.id=p.first_id JOIN traffic l ON l.id=p.last_id ORDER BY p.last_id DESC");
        let mut statement = self.0.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(values), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
            ))
        })?;
        let mut contexts = Vec::new();
        for row in rows {
            let (id, total, http, ws, first_id, last_id, first, last) = row?;
            let first: Summary = serde_json::from_str(&first)?;
            let last: Summary = serde_json::from_str(&last)?;
            contexts.push(serde_json::json!({"id":id,"label":last.capture_target.unwrap_or_else(||"Контекст захвата".into()),"source":last.source,"total":total,"http":http,"ws":ws,"first_id":first_id,"last_id":last_id,"first_time":first.time,"last_time":last.time}));
        }
        let older = contexts.len() > 100;
        contexts.truncate(100);
        let next_before = if older {
            contexts.last().and_then(|row| row["last_id"].as_u64())
        } else {
            None
        };
        Ok(
            serde_json::json!({"contexts":contexts,"total":total,"matched":matched,"without_context":without_context,"through":through,"older":older,"next_before":next_before}),
        )
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
        if let Some(context) = &search.capture_context {
            if !crate::capture::valid_context(context) {
                bail!("Invalid capture context");
            }
            predicates.push("json_extract(summary,'$.capture_context')=?".into());
            values.push(context.clone().into());
        }
        if !search.traffic_type.is_empty() {
            if !["http", "ws"].contains(&search.traffic_type.as_str()) {
                bail!("Invalid traffic type");
            }
            predicates.push("kind = ?".into());
            values.push(search.traffic_type.clone().into());
        }
        if let Some(source) = search.source {
            use crate::capture::Source;
            let value = match source {
                Source::Proxy => "proxy",
                Source::External => "external",
                Source::CdpNode => "cdp_node",
                Source::CdpChromium => "cdp_chromium",
            };
            predicates.push("json_extract(summary,'$.source') = ?".into());
            values.push(value.to_owned().into());
        }
        if !search.ws_role.is_empty() {
            if !["client", "server", "unknown"].contains(&search.ws_role.as_str()) {
                bail!("Invalid WebSocket role");
            }
            predicates.push("kind='ws'".into());
            if search.ws_role == "unknown" {
                predicates.push("json_extract(summary,'$.ws_role') IS NULL".into());
            } else {
                predicates.push("json_extract(summary,'$.ws_role')=?".into());
                values.push(search.ws_role.clone().into());
            }
        }
        if !search.method.is_empty() {
            predicates.push("method = ?".into());
            values.push(search.method.to_lowercase().into());
        }
        if !search.status.is_empty() {
            if search.status == "pending" {
                predicates.push(
                    "status IS NULL AND coalesce(json_extract(summary,'$.error'),'')=''".into(),
                );
            } else if search.status == "error" {
                predicates.push("coalesce(json_extract(summary,'$.error'),'')<>''".into());
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
                "capture_target" => "capture_target",
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

fn register_ws_functions(db: &Connection) -> Result<()> {
    db.create_scalar_function(
        "librium_ws_content_match",
        2,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        |context| {
            let data: String = context.get(0)?;
            let kind = context.get_or_create_aux(1, |raw| {
                Ok::<_, rusqlite::Error>(raw.as_str().ok().and_then(crate::ws_profile::Kind::parse))
            })?;
            Ok(kind.as_ref().is_some_and(|kind| {
                serde_json::from_str::<serde_json::Value>(&data)
                    .is_ok_and(|message| crate::ws_profile::classify(&message).kind == kind)
            }))
        },
    )?;
    db.create_scalar_function(
        "librium_jsonrpc_match",
        3,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        |context| {
            let data: String = context.get(0)?;
            let format: String = context.get(1)?;
            let query: String = context.get(2)?;
            let id = if format == "jsonrpc_id" {
                Some(context.get_or_create_aux(2, |raw| {
                    Ok::<_, rusqlite::Error>(
                        raw.as_str().ok().and_then(crate::jsonrpc::IdQuery::new),
                    )
                })?)
            } else {
                None
            };
            let id = id.as_ref().and_then(|value| value.as_ref().as_ref());
            Ok(
                serde_json::from_str::<serde_json::Value>(&data).is_ok_and(|message| {
                    !crate::jsonrpc::matching_entries(
                        &message,
                        (format == "jsonrpc_method").then_some(query.as_str()),
                        id,
                    )
                    .is_empty()
                }),
            )
        },
    )?;
    db.create_scalar_function(
        "librium_lower",
        1,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        |context| {
            Ok(context
                .get::<Option<String>>(0)?
                .map(|text| text.to_lowercase()))
        },
    )?;
    db.create_scalar_function(
        "librium_field_scalar",
        5,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        |context| {
            let data: String = context.get(0)?;
            let offset: i64 = context.get(1)?;
            let width: i64 = context.get(2)?;
            let kind: String = context.get(3)?;
            let endian: String = context.get(4)?;
            if offset < 0 || width < 1 {
                return Ok(None);
            }
            let variable = matches!(kind.as_str(), "bytes" | "utf8");
            let definition = crate::ws_fields::FieldSpec {
                kind,
                offset: offset as usize,
                endian,
                length: variable.then_some(width as usize),
            };
            Ok(serde_json::from_str::<serde_json::Value>(&data)
                .ok()
                .and_then(|message| crate::ws_fields::scalar(&message, &definition)))
        },
    )?;

    db.create_scalar_function(
        "librium_field_match",
        4,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        |context| {
            let data: String = context.get(0)?;
            let offset: i64 = context.get(1)?;
            let needle: Vec<u8> = context.get(2)?;
            let mode: String = context.get(3)?;
            Ok(offset >= 0
                && serde_json::from_str::<serde_json::Value>(&data).is_ok_and(|message| {
                    crate::ws_fields::matches(&message, offset as usize, &needle, &mode)
                }))
        },
    )?;

    db.create_scalar_function(
        "librium_socketio_key",
        1,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        |context| {
            let data: String = context.get(0)?;
            Ok(serde_json::from_str::<serde_json::Value>(&data)
                .ok()
                .and_then(|message| crate::socketio::from_message(&message))
                .and_then(|event| event.key()))
        },
    )?;

    db.create_scalar_function(
        "librium_socketio_match",
        2,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        |context| {
            let data: String = context.get(0)?;
            let query: String = context.get(1)?;
            Ok(serde_json::from_str::<serde_json::Value>(&data)
                .is_ok_and(|message| crate::socketio::matches(&message, &query)))
        },
    )?;

    db.create_scalar_function(
        "librium_json_scalar",
        2,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        |context| {
            let data: String = context.get(0)?;
            let pointer: String = context.get(1)?;
            Ok(serde_json::from_str::<serde_json::Value>(&data)
                .ok()
                .and_then(|message| crate::json_pointer::scalar_key(&message, &pointer)))
        },
    )?;
    db.create_scalar_function(
        "librium_json_field_match",
        3,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        |context| {
            let data: String = context.get(0)?;
            let pointer: String = context.get(1)?;
            let query: String = context.get(2)?;
            Ok(serde_json::from_str::<serde_json::Value>(&data)
                .is_ok_and(|message| crate::json_pointer::matches(&message, &pointer, &query)))
        },
    )?;
    db.create_scalar_function(
        "librium_cdp_match",
        3,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        |context| {
            let data: String = context.get(0)?;
            let format: String = context.get(1)?;
            let query: String = context.get(2)?;
            Ok(serde_json::from_str::<serde_json::Value>(&data)
                .is_ok_and(|message| crate::cdp_related::search_matches(&message, &format, &query)))
        },
    )?;
    db.create_scalar_function(
        "librium_msgpack_match",
        3,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        |context| {
            let encoded: Option<String> = context.get(0)?;
            let truncated: bool = context.get(1)?;
            let query: String = context.get(2)?;
            let text =
                crate::msgpack::search_text(encoded.as_deref().unwrap_or_default(), truncated);
            Ok(!text.is_empty() && text.to_lowercase().contains(&query.to_lowercase()))
        },
    )?;
    db.create_scalar_function(
        "librium_protobuf_match",
        3,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        |context| {
            let encoded: Option<String> = context.get(0)?;
            let truncated: bool = context.get(1)?;
            let query: String = context.get(2)?;
            let text =
                crate::protobuf::search_text(encoded.as_deref().unwrap_or_default(), truncated);
            Ok(!text.is_empty() && text.to_lowercase().contains(&query.to_lowercase()))
        },
    )?;
    db.create_scalar_function(
        "librium_hex_offset",
        2,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        |context| {
            let encoded: Option<String> = context.get(0)?;
            let query: String = context.get(1)?;
            Ok(
                crate::ws_search::hex_offset(encoded.as_deref().unwrap_or_default(), &query)
                    .map(|offset| offset as i64),
            )
        },
    )?;
    db.create_scalar_function(
        "librium_hex_mask_offset",
        2,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        |context| {
            let encoded: Option<String> = context.get(0)?;
            let prepared = context.get_or_create_aux(1, |raw| {
                Ok::<_, rusqlite::Error>(
                    raw.as_str()
                        .ok()
                        .and_then(crate::ws_search::MaskPattern::new),
                )
            })?;
            Ok(prepared
                .as_ref()
                .as_ref()
                .and_then(|pattern| pattern.offset(encoded.as_deref().unwrap_or_default()))
                .map(|offset| offset as i64))
        },
    )?;
    db.create_scalar_function(
        "librium_utf8_match",
        3,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        |context| {
            let encoded: Option<String> = context.get(0)?;
            let truncated: bool = context.get(1)?;
            let query: String = context.get(2)?;
            Ok(encoded
                .as_deref()
                .and_then(|value| crate::ws_search::utf8_text(value, truncated))
                .is_some_and(|text| crate::ws_search::contains(&text, &query)))
        },
    )?;
    db.create_scalar_function(
        "librium_text_match",
        2,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        |context| {
            let text: Option<String> = context.get(0)?;
            let query: String = context.get(1)?;
            Ok(text.is_some_and(|text| crate::ws_search::contains(&text, &query)))
        },
    )?;
    Ok(())
}
