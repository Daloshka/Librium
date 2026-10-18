//! Socket.IO EVENT headers inside Engine.IO WebSocket MESSAGE packets.
//! Binary attachments stay separate; matching never guesses their contents.
use base64::{Engine, prelude::BASE64_STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, value::RawValue};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EventKey {
    pub namespace: String,
    pub kind: String,
    pub value: String,
}
impl EventKey {
    pub fn key(&self) -> Option<String> {
        if !self.namespace.starts_with('/')
            || self.namespace.contains(',')
            || self.namespace.len() > 65536
            || !matches!(self.kind.as_str(), "string" | "number")
        {
            return None;
        }
        crate::json_pointer::ScalarFilter {
            kind: self.kind.clone(),
            value: self.value.clone(),
        }
        .key()?;
        serde_json::to_string(self).ok()
    }
}

pub struct Packet {
    pub namespace: String,
    pub ack: Option<String>,
    pub event: Option<EventKey>,
    pub binary: bool,
}

pub fn packet(text: &str) -> Option<Packet> {
    if text.len() > 65536 {
        return None;
    }
    let body = text.strip_prefix('4')?;
    let kind = *body.as_bytes().first()?;
    if !matches!(kind, b'2' | b'3' | b'5' | b'6') {
        return None;
    }
    let mut rest = &body[1..];
    let binary = matches!(kind, b'5' | b'6');
    if binary {
        let (count, tail) = rest.split_once('-')?;
        if count.is_empty()
            || !count.bytes().all(|b| b.is_ascii_digit())
            || !count.bytes().any(|b| b != b'0')
        {
            return None;
        }
        rest = tail;
    }
    let namespace = if rest.starts_with('/') {
        let (namespace, tail) = rest.split_once(',')?;
        rest = tail;
        namespace
    } else {
        "/"
    };
    let tail = rest.trim_start_matches(|c: char| c.is_ascii_digit());
    let id = &rest[..rest.len() - tail.len()];
    rest = tail;
    let ack = if id.is_empty() {
        None
    } else {
        let canonical = id.trim_start_matches('0');
        Some(if canonical.is_empty() { "0" } else { canonical }.to_owned())
    };
    let payload: Vec<&RawValue> = serde_json::from_str(rest).ok()?;
    let event = if matches!(kind, b'2' | b'5') {
        let first = payload.first()?.get();
        let (kind, value) = if first.starts_with('"') {
            let name: String = serde_json::from_str(first).ok()?;
            if [
                "connect",
                "connect_error",
                "disconnect",
                "disconnecting",
                "newListener",
                "removeListener",
            ]
            .contains(&name.as_str())
            {
                return None;
            }
            ("string", name)
        } else if first
            .as_bytes()
            .first()
            .is_some_and(|b| b.is_ascii_digit() || *b == b'-')
        {
            ("number", first.to_owned())
        } else {
            return None;
        };
        Some(EventKey {
            namespace: namespace.into(),
            kind: kind.into(),
            value,
        })
    } else {
        None
    };
    Some(Packet {
        namespace: namespace.into(),
        ack,
        event,
        binary,
    })
}

pub fn packet_from_message(message: &Value) -> Option<Packet> {
    if message["kind"] != "TEXT" || message["truncated"] != false {
        return None;
    }
    let encoded = message["base64"].as_str().filter(|s| s.len() <= 87384)?;
    let bytes = BASE64_STANDARD.decode(encoded).ok()?;
    if message["size"].as_u64() != Some(bytes.len() as u64) {
        return None;
    }
    packet(std::str::from_utf8(&bytes).ok()?)
}
pub fn from_message(message: &Value) -> Option<EventKey> {
    packet_from_message(message)?.event
}
pub fn matches(message: &Value, query: &str) -> bool {
    from_message(message).is_some_and(|event| event.value.contains(query))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event(text: &str) -> Option<EventKey> {
        packet(text)?.event
    }
    #[test]
    fn shared_ack_vectors() {
        let vectors: Value =
            serde_json::from_str(include_str!("../scripts/socketio-ack-vectors.json")).unwrap();
        for row in vectors["valid"].as_array().unwrap() {
            let packet = packet(row[0].as_str().unwrap()).unwrap();
            assert_eq!(packet.ack.as_deref(), row[1].as_str(), "{}", row[0]);
            assert_eq!(packet.namespace, row[2].as_str().unwrap());
            assert_eq!(packet.event.is_some(), row[3].as_bool().unwrap());
            assert_eq!(packet.binary, row[4].as_bool().unwrap());
        }
        for text in vectors["invalid"].as_array().unwrap() {
            assert!(packet(text.as_str().unwrap()).is_none(), "{text}");
        }
    }
    #[test]
    fn shared_event_vectors() {
        let vectors: Value =
            serde_json::from_str(include_str!("../scripts/socketio-event-vectors.json")).unwrap();
        for row in vectors["valid"].as_array().unwrap() {
            assert_eq!(
                event(row[0].as_str().unwrap())
                    .map(|event| event.value)
                    .as_deref(),
                row[1].as_str(),
                "{}",
                row[0]
            );
        }
        for text in vectors["invalid"].as_array().unwrap() {
            assert!(event(text.as_str().unwrap()).is_none(), "{text}");
        }
        let text = "42[\"event\"]";
        let mut message = serde_json::json!({"kind":"TEXT","truncated":false,"size":text.len(),"base64":BASE64_STANDARD.encode(text)});
        assert!(matches(&message, "event"));
        assert!(!matches(&message, "Event"));
        message["kind"] = "BINARY".into();
        assert!(!matches(&message, "event"));
        message["kind"] = "TEXT".into();
        message["truncated"] = true.into();
        assert!(!matches(&message, "event"));
        message["truncated"] = false.into();
        message["size"] = 999.into();
        assert!(!matches(&message, "event"));
        assert!(event(&format!("42[\"{}\"]", "a".repeat(65536))).is_none());
    }
}
