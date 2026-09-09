//! User settings the core applies while capturing. Kept in `settings.json` next to the history,
//! changed from the interface at run time.
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Hosts whose exchanges are proxied but not recorded, e.g. `*.google-analytics.com`.
    pub ignore_hosts: Vec<String>,
    /// Request headers set or removed for matching hosts before a request leaves the proxy.
    pub rewrites: Vec<Rewrite>,
    /// Response headers set or removed for matching hosts before the client sees the response.
    pub response_rewrites: Vec<Rewrite>,
    /// Extra latency added to responses of matching hosts, to see an app on a slow network.
    pub delays: Vec<Delay>,
    /// Canned responses served by the proxy itself instead of asking the origin.
    pub mocks: Vec<Mock>,
}
/// One mock: `host` and `path` are patterns (`*` wildcards, `path` ignores the query), an empty
/// `method` matches every method; the first matching mock answers.
#[derive(Clone, Default, Serialize, Deserialize, PartialEq, Debug)]
#[serde(default)]
pub struct Mock {
    pub host: String,
    pub path: String,
    pub method: String,
    pub status: u16,
    pub content_type: String,
    pub body: String,
    /// A switched-off mock stays in the list but answers nothing.
    #[serde(default = "enabled")]
    pub enabled: bool,
}
fn enabled() -> bool {
    true
}
pub const MAX_MOCK_BODY: usize = 1024 * 1024;
/// One artificial delay: `host` is a pattern like the ignore list's, `ms` up to a minute.
#[derive(Clone, Default, Serialize, Deserialize, PartialEq, Debug)]
#[serde(default)]
pub struct Delay {
    pub host: String,
    pub ms: u64,
    /// A path pattern like the rewrites'; `*` means every path.
    #[serde(default = "any_path")]
    pub path: String,
}
pub const MAX_DELAY_MS: u64 = 60_000;
/// One header rewrite: `host` is a pattern like the ignore list's; an empty `value` removes the header.
#[derive(Clone, Default, Serialize, Deserialize, PartialEq, Debug)]
#[serde(default)]
pub struct Rewrite {
    pub host: String,
    pub name: String,
    pub value: String,
    /// A path pattern like the mocks' (`*` wildcards, query ignored); `*` means every path.
    #[serde(default = "any_path")]
    pub path: String,
}
fn any_path() -> String {
    "*".into()
}

impl Settings {
    pub fn load(dir: &Path) -> Result<Self> {
        match std::fs::read_to_string(dir.join("settings.json")) {
            Ok(json) => serde_json::from_str(&json).context("settings.json is not valid"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(error).context("Cannot read settings.json"),
        }
    }
    pub fn save(&self, dir: &Path) -> Result<()> {
        let temporary = dir.join("settings.json.tmp");
        std::fs::write(&temporary, serde_json::to_string_pretty(self)?)?;
        std::fs::rename(temporary, dir.join("settings.json"))?;
        Ok(())
    }
    /// Lowercases and trims the patterns and refuses anything that could not be a host pattern,
    /// a header name or a header value.
    pub fn normalized(mut self) -> Result<Self> {
        if self.ignore_hosts.len() > 200 {
            bail!("Too many ignored hosts");
        }
        for pattern in &mut self.ignore_hosts {
            *pattern = host_pattern(pattern)?;
        }
        let mut seen = std::collections::HashSet::new();
        self.ignore_hosts
            .retain(|pattern| seen.insert(pattern.clone()));
        normalize_rewrites(&mut self.rewrites)?;
        normalize_rewrites(&mut self.response_rewrites)?;
        if self.delays.len() > 100 {
            bail!("Too many delays");
        }
        for delay in &mut self.delays {
            delay.host = host_pattern(&delay.host)?;
            if delay.ms == 0 || delay.ms > MAX_DELAY_MS {
                bail!("A delay must be between 1 and {MAX_DELAY_MS} ms");
            }
            delay.path = delay.path.trim().to_string();
            if delay.path.is_empty() {
                delay.path = "*".into();
            }
            if delay.path.len() > 2048 || !delay.path.starts_with(['/', '*']) {
                bail!("A delay path must start with / or *: {}", delay.path);
            }
        }
        if self.mocks.len() > 100 {
            bail!("Too many mocks");
        }
        for mock in &mut self.mocks {
            mock.host = host_pattern(&mock.host)?;
            mock.path = mock.path.trim().to_string();
            if mock.path.is_empty() {
                mock.path = "*".into();
            }
            if mock.path.len() > 2048 || !mock.path.starts_with(['/', '*']) {
                bail!("A mock path must start with / or *: {}", mock.path);
            }
            mock.method = mock.method.trim().to_uppercase();
            if mock.method.len() > 16 || !mock.method.bytes().all(|b| b.is_ascii_alphabetic()) {
                bail!("Not a method name: {}", mock.method);
            }
            if !(100..=599).contains(&mock.status) {
                bail!("A mock status must be 100..=599");
            }
            mock.content_type = mock.content_type.trim().to_string();
            if mock.content_type.is_empty() {
                mock.content_type = "text/plain; charset=utf-8".into();
            }
            if mock.content_type.len() > 256
                || axum::http::HeaderValue::from_str(&mock.content_type).is_err()
            {
                bail!("Invalid content type: {}", mock.content_type);
            }
            if mock.body.len() > MAX_MOCK_BODY {
                bail!("A mock body is limited to {MAX_MOCK_BODY} bytes");
            }
        }
        Ok(self)
    }
    /// The mock answering this request, if any: the first one whose host, path and method match.
    /// `path` may carry the query; a mock pattern without `?` is matched against the path alone,
    /// one with `?` against path and query together.
    pub fn mock_for(&self, host: &str, method: &str, path: &str) -> Option<&Mock> {
        let host = host.to_lowercase();
        let bare = path.split('?').next().unwrap_or(path);
        self.mocks.iter().find(|mock| {
            mock.enabled
                && wildcard(&mock.host, &host)
                && wildcard(
                    &mock.path,
                    if mock.path.contains('?') { path } else { bare },
                )
                && (mock.method.is_empty() || mock.method.eq_ignore_ascii_case(method))
        })
    }
    /// The delay for a host and path: the first matching rule wins.
    pub fn delay_for(&self, host: &str, path: &str) -> Option<u64> {
        let host = host.to_lowercase();
        let path = path.split('?').next().unwrap_or(path);
        self.delays
            .iter()
            .find(|delay| wildcard(&delay.host, &host) && wildcard(&delay.path, path))
            .map(|delay| delay.ms)
    }
    pub fn ignores(&self, host: &str) -> bool {
        let host = host.to_lowercase();
        self.ignore_hosts
            .iter()
            .any(|pattern| wildcard(pattern, &host))
    }
    /// The request rewrites that apply to a host and path, in the order they were written.
    pub fn rewrites_for(&self, host: &str, path: &str) -> Vec<&Rewrite> {
        matching(&self.rewrites, host, path)
    }
    /// The response rewrites that apply to a host and path, in the order they were written.
    pub fn response_rewrites_for(&self, host: &str, path: &str) -> Vec<&Rewrite> {
        matching(&self.response_rewrites, host, path)
    }
}

fn matching<'a>(rules: &'a [Rewrite], host: &str, path: &str) -> Vec<&'a Rewrite> {
    let host = host.to_lowercase();
    let path = path.split('?').next().unwrap_or(path);
    rules
        .iter()
        .filter(|rule| wildcard(&rule.host, &host) && wildcard(&rule.path, path))
        .collect()
}

fn normalize_rewrites(rules: &mut [Rewrite]) -> Result<()> {
    if rules.len() > 100 {
        bail!("Too many header rewrites");
    }
    for rule in rules {
        rule.host = host_pattern(&rule.host)?;
        rule.name = rule.name.trim().to_lowercase();
        if rule.name.is_empty()
            || rule.name.len() > 128
            || axum::http::HeaderName::from_bytes(rule.name.as_bytes()).is_err()
        {
            bail!("Invalid header name: {}", rule.name);
        }
        rule.value = rule.value.trim().to_string();
        if rule.value.len() > 4096 || axum::http::HeaderValue::from_str(&rule.value).is_err() {
            bail!("Invalid header value for {}", rule.name);
        }
        rule.path = rule.path.trim().to_string();
        if rule.path.is_empty() {
            rule.path = "*".into();
        }
        if rule.path.len() > 2048 || !rule.path.starts_with(['/', '*']) {
            bail!("A rewrite path must start with / or *: {}", rule.path);
        }
    }
    Ok(())
}

pub(crate) fn host_pattern(pattern: &str) -> Result<String> {
    let pattern = pattern.trim().to_lowercase();
    if pattern.is_empty()
        || pattern.len() > 253
        || !pattern
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '*' | ':'))
    {
        bail!("Invalid host pattern: {pattern}");
    }
    Ok(pattern)
}

/// `*` matches any run of characters; `*.example.com` also matches `example.com` itself.
pub(crate) fn wildcard(pattern: &str, text: &str) -> bool {
    if let Some(rest) = pattern.strip_prefix("*.")
        && !rest.contains('*')
    {
        return text == rest || text.ends_with(&format!(".{rest}"));
    }
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == text;
    }
    let mut position = 0;
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        let found = if index == 0 {
            text.starts_with(part).then_some(0)
        } else {
            text[position..].find(part).map(|at| position + at)
        };
        let Some(at) = found else {
            return false;
        };
        position = at + part.len();
        if index == parts.len() - 1 && !pattern.ends_with('*') && position != text.len() {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mocks_are_normalized_and_matched_by_host_path_and_method() {
        let settings = Settings {
            mocks: vec![
                Mock {
                    host: " API.Example.com ".into(),
                    path: "/v1/users/*".into(),
                    method: "get".into(),
                    status: 200,
                    content_type: String::new(),
                    body: "[]".into(),
                    enabled: true,
                },
                Mock {
                    host: "*".into(),
                    path: String::new(),
                    method: String::new(),
                    status: 503,
                    content_type: "application/json".into(),
                    body: "{}".into(),
                    enabled: true,
                },
            ],
            ..Default::default()
        }
        .normalized()
        .unwrap();
        assert_eq!(settings.mocks[0].host, "api.example.com");
        assert_eq!(settings.mocks[0].method, "GET");
        assert_eq!(settings.mocks[0].content_type, "text/plain; charset=utf-8");
        assert_eq!(
            settings.mocks[1].path, "*",
            "an empty path means every path"
        );
        assert_eq!(
            settings
                .mock_for("api.example.com", "GET", "/v1/users/7")
                .map(|m| m.status),
            Some(200)
        );
        assert_eq!(
            settings
                .mock_for("api.example.com", "POST", "/v1/users/7")
                .map(|m| m.status),
            Some(503),
            "the method does not match the first, the catch-all answers"
        );
        assert_eq!(
            settings
                .mock_for("other.test", "GET", "/x")
                .map(|m| m.status),
            Some(503)
        );
        assert_eq!(
            settings
                .mock_for("api.example.com", "GET", "/v1/users/7?expand=1")
                .map(|m| m.status),
            Some(200),
            "a pattern without ? ignores the query"
        );
        let by_query = Settings {
            mocks: vec![Mock {
                host: "*".into(),
                path: "/search?q=err*".into(),
                status: 500,
                enabled: true,
                ..Default::default()
            }],
            ..Default::default()
        }
        .normalized()
        .unwrap();
        assert_eq!(
            by_query
                .mock_for("a.test", "GET", "/search?q=error")
                .map(|m| m.status),
            Some(500),
            "a pattern with ? sees the query"
        );
        assert!(by_query.mock_for("a.test", "GET", "/search?q=ok").is_none());
        assert!(by_query.mock_for("a.test", "GET", "/search").is_none());
        let mut off = by_query.clone();
        off.mocks[0].enabled = false;
        assert!(
            off.mock_for("a.test", "GET", "/search?q=error").is_none(),
            "a switched-off mock answers nothing"
        );
        let parsed: Mock = serde_json::from_str(r#"{"host":"*","path":"/","status":200}"#).unwrap();
        assert!(parsed.enabled, "enabled unless said otherwise");
        for (path, status) in [("relative", 200), ("/", 42), ("/", 600)] {
            assert!(
                Settings {
                    mocks: vec![Mock {
                        host: "*".into(),
                        path: path.into(),
                        status,
                        ..Default::default()
                    }],
                    ..Default::default()
                }
                .normalized()
                .is_err(),
                "{path} {status} is refused"
            );
        }
    }
    #[test]
    fn delays_are_validated_and_the_first_match_wins() {
        let settings = Settings {
            delays: vec![
                Delay {
                    host: " Slow.Example.com ".into(),
                    ms: 1500,
                    path: "*".into(),
                },
                Delay {
                    host: "*.example.com".into(),
                    ms: 200,
                    path: "*".into(),
                },
            ],
            ..Default::default()
        }
        .normalized()
        .unwrap();
        assert_eq!(settings.delays[0].host, "slow.example.com");
        assert_eq!(settings.delay_for("slow.example.com", "/"), Some(1500));
        assert_eq!(settings.delay_for("api.example.com", "/x"), Some(200));
        assert_eq!(settings.delay_for("other.test", "/"), None);
        let scoped = Settings {
            delays: vec![Delay {
                host: "*".into(),
                ms: 50,
                path: "/slow/*".into(),
            }],
            ..Default::default()
        }
        .normalized()
        .unwrap();
        assert_eq!(scoped.delay_for("h.test", "/slow/one?x=1"), Some(50));
        assert_eq!(scoped.delay_for("h.test", "/fast"), None);
        for ms in [0, MAX_DELAY_MS + 1] {
            assert!(
                Settings {
                    delays: vec![Delay {
                        host: "*".into(),
                        ms,
                        path: "*".into(),
                    }],
                    ..Default::default()
                }
                .normalized()
                .is_err(),
                "{ms} ms is refused"
            );
        }
    }
    #[test]
    fn header_rewrites_are_normalized_and_matched_by_host() {
        let rule = |host: &str, name: &str, value: &str| Rewrite {
            host: host.into(),
            name: name.into(),
            value: value.into(),
            path: "*".into(),
        };
        let settings = Settings {
            rewrites: vec![
                rule(" API.Example.com ", "X-Debug", " 1 "),
                rule("*", "User-Agent", ""),
                rule("*.example.com", "Authorization", "Bearer abc"),
            ],
            ..Default::default()
        }
        .normalized()
        .unwrap();
        assert_eq!(
            settings.rewrites[0],
            rule("api.example.com", "x-debug", "1"),
            "trimmed, lowercased host and name"
        );
        let names = |host: &str| -> Vec<String> {
            settings
                .rewrites_for(host, "/any")
                .iter()
                .map(|r| r.name.clone())
                .collect()
        };
        assert_eq!(
            names("api.example.com"),
            ["x-debug", "user-agent", "authorization"]
        );
        assert_eq!(names("other.test"), ["user-agent"]);
        let scoped = Settings {
            rewrites: vec![Rewrite {
                host: "*".into(),
                name: "X-Api".into(),
                value: "1".into(),
                path: " /api/* ".into(),
            }],
            ..Default::default()
        }
        .normalized()
        .unwrap();
        assert_eq!(scoped.rewrites[0].path, "/api/*");
        assert_eq!(scoped.rewrites_for("h.test", "/api/users?x=1").len(), 1);
        assert!(scoped.rewrites_for("h.test", "/static/app.js").is_empty());
        assert!(
            Settings {
                rewrites: vec![Rewrite {
                    host: "*".into(),
                    name: "x".into(),
                    value: "1".into(),
                    path: "relative".into(),
                }],
                ..Default::default()
            }
            .normalized()
            .is_err()
        );
        for bad in [
            rule("*", "bad name", "1"),
            rule("*", "", "1"),
            rule("bad host", "x", "1"),
            rule("*", "x", "line\nbreak"),
        ] {
            assert!(
                Settings {
                    rewrites: vec![bad.clone()],
                    ..Default::default()
                }
                .normalized()
                .is_err(),
                "{bad:?} must be refused"
            );
        }
    }
    #[test]
    fn host_patterns_match_like_people_expect() {
        let settings = Settings {
            ignore_hosts: vec![
                "*.google-analytics.com".into(),
                "telemetry.*".into(),
                "cdn*static.example.com".into(),
                "exact.test".into(),
            ],
            ..Default::default()
        }
        .normalized()
        .unwrap();
        for host in [
            "www.google-analytics.com",
            "google-analytics.com",
            "TELEMETRY.example.org",
            "cdn1.static.example.com",
            "exact.test",
        ] {
            assert!(settings.ignores(host), "{host} should be ignored");
        }
        for host in [
            "notgoogle-analytics.com",
            "api.telemetry.example.org",
            "cdn.static.example.com.evil",
            "sub.exact.test",
        ] {
            assert!(!settings.ignores(host), "{host} should be recorded");
        }
        assert!(
            Settings {
                ignore_hosts: vec!["bad host".into()],
                ..Default::default()
            }
            .normalized()
            .is_err()
        );
        assert_eq!(
            Settings {
                ignore_hosts: vec!["a.test".into(), "b.test".into(), "A.TEST".into()],
                ..Default::default()
            }
            .normalized()
            .unwrap()
            .ignore_hosts,
            vec!["a.test", "b.test"],
            "duplicates are dropped wherever they are"
        );
        let dir = std::env::temp_dir().join(format!("librium-settings-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        settings.save(&dir).unwrap();
        assert_eq!(Settings::load(&dir).unwrap().ignore_hosts.len(), 4);
        std::fs::write(dir.join("settings.json"), "{not json").unwrap();
        assert!(
            Settings::load(&dir).is_err(),
            "a damaged file is reported, the caller falls back"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
