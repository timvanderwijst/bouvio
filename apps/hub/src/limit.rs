//! Fixed-window rate limits for unauthenticated pages, keyed by client IP.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::http::HeaderMap;

pub struct Limiter {
    window: Duration,
    max: u32,
    hits: Mutex<HashMap<IpAddr, (Instant, u32)>>,
}

impl Limiter {
    pub fn new(max: u32, window: Duration) -> Self {
        Limiter {
            window,
            max,
            hits: Mutex::default(),
        }
    }

    /// Counts a hit; false when this IP is over its limit for the window.
    pub fn check(&self, ip: IpAddr) -> bool {
        let now = Instant::now();
        let mut hits = self.hits.lock().unwrap_or_else(|e| e.into_inner());
        if hits.len() > 10_000 {
            hits.retain(|_, (start, _)| now.duration_since(*start) < self.window);
        }
        let entry = hits.entry(ip).or_insert((now, 0));
        if now.duration_since(entry.0) >= self.window {
            *entry = (now, 0);
        }
        entry.1 += 1;
        entry.1 <= self.max
    }
}

/// The client's address. Behind a reverse proxy on the same machine or private
/// network (Caddy in compose.yml), the last `X-Forwarded-For` hop is the client.
pub fn client_ip(peer: SocketAddr, headers: &HeaderMap) -> IpAddr {
    let ip = peer.ip();
    let proxied = match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_private(),
        IpAddr::V6(v6) => v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00,
    };
    if proxied {
        if let Some(fwd) = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.rsplit(',').next())
            .and_then(|v| v.trim().parse().ok())
        {
            return fwd;
        }
    }
    ip
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_per_ip() {
        let l = Limiter::new(2, Duration::from_secs(60));
        let a: IpAddr = "1.2.3.4".parse().unwrap();
        let b: IpAddr = "5.6.7.8".parse().unwrap();
        assert!(l.check(a) && l.check(a));
        assert!(!l.check(a));
        assert!(l.check(b));
    }

    #[test]
    fn forwarded_only_from_a_local_proxy() {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", "9.9.9.9, 8.8.8.8".parse().unwrap());
        let local: SocketAddr = "127.0.0.1:1".parse().unwrap();
        let public: SocketAddr = "1.1.1.1:1".parse().unwrap();
        assert_eq!(client_ip(local, &h), "8.8.8.8".parse::<IpAddr>().unwrap());
        assert_eq!(client_ip(public, &h), "1.1.1.1".parse::<IpAddr>().unwrap());
    }
}
