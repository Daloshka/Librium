//! Raw members of one protocol object; nested application data stays untouched.
use serde::{
    Deserialize,
    de::{MapAccess, Visitor},
};
use serde_json::value::RawValue;
use std::collections::BTreeMap;

pub struct Object<'a>(pub BTreeMap<String, &'a RawValue>);
impl<'de> Deserialize<'de> for Object<'de> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ObjectVisitor;
        impl<'de> Visitor<'de> for ObjectVisitor {
            type Value = Object<'de>;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("unambiguous JSON object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut members = BTreeMap::new();
                while let Some((key, value)) = map.next_entry::<String, &'de RawValue>()? {
                    if members.insert(key, value).is_some() {
                        return Err(serde::de::Error::custom("duplicate protocol member"));
                    }
                }
                Ok(Object(members))
            }
        }
        deserializer.deserialize_map(ObjectVisitor)
    }
}
