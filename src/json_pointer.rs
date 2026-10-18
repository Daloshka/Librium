//! Explicit JSON field lookup. Raw values preserve arbitrary numeric lexemes.
use base64::{Engine, prelude::BASE64_STANDARD};
use serde::{
    Deserialize,
    de::{MapAccess, Visitor},
};
use serde_json::{Value, value::RawValue};

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScalarFilter {
    pub kind: String,
    pub value: String,
}
impl ScalarFilter {
    pub fn key(&self) -> Option<String> {
        if self.value.len() > 65536 {
            return None;
        }
        let valid = match self.kind.as_str() {
            "string" => true,
            "boolean" => matches!(self.value.as_str(), "true" | "false"),
            "null" => self.value == "null",
            "number" => serde_json::from_str::<&RawValue>(&self.value)
                .ok()
                .is_some_and(|raw| {
                    raw.get() == self.value && matches!(raw.get().as_bytes()[0], b'-' | b'0'..=b'9')
                }),
            _ => false,
        };
        valid.then(|| serde_json::json!({"kind":self.kind,"value":self.value}).to_string())
    }
}

pub fn tokens(pointer: &str) -> Option<Vec<String>> {
    if pointer.len() > 2048 {
        return None;
    }
    if pointer.is_empty() {
        return Some(Vec::new());
    }
    let parts = pointer.strip_prefix('/')?.split('/').collect::<Vec<_>>();
    if parts.len() > 64 {
        return None;
    }
    parts
        .into_iter()
        .map(|part| {
            let mut result = String::new();
            let mut chars = part.chars();
            while let Some(c) = chars.next() {
                if c == '~' {
                    result.push(match chars.next()? {
                        '0' => '~',
                        '1' => '/',
                        _ => return None,
                    });
                } else {
                    result.push(c);
                }
            }
            Some(result)
        })
        .collect()
}
struct Members<'a>(Vec<(String, &'a RawValue)>);
impl<'de> Deserialize<'de> for Members<'de> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ObjectVisitor;
        impl<'de> Visitor<'de> for ObjectVisitor {
            type Value = Members<'de>;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("JSON object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut members = Vec::new();
                while let Some(entry) = map.next_entry::<String, &'de RawValue>()? {
                    members.push(entry);
                }
                Ok(Members(members))
            }
        }
        deserializer.deserialize_map(ObjectVisitor)
    }
}
fn select<'a>(text: &'a str, pointer: &str) -> Option<&'a RawValue> {
    let mut value: &RawValue = serde_json::from_str(text).ok()?;
    for token in tokens(pointer)? {
        let raw = value.get();
        value = match raw.as_bytes().first()? {
            b'{' => {
                let members: Members<'_> = serde_json::from_str(raw).ok()?;
                let mut matches = members.0.into_iter().filter(|(key, _)| key == &token);
                let (_, child) = matches.next()?;
                if matches.next().is_some() {
                    return None;
                }
                child
            }
            b'[' => {
                if token.is_empty()
                    || !token.bytes().all(|c| c.is_ascii_digit())
                    || (token.len() > 1 && token.starts_with('0'))
                {
                    return None;
                }
                let index = token.parse::<usize>().ok()?;
                let items: Vec<&RawValue> = serde_json::from_str(raw).ok()?;
                *items.get(index)?
            }
            _ => return None,
        };
    }
    Some(value)
}
fn source(message: &Value) -> Option<String> {
    if message["truncated"].as_bool() != Some(false)
        || !matches!(message["kind"].as_str()?, "TEXT" | "BINARY")
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
    String::from_utf8(bytes).ok()
}
pub fn field(message: &Value, pointer: &str) -> Option<String> {
    let text = source(message)?;
    let raw = select(&text, pointer)?.get();
    if raw.starts_with('"') {
        serde_json::from_str::<String>(raw).ok()
    } else {
        Some(raw.to_owned())
    }
}
pub fn matches(message: &Value, pointer: &str, query: &str) -> bool {
    field(message, pointer).is_some_and(|value| crate::ws_search::contains(&value, query))
}
pub fn scalar_key(message: &Value, pointer: &str) -> Option<String> {
    let text = source(message)?;
    let raw = select(&text, pointer)?.get();
    let kind = match raw.as_bytes()[0] {
        b'{' | b'[' => return None,
        b'"' => "string",
        b't' | b'f' => "boolean",
        b'n' => "null",
        _ => "number",
    };
    let value = if kind == "string" {
        serde_json::from_str::<String>(raw).ok()?
    } else {
        raw.to_owned()
    };
    Some(serde_json::json!({"kind":kind,"value":value}).to_string())
}

pub fn inspect(message: &Value) -> Value {
    let Some(text) = source(message) else {
        return serde_json::json!({"supported":false,"reason":"Нужно полное исходное TEXT / UTF-8 BINARY сообщение до 64 КиБ."});
    };
    let Ok(root) = serde_json::from_str::<&RawValue>(&text) else {
        return serde_json::json!({"supported":false,"reason":"Исходное сообщение не содержит корректный JSON."});
    };
    let (mut rows, mut limited) = (Vec::new(), false);
    fn walk(
        raw: &RawValue,
        path: String,
        depth: usize,
        duplicates: usize,
        rows: &mut Vec<Value>,
        limited: &mut bool,
    ) {
        if rows.len() >= 256 || path.len() > 2048 || depth > 64 {
            *limited = true;
            return;
        }
        let value = raw.get();
        let kind = match value.as_bytes()[0] {
            b'{' => "object",
            b'[' => "array",
            b'"' => "string",
            b't' | b'f' => "boolean",
            b'n' => "null",
            _ => "number",
        };
        let decoded = if kind == "string" {
            serde_json::from_str::<String>(value).ok()
        } else {
            Some(value.to_owned())
        };
        let preview = if duplicates > 1 {
            format!("Ключ повторяется {duplicates} раз")
        } else {
            decoded
                .clone()
                .unwrap_or_else(|| "Строка не декодируется".into())
        };
        let mut chars = preview.chars();
        let short: String = chars.by_ref().take(160).collect();
        rows.push(serde_json::json!({"pointer":path,"kind":kind,"preview":if chars.next().is_some(){short+"…"}else{short},"searchable":duplicates<2 && decoded.is_some(),"ambiguous":duplicates>1}));
        if duplicates > 1 {
            return;
        }
        if kind == "object" {
            let Ok(members) = serde_json::from_str::<Members<'_>>(value) else {
                *limited = true;
                return;
            };
            if (depth >= 64 || path.len() >= 2048) && !members.0.is_empty() {
                *limited = true;
                return;
            }
            let mut counts = std::collections::HashMap::new();
            for (key, _) in &members.0 {
                *counts.entry(key.as_str()).or_insert(0usize) += 1;
            }
            let mut seen = std::collections::HashSet::new();
            for (key, child) in &members.0 {
                if !seen.insert(key) {
                    continue;
                }
                if rows.len() >= 256 {
                    *limited = true;
                    break;
                }
                let next = format!("{path}/{}", key.replace('~', "~0").replace('/', "~1"));
                walk(child, next, depth + 1, counts[key.as_str()], rows, limited);
            }
        } else if kind == "array" {
            let Ok(items) = serde_json::from_str::<Vec<&RawValue>>(value) else {
                *limited = true;
                return;
            };
            if (depth >= 64 || path.len() >= 2048) && !items.is_empty() {
                *limited = true;
                return;
            }
            for (index, child) in items.into_iter().enumerate() {
                if rows.len() >= 256 {
                    *limited = true;
                    break;
                }
                walk(
                    child,
                    format!("{path}/{index}"),
                    depth + 1,
                    0,
                    rows,
                    limited,
                );
            }
        }
    }
    walk(root, String::new(), 0, 0, &mut rows, &mut limited);
    serde_json::json!({"supported":true,"rows":rows,"limited":limited})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_scalar_keys_keep_type_case_and_numeric_spelling() {
        for (kind, value) in [
            ("string", ""),
            ("string", "1"),
            ("number", "1"),
            ("number", "1.0"),
            ("number", "1e400"),
            ("number", "-0"),
            ("number", "18446744073709551616123456789"),
            ("boolean", "false"),
            ("null", "null"),
        ] {
            assert!(
                ScalarFilter {
                    kind: kind.into(),
                    value: value.into()
                }
                .key()
                .is_some()
            );
        }
        for (kind, value) in [
            ("number", "NaN"),
            ("number", "01"),
            ("number", " 1"),
            ("number", "1 "),
            ("number", "{}"),
            ("number", "\"1\""),
            ("boolean", "False"),
            ("null", "NULL"),
            ("object", "{}"),
        ] {
            assert!(
                ScalarFilter {
                    kind: kind.into(),
                    value: value.into()
                }
                .key()
                .is_none()
            );
        }
        assert_ne!(
            ScalarFilter {
                kind: "number".into(),
                value: "1".into()
            }
            .key(),
            ScalarFilter {
                kind: "string".into(),
                value: "1".into()
            }
            .key()
        );
        assert!(
            ScalarFilter {
                kind: "string".into(),
                value: "x".repeat(65537)
            }
            .key()
            .is_none()
        );
    }
    #[test]
    fn field_inspector_is_bounded_exact_and_marks_ambiguous_paths() {
        let wrap = |text: &str| serde_json::json!({"kind":"TEXT","size":text.len(),"base64":BASE64_STANDARD.encode(text),"truncated":false});
        let message = wrap(
            " \n {\"a/b\":[{\"m~n\":18446744073709551616123456789}],\"dup\":1,\"dup\":2,\"empty\":null} \t",
        );
        let result = inspect(&message);
        assert_eq!(result["supported"], true);
        assert_eq!(result["limited"], false);
        let rows = result["rows"].as_array().unwrap();
        let id = rows
            .iter()
            .find(|row| row["pointer"] == "/a~1b/0/m~0n")
            .unwrap();
        assert_eq!(id["kind"], "number");
        assert_eq!(id["preview"], "18446744073709551616123456789");
        let duplicate = rows.iter().find(|row| row["pointer"] == "/dup").unwrap();
        assert_eq!(duplicate["ambiguous"], true);
        assert_eq!(duplicate["searchable"], false);
        assert_eq!(
            rows.iter().filter(|row| row["pointer"] == "/dup").count(),
            1
        );
        for row in rows {
            if row["searchable"] == true {
                assert!(field(&message, row["pointer"].as_str().unwrap()).is_some());
            }
        }
        let wide = inspect(&wrap(&format!("[{}]", vec!["null"; 1000].join(","))));
        assert_eq!(wide["rows"].as_array().unwrap().len(), 256);
        assert_eq!(wide["limited"], true);
        let deep = inspect(&wrap(&("[".repeat(100) + "1" + &"]".repeat(100))));
        assert_eq!(deep["limited"], true);
        assert!(deep["rows"].as_array().unwrap().len() <= 65);
        assert_eq!(inspect(&wrap("not JSON"))["supported"], false);
        let mut partial = message.clone();
        partial["truncated"] = true.into();
        assert_eq!(inspect(&partial)["supported"], false);
        partial = message.clone();
        partial["kind"] = "BINARY".into();
        assert_eq!(inspect(&partial)["supported"], true);
        let long = inspect(&wrap(&format!("{{\"value\":\"{}\"}}", "я".repeat(500))));
        assert_eq!(
            long["rows"][1]["preview"].as_str().unwrap().chars().count(),
            161
        );
        assert_eq!(
            message["base64"],
            wrap(
                " \n {\"a/b\":[{\"m~n\":18446744073709551616123456789}],\"dup\":1,\"dup\":2,\"empty\":null} \t"
            )["base64"]
        );
    }
    #[test]
    fn resolves_rfc_paths_without_rounding_numbers_or_guessing_duplicate_keys() {
        let vectors: Value =
            serde_json::from_str(include_str!("../scripts/json-pointer-vectors.json")).unwrap();
        for path in vectors["valid_paths"].as_array().unwrap() {
            assert!(tokens(path.as_str().unwrap()).is_some());
        }
        for path in vectors["invalid_paths"].as_array().unwrap() {
            assert!(tokens(path.as_str().unwrap()).is_none());
        }
        assert!(tokens(&"/x".repeat(65)).is_none());
        assert!(tokens(&("/".to_owned() + &"я".repeat(1024))).is_none());
        let wrap = |text: &str| serde_json::json!({"kind":"TEXT","size":text.len(),"base64":BASE64_STANDARD.encode(text),"truncated":false});
        for row in vectors["fields"].as_array().unwrap() {
            assert_eq!(
                field(&wrap(row[0].as_str().unwrap()), row[1].as_str().unwrap()).as_deref(),
                row[2].as_str(),
                "{row}"
            );
        }
        let mut message = wrap(r#"{"state":"Привет","other":"only elsewhere"}"#);
        assert!(matches(&message, "/state", "ПРИВЕТ"));
        assert!(!matches(&message, "/state", "elsewhere"));
        assert!(matches(&message, "/state", ""));
        assert!(!matches(&message, "/absent", ""));
        message["kind"] = "BINARY".into();
        assert!(matches(&message, "/state", "привет"));
        message["truncated"] = true.into();
        assert!(!matches(&message, "/state", ""));
        message["truncated"] = false.into();
        message["size"] = 0.into();
        assert!(field(&message, "/state").is_none());
        message["base64"] = "/w==".into();
        message["size"] = 1.into();
        assert!(field(&message, "").is_none());
    }
}
