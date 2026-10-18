//! Explicit CDP envelope matching. IDs are scoped to a WS connection and session.
use base64::{Engine, prelude::BASE64_STANDARD};
use serde_json::Value;

pub struct Envelope {
    pub id: Option<u64>,
    pub session: Option<String>,
    pub method: Option<String>,
}
pub fn parse(message: &Value) -> Option<Envelope> {
    parse_inner(message).filter(|envelope| envelope.id.is_some())
}
fn parse_inner(message: &Value) -> Option<Envelope> {
    if message["truncated"].as_bool() != Some(false)
        || !matches!(message["kind"].as_str()?, "TEXT" | "BINARY")
        || !matches!(message["direction"].as_str()?, "sent" | "received")
    {
        return None;
    }
    let encoded = message["base64"].as_str()?;
    if encoded.len() > 87384 {
        return None;
    }
    let bytes = BASE64_STANDARD.decode(encoded).ok()?;
    if bytes.len() > 65536 || message["size"].as_u64()? != bytes.len() as u64 {
        return None;
    }
    parse_text(std::str::from_utf8(&bytes).ok()?)
}
pub fn parse_text(text: &str) -> Option<Envelope> {
    if text.len() > 65536 {
        return None;
    }
    let crate::json_object::Object(members) = serde_json::from_str(text).ok()?;
    if let Some(error) = members.get("error") {
        let _: crate::json_object::Object<'_> = serde_json::from_str(error.get()).ok()?;
    }
    let value: Value = serde_json::from_str(text).ok()?;
    let object = value.as_object()?;
    if object.contains_key("jsonrpc") {
        return None;
    }
    let id = if object.contains_key("id") {
        Some(value["id"].as_u64().filter(|id| *id <= 9007199254740991)?)
    } else {
        None
    };
    let session = if object.contains_key("sessionId") {
        Some(value["sessionId"].as_str()?.to_owned())
    } else {
        None
    };
    let method = if object.contains_key("method") {
        let method = value["method"].as_str()?;
        let (domain, name) = method.split_once('.')?;
        let identifier = |part: &str| {
            !part.is_empty()
                && part.as_bytes()[0].is_ascii_alphabetic()
                && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        };
        if !identifier(domain)
            || !identifier(name)
            || object.contains_key("result")
            || object.contains_key("error")
            || (object.contains_key("params") && !value["params"].is_object())
        {
            return None;
        }
        Some(method.to_owned())
    } else {
        if id.is_none()
            || object.contains_key("result") == object.contains_key("error")
            || object.contains_key("params")
        {
            return None;
        }
        if object.contains_key("error")
            && (value["error"]["code"].as_i64().is_none() || !value["error"]["message"].is_string())
        {
            return None;
        }
        None
    };
    Some(Envelope {
        id,
        session,
        method,
    })
}
pub fn normalize_id(query: &str) -> Option<String> {
    if query.len() > 4096 {
        return None;
    }
    let query = query.trim_matches(|c: char| c.is_ascii_whitespace());
    if query.is_empty() {
        return Some(String::new());
    }
    if !query.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let digits = query.trim_start_matches('0');
    let id = if digits.is_empty() {
        0
    } else {
        digits.parse::<u64>().ok()?
    };
    (id <= 9007199254740991).then(|| id.to_string())
}
pub fn search_matches(message: &Value, format: &str, query: &str) -> bool {
    let Some(envelope) = parse_inner(message) else {
        return false;
    };
    match format {
        "cdp_method" => envelope.method.is_some_and(|method| method.contains(query)),
        "cdp_id" => envelope
            .id
            .is_some_and(|id| normalize_id(query).is_some_and(|query| query == id.to_string())),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duplicate_protocol_members_share_renderer_vectors() {
        let vectors: Value =
            serde_json::from_str(include_str!("../scripts/rpc-unique-vectors.json")).unwrap();
        for value in vectors["cdp_valid"].as_array().unwrap() {
            assert!(parse_text(value.as_str().unwrap()).is_some(), "{value}");
        }
        for value in vectors["cdp_invalid"].as_array().unwrap() {
            assert!(parse_text(value.as_str().unwrap()).is_none(), "{value}");
        }
        for value in vectors["jsonrpc_valid"].as_array().unwrap() {
            let entries = crate::jsonrpc::parse_text(value.as_str().unwrap()).unwrap();
            assert!(entries.iter().all(|e| e.envelope.is_some()), "{value}");
        }
        for value in vectors["jsonrpc_invalid"].as_array().unwrap() {
            assert!(
                crate::jsonrpc::parse_text(value.as_str().unwrap())
                    .unwrap()
                    .iter()
                    .any(|e| e.envelope.is_none()),
                "{value}"
            );
        }
    }
    #[test]
    fn cdp_id_queries_match_renderer_without_number_rounding() {
        let vectors: Value =
            serde_json::from_str(include_str!("../scripts/cdp-id-vectors.json")).unwrap();
        for row in vectors["valid"].as_array().unwrap() {
            assert_eq!(
                normalize_id(row[0].as_str().unwrap()).as_deref(),
                row[1].as_str()
            );
        }
        for input in vectors["invalid"].as_array().unwrap() {
            assert!(normalize_id(input.as_str().unwrap()).is_none());
        }
        assert!(normalize_id(&"0".repeat(4097)).is_none());
        assert_eq!(normalize_id(&("0".repeat(4094) + "17")).unwrap(), "17");
    }
    #[test]
    fn accepts_only_complete_scoped_cdp_envelopes() {
        let wrap = |text: &str| serde_json::json!({"kind":"TEXT","direction":"sent","truncated":false,"size":text.len(),"base64":BASE64_STANDARD.encode(text)});
        for text in [
            r#"{"id":0,"method":"Runtime.evaluate","params":{},"sessionId":"a"}"#,
            r#"{"id":1,"result":{}}"#,
            r#"{"id":1,"error":{"code":-32601,"message":"bad"}}"#,
        ] {
            assert!(parse(&wrap(text)).is_some(), "{text}");
        }
        for text in [
            r#"{"method":"Runtime.event"}"#,
            r#"{"id":"1","result":{}}"#,
            r#"{"id":9007199254740993,"result":{}}"#,
            r#"{"id":1,"result":{},"error":{}}"#,
            r#"{"id":1,"result":{},"sessionId":null}"#,
            r#"{"id":1,"method":"Custom","params":{}}"#,
            r#"{"id":1,"method":"Runtime.enable","params":[]}"#,
            r#"{"id":1,"jsonrpc":"2.0","result":{}}"#,
            r#"{"id":1,"error":{"code":1,"message":0}}"#,
            "[]",
            "null",
            "{broken",
        ] {
            assert!(parse(&wrap(text)).is_none(), "{text}");
        }
        let mut message = wrap(r#"{"id":1,"result":{}}"#);
        message["truncated"] = true.into();
        assert!(parse(&message).is_none());
        message["truncated"] = false.into();
        message["kind"] = "BINARY".into();
        assert!(parse(&message).is_some());
        message["size"] = 1.into();
        assert!(parse(&message).is_none());
        message["base64"] = "/w==".into();
        assert!(parse(&message).is_none());
    }
}
