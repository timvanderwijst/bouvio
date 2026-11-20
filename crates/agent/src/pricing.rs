//! What a call cost, from token usage and list prices (USD per million tokens).
//! OpenRouter reports the cost itself; for direct keys we use this table, and an
//! unknown model gives no cost rather than a wrong one.

use crate::provider::Usage;
use bouvio_protocol::ProviderKind;

use ProviderKind::{Anthropic as A, Google as G, OpenAi as O};

/// (provider, model id, input, output)
const PRICES: &[(ProviderKind, &str, f64, f64)] = &[
    (A, "claude-fable-5-2", 8.0, 40.0),
    (A, "claude-mythos-5-2", 8.0, 40.0),
    (A, "claude-fable-5-1", 10.0, 50.0),
    (A, "claude-mythos-5-1", 10.0, 50.0),
    (A, "claude-fable-5", 10.0, 50.0),
    (A, "claude-opus-5-5", 4.0, 20.0),
    (A, "claude-opus-5", 5.0, 25.0),
    (A, "claude-opus-4-8", 5.0, 25.0),
    (A, "claude-opus-4-7", 5.0, 25.0),
    (A, "claude-opus-4-6", 5.0, 25.0),
    (A, "claude-opus-4-5", 5.0, 25.0),
    (A, "claude-opus-4-1", 15.0, 75.0),
    (A, "claude-opus-4", 15.0, 75.0),
    (A, "claude-sonnet-5-5", 2.0, 10.0),
    (A, "claude-sonnet-5", 2.0, 10.0),
    (A, "claude-sonnet-4-6", 3.0, 15.0),
    (A, "claude-sonnet-4-5", 3.0, 15.0),
    (A, "claude-sonnet-4", 3.0, 15.0),
    (A, "claude-3-7-sonnet", 3.0, 15.0),
    (A, "claude-haiku-5-5", 0.10, 0.50),
    (A, "claude-haiku-4-5", 1.0, 5.0),
    (A, "claude-3-5-haiku", 0.80, 4.0),
    (O, "gpt-5", 1.25, 10.0),
    (O, "gpt-5-mini", 0.25, 2.0),
    (O, "gpt-5-nano", 0.05, 0.40),
    (O, "gpt-4.1", 2.0, 8.0),
    (O, "gpt-4.1-mini", 0.40, 1.60),
    (O, "gpt-4.1-nano", 0.10, 0.40),
    (O, "gpt-4o", 2.50, 10.0),
    (O, "gpt-4o-mini", 0.15, 0.60),
    (O, "o3", 2.0, 8.0),
    (O, "o3-mini", 1.10, 4.40),
    (O, "o4-mini", 1.10, 4.40),
    (G, "gemini-2.5-pro", 1.25, 10.0),
    (G, "gemini-2.5-flash", 0.30, 2.50),
    (G, "gemini-2.5-flash-lite", 0.10, 0.40),
    (G, "gemini-2.0-flash", 0.10, 0.40),
];

/// List price for a model, matching the exact id or the id plus a date suffix
/// (`gpt-4.1-2025-04-14`, `claude-3-5-haiku-20241022`).
pub(crate) fn price(provider: ProviderKind, model: &str) -> Option<(f64, f64)> {
    let model = model.strip_prefix("models/").unwrap_or(model);
    PRICES
        .iter()
        .filter(|(p, id, ..)| {
            *p == provider
                && model.strip_prefix(id).is_some_and(|rest| rest.is_empty() || rest.starts_with("-20") || rest.starts_with('@'))
        })
        .max_by_key(|(_, id, ..)| id.len())
        .map(|(_, _, i, o)| (*i, *o))
}

/// Cost of one call. Anthropic cache writes cost 1.25× input, reads 0.1×.
pub(crate) fn cost(provider: ProviderKind, model: &str, u: &Usage) -> Option<f64> {
    if let Some(c) = u.cost {
        return Some(c);
    }
    if provider == ProviderKind::Local {
        return Some(0.0);
    }
    let (pin, pout) = price(provider, model)?;
    let input = u.input as f64 * pin + u.cache_write as f64 * pin * 1.25 + u.cache_read as f64 * pin * 0.1;
    Some((input + u.output as f64 * pout) / 1_000_000.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn prices_match_exact_or_dated_ids() {
        assert_eq!(price(A, "claude-opus-5-5"), Some((4.0, 20.0)));
        assert_eq!(price(A, "claude-opus-5"), Some((5.0, 25.0)));
        assert_eq!(price(A, "claude-3-5-haiku-20241022"), Some((0.8, 4.0)));
        assert_eq!(price(O, "gpt-4.1-mini"), Some((0.4, 1.6)));
        assert_eq!(price(O, "gpt-4.1-2025-04-14"), Some((2.0, 8.0)));
        assert_eq!(price(G, "models/gemini-2.5-pro"), Some((1.25, 10.0)));
        // A newer model we don't know is not priced as an older one.
        assert_eq!(price(A, "claude-opus-5-7"), None);
        assert_eq!(price(ProviderKind::OpenRouter, "anthropic/claude-sonnet-4.5"), None);
    }

    #[test]
    fn computes_cost() {
        let u = Usage { input: 2000, output: 150, cache_read: 10000, cache_write: 1000, cost: None };
        // sonnet 4.5: 3/15 per M
        let want = (2000.0 * 3.0 + 1000.0 * 3.75 + 10000.0 * 0.3 + 150.0 * 15.0) / 1e6;
        assert!(close(cost(A, "claude-sonnet-4-5", &u).unwrap(), want));
        let reported = Usage { cost: Some(0.0153), ..Default::default() };
        assert_eq!(cost(ProviderKind::OpenRouter, "x/y", &reported), Some(0.0153));
        assert_eq!(cost(ProviderKind::OpenRouter, "x/y", &Usage::default()), None);
        let u = Usage { input: 1_000_000, output: 1_000_000, ..Default::default() };
        assert!(close(cost(O, "gpt-4.1", &u).unwrap(), 10.0));
        assert_eq!(cost(ProviderKind::Local, "qwen3:8b", &u), Some(0.0));
    }
}
