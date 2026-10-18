//! Exact values of declared fields in original, bounded WS payload bytes.
use base64::{Engine, prelude::BASE64_STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FieldSpec {
    #[serde(rename = "type")]
    pub kind: String,
    pub offset: usize,
    pub endian: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub length: Option<usize>,
}
impl FieldSpec {
    pub fn width(&self) -> Option<usize> {
        if self.offset >= 65536 || !matches!(self.endian.as_str(), "le" | "be") {
            return None;
        }
        if matches!(self.kind.as_str(), "bytes" | "utf8") {
            return self.length.filter(|length| (1..=65536).contains(length));
        }
        if self.length.is_some() {
            return None;
        }
        match self.kind.as_str() {
            "uint8" | "int8" => Some(1),
            "uint16" | "int16" => Some(2),
            "uint32" | "int32" | "float32" => Some(4),
            "uint64" | "int64" | "float64" => Some(8),
            _ => None,
        }
    }
}

fn payload(message: &Value) -> Option<Vec<u8>> {
    if !matches!(message["kind"].as_str(), Some("TEXT" | "BINARY")) {
        return None;
    }
    let encoded = message["base64"].as_str().filter(|s| s.len() <= 87384)?;
    let bytes = BASE64_STANDARD.decode(encoded).ok()?;
    let size = message["size"].as_u64()?;
    if bytes.len() > 65536
        || size < bytes.len() as u64
        || message["truncated"].as_bool() != Some(size > bytes.len() as u64)
    {
        return None;
    }
    Some(bytes)
}
fn span(message: &Value, offset: usize, width: usize) -> Option<Vec<u8>> {
    if offset >= 65536 || width == 0 || width > 65536 {
        return None;
    }
    Some(payload(message)?.get(offset..offset + width)?.to_vec())
}

pub fn scalar(message: &Value, definition: &FieldSpec) -> Option<Vec<u8>> {
    let width = definition.width()?;
    let mut bytes = span(message, definition.offset, width)?;
    let le = definition.endian == "le";
    if definition.kind == "utf8" {
        std::str::from_utf8(&bytes).ok()?;
    }
    if definition.kind == "float32" {
        let raw = bytes.as_slice().try_into().ok()?;
        let value = if le {
            f32::from_le_bytes(raw)
        } else {
            f32::from_be_bytes(raw)
        };
        if value.is_nan() {
            let canonical = f32::from_bits(0x7fc00000);
            bytes = if le {
                canonical.to_le_bytes()
            } else {
                canonical.to_be_bytes()
            }
            .to_vec();
        }
    } else if definition.kind == "float64" {
        let raw = bytes.as_slice().try_into().ok()?;
        let value = if le {
            f64::from_le_bytes(raw)
        } else {
            f64::from_be_bytes(raw)
        };
        if value.is_nan() {
            let canonical = f64::from_bits(0x7ff8000000000000);
            bytes = if le {
                canonical.to_le_bytes()
            } else {
                canonical.to_be_bytes()
            }
            .to_vec();
        }
    }
    Some(bytes)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FieldExact {
    #[serde(rename = "type")]
    pub kind: String,
    pub offset: usize,
    pub endian: String,
    pub length: Option<usize>,
    pub value: String,
}
pub struct Prepared {
    pub offset: usize,
    pub needle: Vec<u8>,
    pub mode: &'static str,
}
impl Prepared {
    pub fn width(&self) -> usize {
        match self.mode {
            "nan32le" | "nan32be" => 4,
            "nan64le" | "nan64be" => 8,
            _ => self.needle.len(),
        }
    }
}
impl FieldExact {
    pub fn prepare(&self) -> Option<Prepared> {
        if self.offset >= 65536
            || !matches!(self.endian.as_str(), "le" | "be")
            || self.value.len() > 196607
        {
            return None;
        }
        let le = self.endian == "le";
        let mut mode = "bytes";
        macro_rules! integer {
            ($ty:ty) => {{
                let value = self.value.parse::<$ty>().ok()?;
                if value.to_string() != self.value {
                    return None;
                }
                if le {
                    value.to_le_bytes().to_vec()
                } else {
                    value.to_be_bytes().to_vec()
                }
            }};
        }
        macro_rules! float {
            ($ty:ty,$nanle:literal,$nanbe:literal) => {{
                if self.value == "NaN" {
                    mode = if le { $nanle } else { $nanbe };
                    Vec::new()
                } else {
                    if self.value.len() > 128 || self.value.trim() != self.value {
                        return None;
                    }
                    let value = match self.value.as_str() {
                        "Infinity" => <$ty>::INFINITY,
                        "-Infinity" => <$ty>::NEG_INFINITY,
                        _ => {
                            let parsed = self.value.parse::<$ty>().ok()?;
                            if !parsed.is_finite() {
                                return None;
                            }
                            parsed
                        }
                    };
                    if le {
                        value.to_le_bytes().to_vec()
                    } else {
                        value.to_be_bytes().to_vec()
                    }
                }
            }};
        }
        let variable = matches!(self.kind.as_str(), "bytes" | "utf8");
        if !variable && self.length.is_some() {
            return None;
        }
        let needle = match self.kind.as_str() {
            "uint8" => integer!(u8),
            "int8" => integer!(i8),
            "uint16" => integer!(u16),
            "int16" => integer!(i16),
            "uint32" => integer!(u32),
            "int32" => integer!(i32),
            "uint64" => integer!(u64),
            "int64" => integer!(i64),
            "float32" => float!(f32, "nan32le", "nan32be"),
            "float64" => float!(f64, "nan64le", "nan64be"),
            "bytes" => {
                let length = self.length.filter(|n| (1..=65536).contains(n))?;
                if self.value.len() != length * 3 - 1 {
                    return None;
                }
                let mut bytes = Vec::with_capacity(length);
                for pair in self.value.split(' ') {
                    if pair.len() != 2 || !pair.bytes().all(|b| b.is_ascii_hexdigit()) {
                        return None;
                    }
                    bytes.push(u8::from_str_radix(pair, 16).ok()?);
                }
                if bytes.len() != length {
                    return None;
                }
                bytes
            }
            "utf8" => {
                let length = self.length.filter(|n| (1..=65536).contains(n))?;
                if self.value.len() != length {
                    return None;
                }
                self.value.as_bytes().to_vec()
            }
            _ => return None,
        };
        Some(Prepared {
            offset: self.offset,
            needle,
            mode,
        })
    }
}

pub fn matches(message: &Value, offset: usize, needle: &[u8], mode: &str) -> bool {
    if offset >= 65536 {
        return false;
    }
    let Some(bytes) = payload(message) else {
        return false;
    };
    let width = match mode {
        "nan32le" | "nan32be" => 4,
        "nan64le" | "nan64be" => 8,
        "bytes" => needle.len(),
        _ => return false,
    };
    if width == 0 || width > 65536 {
        return false;
    }
    let Some(span) = bytes.get(offset..offset + width) else {
        return false;
    };
    match mode {
        "nan32le" => f32::from_le_bytes(span.try_into().unwrap()).is_nan(),
        "nan32be" => f32::from_be_bytes(span.try_into().unwrap()).is_nan(),
        "nan64le" => f64::from_le_bytes(span.try_into().unwrap()).is_nan(),
        "nan64be" => f64::from_be_bytes(span.try_into().unwrap()).is_nan(),
        _ => span == needle,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_field_values_and_malformed_descriptors() {
        let vectors: Value =
            serde_json::from_str(include_str!("../scripts/ws-fields-vectors.json")).unwrap();
        for row in vectors["valid"].as_array().unwrap() {
            let descriptor: FieldExact = serde_json::from_value(row[0].clone()).unwrap();
            let prepared = descriptor.prepare().unwrap();
            let hex = row[1].as_str().unwrap();
            let bytes: Vec<u8> = (0..hex.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
                .collect();
            let mut message = serde_json::json!({"kind":"BINARY","base64":BASE64_STANDARD.encode(&bytes),"size":bytes.len(),"truncated":false});
            assert!(
                matches(&message, prepared.offset, &prepared.needle, prepared.mode),
                "{}",
                row[0]
            );
            let mut definition = row[0].clone();
            definition.as_object_mut().unwrap().remove("value");
            let definition: FieldSpec = serde_json::from_value(definition).unwrap();
            let grouped = scalar(&message, &definition).unwrap();
            let grouped_message = serde_json::json!({"kind":"BINARY","base64":BASE64_STANDARD.encode(&grouped),"size":grouped.len(),"truncated":false});
            assert!(matches(
                &grouped_message,
                0,
                &prepared.needle,
                prepared.mode
            ));
            message["truncated"] = true.into();
            message["size"] = (bytes.len() + 20).into();
            assert!(matches(
                &message,
                prepared.offset,
                &prepared.needle,
                prepared.mode
            ));
            message["kind"] = "PING".into();
            assert!(!matches(
                &message,
                prepared.offset,
                &prepared.needle,
                prepared.mode
            ));
        }
        for value in vectors["invalid"].as_array().unwrap() {
            assert!(
                serde_json::from_value::<FieldExact>(value.clone())
                    .ok()
                    .and_then(|field| field.prepare())
                    .is_none(),
                "{value}"
            );
        }
        let bytes = BASE64_STANDARD.encode([0, 1, 2]);
        let mut message =
            serde_json::json!({"kind":"TEXT","base64":bytes,"size":3,"truncated":false});
        assert!(!matches(&message, 1, &[1, 2, 3], "bytes"));
        assert!(!matches(&message, 0, &[1, 2], "bytes"));
        assert!(matches(&message, 1, &[1, 2], "bytes"));
        message["truncated"] = true.into();
        assert!(!matches(&message, 1, &[1, 2], "bytes"));
        message["size"] = 100.into();
        assert!(matches(&message, 1, &[1, 2], "bytes"));
    }
}
