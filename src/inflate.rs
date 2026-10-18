//! Explicit, bounded payload decompression. Never changes archived messages.
use base64::{Engine, prelude::BASE64_STANDARD};
use flate2::{Decompress, FlushDecompress, Status, bufread::MultiGzDecoder};
use serde::Deserialize;
use std::io::Read;
const LIMIT: usize = 65536;
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Query {
    pub codec: String,
    #[serde(default)]
    pub offset: usize,
    pub length: Option<usize>,
}
impl Query {
    pub fn valid(&self) -> bool {
        ["gzip", "zlib", "deflate"].contains(&self.codec.as_str())
            && self.offset < LIMIT
            && self.length.is_none_or(|n| n > 0 && n <= LIMIT)
    }
}
fn unpack(input: &[u8], codec: &str) -> Result<Vec<u8>, &'static str> {
    if input.len() > LIMIT {
        return Err("Сжатый диапазон превышает 64 КиБ.");
    }
    let mut output = if codec == "gzip" {
        let decoder = MultiGzDecoder::new(input);
        let mut bytes = Vec::new();
        decoder
            .take((LIMIT + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| "Некорректный или неполный gzip, либо неверная контрольная сумма.")?;
        bytes
    } else {
        let mut decoder = Decompress::new(codec == "zlib");
        let mut bytes = vec![0; LIMIT + 1];
        let status = decoder
            .decompress(input, &mut bytes, FlushDecompress::Finish)
            .map_err(|_| "Некорректные сжатые данные или неверная контрольная сумма.")?;
        let length = decoder.total_out() as usize;
        if length > LIMIT {
            return Err("Распакованные данные превышают 64 КиБ.");
        }
        if status != Status::StreamEnd || decoder.total_in() as usize != input.len() {
            return Err("Сжатый поток неполный или содержит лишние байты.");
        }
        bytes.truncate(length);
        bytes
    };
    if output.len() > LIMIT {
        return Err("Распакованные данные превышают 64 КиБ.");
    }
    output.shrink_to_fit();
    Ok(output)
}
pub fn decode(message: &serde_json::Value, query: &Query) -> serde_json::Value {
    let result = (|| {
        if !query.valid() {
            return Err("Некорректные параметры распаковки.");
        }
        if message["kind"] != "BINARY" {
            return Err("Распаковка доступна для BINARY.");
        }
        let encoded = message["base64"]
            .as_str()
            .filter(|s| s.len() <= 87384)
            .ok_or("Исходные байты недоступны.")?;
        let bytes = BASE64_STANDARD
            .decode(encoded)
            .map_err(|_| "Некорректные исходные байты.")?;
        if bytes.len() > LIMIT || BASE64_STANDARD.encode(&bytes) != encoded {
            return Err("Некорректные исходные байты.");
        }
        let size = message["size"]
            .as_u64()
            .ok_or("Неизвестный исходный размер.")?;
        let partial = message["truncated"]
            .as_bool()
            .ok_or("Неизвестна полнота сообщения.")?;
        if size < bytes.len() as u64 || partial != (size > bytes.len() as u64) {
            return Err("Некорректный исходный размер.");
        }
        if partial && query.length.is_none() {
            return Err(
                "Сообщение сохранено частично. Укажи длину полностью сохранённого сжатого диапазона.",
            );
        }
        let remaining = bytes
            .len()
            .checked_sub(query.offset)
            .ok_or("Начало за пределами сохранённых байтов.")?;
        let length = query.length.unwrap_or(remaining);
        if length == 0 || length > remaining {
            return Err("Диапазон выходит за пределы сохранённых байтов.");
        }
        let output = unpack(&bytes[query.offset..query.offset + length], &query.codec)?;
        Ok((output, length))
    })();
    match result {
        Ok((bytes, length)) => {
            serde_json::json!({"ok":true,"codec":query.codec,"offset":query.offset,"length":length,"size":bytes.len(),"base64":BASE64_STANDARD.encode(bytes)})
        }
        Err(error) => serde_json::json!({"ok":false,"error":error}),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn encoded(bytes: &[u8], codec: &str) -> Vec<u8> {
        let mut writer: Box<dyn WriteEncoder> = match codec {
            "gzip" => Box::new(flate2::write::GzEncoder::new(
                Vec::new(),
                flate2::Compression::default(),
            )),
            "zlib" => Box::new(flate2::write::ZlibEncoder::new(
                Vec::new(),
                flate2::Compression::default(),
            )),
            _ => Box::new(flate2::write::DeflateEncoder::new(
                Vec::new(),
                flate2::Compression::default(),
            )),
        };
        writer.write_all(bytes).unwrap();
        writer.done()
    }
    trait WriteEncoder: Write {
        fn done(self: Box<Self>) -> Vec<u8>;
    }
    impl WriteEncoder for flate2::write::GzEncoder<Vec<u8>> {
        fn done(self: Box<Self>) -> Vec<u8> {
            self.finish().unwrap()
        }
    }
    impl WriteEncoder for flate2::write::ZlibEncoder<Vec<u8>> {
        fn done(self: Box<Self>) -> Vec<u8> {
            self.finish().unwrap()
        }
    }
    impl WriteEncoder for flate2::write::DeflateEncoder<Vec<u8>> {
        fn done(self: Box<Self>) -> Vec<u8> {
            self.finish().unwrap()
        }
    }
    #[test]
    fn complete_streams_checksums_trailing_bytes_and_limits() {
        for codec in ["gzip", "zlib", "deflate"] {
            for raw in [Vec::new(), vec![0, 255, 1], vec![42; LIMIT]] {
                let compressed = encoded(&raw, codec);
                assert_eq!(unpack(&compressed, codec).unwrap(), raw);
                for end in 0..compressed.len() {
                    assert!(
                        unpack(&compressed[..end], codec).is_err(),
                        "{codec} prefix {end}"
                    );
                }
                let mut extra = compressed.clone();
                extra.push(0xff);
                assert!(unpack(&extra, codec).is_err());
            }
            assert!(unpack(&encoded(&vec![0; LIMIT + 1], codec), codec).is_err());
            assert!(unpack(&vec![0; LIMIT + 1], codec).is_err());
        }
        let mut gzip = encoded(b"one", "gzip");
        gzip.extend(encoded(b"two", "gzip"));
        assert_eq!(unpack(&gzip, "gzip").unwrap(), b"onetwo");
        for codec in ["gzip", "zlib"] {
            let mut bytes = encoded(b"checksum", codec);
            let index = bytes.len() - 3;
            bytes[index] ^= 1;
            assert!(unpack(&bytes, codec).is_err());
        }
    }
    #[test]
    fn range_selection_retains_partial_source_semantics() {
        let compressed = encoded(b"custom payload", "gzip");
        let mut bytes = vec![1, 2, 3];
        bytes.extend(&compressed);
        bytes.extend([4, 5]);
        let source = serde_json::json!({"kind":"BINARY","base64":BASE64_STANDARD.encode(&bytes),"size":bytes.len()+50,"truncated":true});
        let original = source.clone();
        let query = Query {
            codec: "gzip".into(),
            offset: 3,
            length: Some(compressed.len()),
        };
        let result = decode(&source, &query);
        assert_eq!(result["ok"], true);
        assert_eq!(result["base64"], BASE64_STANDARD.encode(b"custom payload"));
        assert_eq!(source, original);
        assert_eq!(
            decode(
                &source,
                &Query {
                    length: None,
                    ..query.clone()
                }
            )["ok"],
            false
        );
        assert_eq!(
            decode(
                &source,
                &Query {
                    length: Some(bytes.len()),
                    ..query
                }
            )["ok"],
            false
        );
    }
}
