//! Public forms: `/f/:workspace/:form` shows a form anyone with the link can fill
//! in. The hub only relays: the runner hosting the workspace owns the form and
//! stores the answers. Plain HTML, no scripts.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::time::Duration;

use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::Form;
use cuna_protocol::office::{PublicForm, PublicQuestion};
use cuna_protocol::{HubUser, Role};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::hub::CallError;
use crate::limit::client_ip;
use crate::pages::{escape, page_in};
use crate::AppState;

const CALL_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_ANSWER_LEN: usize = 10_000;
/// A field no person sees; bots fill it in.
const HONEYPOT: &str = "_website";

/// Who a public form call comes from: nobody signed in.
pub fn anonymous() -> HubUser {
    HubUser {
        id: Uuid::nil(),
        name: "Form".into(),
        email: String::new(),
        avatar_url: None,
    }
}

fn html(status: StatusCode, title: &str, body: &str) -> Response {
    (status, Html(page_in("wide", title, body))).into_response()
}

fn message(status: StatusCode, title: &str, text: &str) -> Response {
    html(
        status,
        title,
        &format!("<h1>{}</h1><p>{}</p>", escape(title), escape(text)),
    )
}

fn too_many() -> Response {
    message(
        StatusCode::TOO_MANY_REQUESTS,
        "Slow down a little",
        "Too many requests from your network. Try again in a minute.",
    )
}

fn call_failed(e: CallError) -> Response {
    match e {
        CallError::Offline => message(
            StatusCode::SERVICE_UNAVAILABLE,
            "This form is offline",
            "The computer that keeps this form is not connected right now. Try again later.",
        ),
        CallError::Timeout => message(
            StatusCode::GATEWAY_TIMEOUT,
            "This form did not answer",
            "The computer that keeps this form took too long. Try again in a moment.",
        ),
        CallError::Remote(e) => {
            tracing::info!("public form: {e}");
            message(
                StatusCode::NOT_FOUND,
                "Form not found",
                "This form does not exist, or it no longer accepts answers.",
            )
        }
    }
}

async fn fetch(st: &AppState, ws: Uuid, form: Uuid) -> Result<PublicForm, Response> {
    let v = st
        .hub
        .call_host(
            ws,
            "get_form_public",
            json!({ "workspace_id": ws, "form_id": form }),
            anonymous(),
            Role::Commenter,
            CALL_TIMEOUT,
        )
        .await
        .map_err(call_failed)?;
    serde_json::from_value(v).map_err(|e| {
        tracing::warn!("public form {form}: unexpected shape: {e}");
        message(
            StatusCode::BAD_GATEWAY,
            "This form cannot be shown",
            "The form came back in a shape this hub does not understand.",
        )
    })
}

/// `GET /f/:workspace_id/:form_id`
pub async fn show(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path((ws, form)): Path<(Uuid, Uuid)>,
) -> Response {
    if !st.forms_view.check(client_ip(peer, &headers)) {
        return too_many();
    }
    match fetch(&st, ws, form).await {
        Ok(f) => render(&f, &HashMap::new(), &HashMap::new(), StatusCode::OK),
        Err(r) => r,
    }
}

/// `POST /f/:workspace_id/:form_id` with form-encoded answers.
pub async fn submit(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path((ws, form)): Path<(Uuid, Uuid)>,
    Form(fields): Form<Vec<(String, String)>>,
) -> Response {
    if !st.forms_submit.check(client_ip(peer, &headers)) {
        return too_many();
    }
    let mut given: HashMap<String, Vec<String>> = HashMap::new();
    for (k, v) in fields {
        given.entry(k).or_default().push(v);
    }
    if given
        .get(HONEYPOT)
        .is_some_and(|v| v.iter().any(|s| !s.is_empty()))
    {
        return thanks(None);
    }
    let f = match fetch(&st, ws, form).await {
        Ok(f) => f,
        Err(r) => return r,
    };
    let (answers, errors) = collect(&f, &given);
    if !errors.is_empty() {
        return render(&f, &given, &errors, StatusCode::UNPROCESSABLE_ENTITY);
    }
    let r = st
        .hub
        .call_host(
            ws,
            "form_submit",
            json!({ "workspace_id": ws, "form_id": form, "answers": answers }),
            anonymous(),
            Role::Commenter,
            CALL_TIMEOUT,
        )
        .await;
    match r {
        Ok(_) => thanks(Some(&f.title)),
        Err(e) => call_failed(e),
    }
}

fn thanks(title: Option<&str>) -> Response {
    let line = match title {
        Some(t) => format!("Your answers to {} were sent.", escape(t)),
        None => "Your answers were sent.".into(),
    };
    html(
        StatusCode::OK,
        "Thank you",
        &format!(r#"<div style="text-align:center"><h1>Thank you</h1><p>{line}</p></div>"#),
    )
}

/// Turns posted fields into typed answers, and says what is missing or wrong.
pub fn collect(
    f: &PublicForm,
    given: &HashMap<String, Vec<String>>,
) -> (Map<String, Value>, HashMap<String, String>) {
    let mut answers = Map::new();
    let mut errors = HashMap::new();
    for q in &f.questions {
        let vals: Vec<&str> = given
            .get(&q.id)
            .map(|v| {
                v.iter()
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        if vals.iter().any(|v| v.len() > MAX_ANSWER_LEN) {
            errors.insert(q.id.clone(), "This answer is too long.".into());
            continue;
        }
        let first = vals.first().copied();
        let value = match q.kind.as_str() {
            "checkbox" => Some(Value::Bool(first.is_some())),
            "multi_select" => {
                let picked: Vec<Value> = vals
                    .iter()
                    .filter(|v| q.options.iter().any(|o| o == *v))
                    .map(|v| Value::String(v.to_string()))
                    .collect();
                (!picked.is_empty()).then_some(Value::Array(picked))
            }
            "select" => match first {
                Some(v) if q.options.iter().any(|o| o == v) => Some(Value::String(v.into())),
                Some(_) => {
                    errors.insert(q.id.clone(), "Pick one of the options.".into());
                    continue;
                }
                None => None,
            },
            "number" => match first {
                Some(v) => match v.replace(',', ".").parse::<f64>() {
                    Ok(n) if n.is_finite() => Some(json!(n)),
                    _ => {
                        errors.insert(q.id.clone(), "Enter a number.".into());
                        continue;
                    }
                },
                None => None,
            },
            "url" => match first {
                Some(v) if v.starts_with("http://") || v.starts_with("https://") => {
                    Some(Value::String(v.into()))
                }
                Some(_) => {
                    errors.insert(q.id.clone(), "Enter a link starting with https://.".into());
                    continue;
                }
                None => None,
            },
            _ => first.map(|v| Value::String(v.into())),
        };
        let empty = match &value {
            None => true,
            Some(Value::Bool(b)) => !b,
            _ => false,
        };
        if q.required && empty {
            errors.insert(q.id.clone(), "This question needs an answer.".into());
            continue;
        }
        if let Some(v) = value {
            answers.insert(q.id.clone(), v);
        }
    }
    (answers, errors)
}

fn render(
    f: &PublicForm,
    given: &HashMap<String, Vec<String>>,
    errors: &HashMap<String, String>,
    status: StatusCode,
) -> Response {
    let mut body = format!("<h1>{}</h1>", escape(&f.title));
    if !f.description.trim().is_empty() {
        body += &format!(r#"<p class="desc">{}</p>"#, escape(f.description.trim()));
    }
    if !errors.is_empty() {
        body += r#"<div class="banner" role="alert">Some answers need another look.</div>"#;
    }
    body += r#"<form method="post" accept-charset="utf-8">"#;
    for (i, q) in f.questions.iter().enumerate() {
        body += &question(i, q, given.get(&q.id), errors.get(&q.id));
    }
    body += &format!(
        r#"<div class="hp" aria-hidden="true"><label>Leave this empty <input type="text" name="{HONEYPOT}" tabindex="-1" autocomplete="off"></label></div>
<button type="submit" class="primary">Send</button></form>"#
    );
    html(status, &f.title, &body)
}

fn question(
    i: usize,
    q: &PublicQuestion,
    given: Option<&Vec<String>>,
    error: Option<&String>,
) -> String {
    let id = format!("q{i}");
    let name = escape(&q.id);
    let label = escape(&q.label);
    let req_mark = if q.required {
        r#"<span class="req" aria-hidden="true">*</span>"#
    } else {
        ""
    };
    let req = if q.required { " required" } else { "" };
    let mut described = Vec::new();
    let help = match &q.help {
        Some(h) if !h.trim().is_empty() => {
            described.push(format!("{id}-help"));
            format!(r#"<p class="help" id="{id}-help">{}</p>"#, escape(h))
        }
        _ => String::new(),
    };
    let err = match error {
        Some(e) => {
            described.push(format!("{id}-err"));
            format!(r#"<p class="err" id="{id}-err">{}</p>"#, escape(e))
        }
        None => String::new(),
    };
    let aria = if described.is_empty() {
        String::new()
    } else {
        format!(r#" aria-describedby="{}""#, described.join(" "))
    };
    let invalid = if error.is_some() {
        r#" aria-invalid="true""#
    } else {
        ""
    };
    let first = given
        .and_then(|v| v.first())
        .map(|s| escape(s))
        .unwrap_or_default();
    let has = |opt: &str| given.is_some_and(|v| v.iter().any(|s| s == opt));

    let group = |kind: &str| {
        let mut opts = String::new();
        for (j, o) in q.options.iter().enumerate() {
            let checked = if has(o) { " checked" } else { "" };
            // A required radio group: `required` on one input covers the group.
            let r = if kind == "radio" && j == 0 { req } else { "" };
            opts += &format!(
                r#"<label class="opt"><input type="{kind}" name="{name}" value="{v}"{checked}{r}> {v}</label>"#,
                v = escape(o)
            );
        }
        format!(
            r#"<fieldset class="q"{aria}{invalid}><legend>{label}{req_mark}</legend>{help}{opts}{err}</fieldset>"#
        )
    };

    match q.kind.as_str() {
        "checkbox" => {
            let checked = if given.is_some_and(|v| !v.is_empty()) {
                " checked"
            } else {
                ""
            };
            format!(
                r#"<div class="q">{help}<label class="opt"><input type="checkbox" id="{id}" name="{name}" value="yes"{checked}{req}{aria}{invalid}> {label}{req_mark}</label>{err}</div>"#
            )
        }
        "multi_select" => group("checkbox"),
        "select" if q.options.len() <= 5 => group("radio"),
        "select" => {
            let mut opts = String::from(r#"<option value="">Choose…</option>"#);
            for o in &q.options {
                let sel = if has(o) { " selected" } else { "" };
                opts += &format!(r#"<option{sel}>{}</option>"#, escape(o));
            }
            format!(
                r#"<div class="q"><label for="{id}">{label}{req_mark}</label>{help}<select id="{id}" name="{name}"{req}{aria}{invalid}>{opts}</select>{err}</div>"#
            )
        }
        "long_text" | "textarea" => format!(
            r#"<div class="q"><label for="{id}">{label}{req_mark}</label>{help}<textarea id="{id}" name="{name}"{req}{aria}{invalid}>{first}</textarea>{err}</div>"#
        ),
        kind => {
            let (ty, extra) = match kind {
                "number" => ("number", r#" step="any" inputmode="decimal""#),
                "date" => ("date", ""),
                "url" => ("url", r#" placeholder="https://""#),
                "email" => ("email", r#" autocomplete="email""#),
                _ => ("text", ""),
            };
            format!(
                r#"<div class="q"><label for="{id}">{label}{req_mark}</label>{help}<input type="{ty}" id="{id}" name="{name}" value="{first}"{extra}{req}{aria}{invalid}>{err}</div>"#
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(id: &str, kind: &str, required: bool, options: &[&str]) -> PublicQuestion {
        PublicQuestion {
            id: id.into(),
            label: id.into(),
            kind: kind.into(),
            required,
            help: None,
            options: options.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn typed_answers_and_errors() {
        let f = PublicForm {
            id: Uuid::nil(),
            title: "T".into(),
            description: String::new(),
            questions: vec![
                q("name", "text", true, &[]),
                q("age", "number", false, &[]),
                q("ok", "checkbox", true, &[]),
                q("tags", "multi_select", false, &["a", "b"]),
                q("size", "select", false, &["s", "m"]),
            ],
        };
        let mut given = HashMap::new();
        given.insert("name".to_string(), vec!["  Ada ".to_string()]);
        given.insert("age".to_string(), vec!["3,5".to_string()]);
        given.insert(
            "tags".to_string(),
            vec!["a".to_string(), "x".to_string(), "b".to_string()],
        );
        given.insert("size".to_string(), vec!["xl".to_string()]);
        let (a, e) = collect(&f, &given);
        assert_eq!(a["name"], "Ada");
        assert_eq!(a["age"], 3.5);
        assert_eq!(a["tags"], json!(["a", "b"]));
        assert!(e.contains_key("ok"));
        assert!(e.contains_key("size"));
    }
}
