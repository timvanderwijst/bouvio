//! Communication: what the runner does for chat. `@Lead do this` in a shared
//! workspace this runner hosts starts a thread under that lead and answers in
//! the chat thread: once when it starts, once when the turn is done.

use crate::hub::HubClient;
use crate::Runner;
use anyhow::Result;
use bouvio_protocol::*;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast::error::RecvError;
use uuid::Uuid;

/// How much of the agent's answer goes back into chat.
const ANSWER_CHARS: usize = 600;
/// Stop waiting for a turn after this long; the thread itself keeps going.
const MAX_WAIT: Duration = Duration::from_secs(4 * 60 * 60);

pub async fn call(_r: &Arc<Runner>, _method: &str, _params: &Value, _actor: &str) -> Option<Result<Value>> {
    None
}

pub fn workspace_of(_r: &Runner, _method: &str, _params: &Value) -> Option<Result<Uuid>> {
    None
}

pub fn start(_r: &Arc<Runner>) {}

/// The lead a message is addressed to, and the rest of the message. The
/// longest name wins, so `@Design Lead` beats `@Design`; case does not matter.
pub fn mentioned<'a, 'c>(leads: &'c [Lead], text: &'a str) -> Option<(&'c Lead, &'a str)> {
    let rest = text.trim_start().strip_prefix('@')?;
    let lower = rest.to_lowercase();
    leads
        .iter()
        .filter(|c| !c.name.trim().is_empty())
        .filter_map(|c| {
            let name = c.name.trim().to_lowercase();
            if !lower.starts_with(&name) {
                return None;
            }
            // Lowercasing can change byte lengths; walk the original by chars.
            let cut = rest.char_indices().nth(name.chars().count()).map(|(i, _)| i).unwrap_or(rest.len());
            let after = &rest[cut..];
            let boundary = after.chars().next().is_none_or(|ch| !(ch.is_alphanumeric() || ch == '_' || ch == '-'));
            boundary.then_some((c, name.chars().count(), after))
        })
        .max_by_key(|(_, len, _)| *len)
        .map(|(c, _, after)| (c, after.trim_start_matches([':', ',']).trim()))
}

/// A hub chat message arrived for a workspace this runner hosts.
pub fn on_chat(r: &Arc<Runner>, hub: &Arc<HubClient>, msg: &ChatMessage) {
    if msg.parent.is_some() || !msg.text.trim_start().starts_with('@') {
        return;
    }
    let leads = r.leads(msg.workspace_id);
    let Some((lead, prompt)) = mentioned(&leads, &msg.text) else { return };
    let (lead, prompt) = (lead.clone(), prompt.to_string());
    tokio::spawn(run(r.clone(), hub.clone(), msg.clone(), lead, prompt));
}

fn reply(hub: &HubClient, msg: &ChatMessage, text: String) {
    hub.send(ClientMsg::ChatReply { workspace_id: msg.workspace_id, parent: msg.id, text });
}

fn link(t: &Thread) -> String {
    format!("[{}](bouvio://thread/{})", t.title.replace(['[', ']'], ""), t.id)
}

pub fn truncate(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max).collect();
    // End on a word when one is near.
    let cut = match cut.rfind(char::is_whitespace) {
        Some(i) if i > max * 3 / 4 => cut[..i].to_string(),
        _ => cut,
    };
    format!("{}…", cut.trim_end())
}

async fn run(r: Arc<Runner>, hub: Arc<HubClient>, msg: ChatMessage, lead: Lead, prompt: String) {
    // Running an agent is `send_message`; whoever asks in chat needs that role too.
    let needed = required_role("send_message");
    let me = hub.me();
    if me.as_ref().map(|u| u.id) != Some(msg.author.id) {
        let role = match hub.members(msg.workspace_id).await {
            Ok(list) => list.into_iter().find(|m| m.user.id == msg.author.id).map(|m| m.role),
            Err(e) => {
                tracing::warn!("comms: members of {}: {e:#}", msg.workspace_id);
                None
            }
        };
        if role.is_none_or(|r| r < needed) {
            let name = serde_json::to_value(needed).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
            return reply(&hub, &msg, format!("Only people with role {name} or higher can ask {} to work.", lead.name));
        }
    }
    if prompt.is_empty() {
        return reply(&hub, &msg, format!("Tell {} what to do after the mention.", lead.name));
    }

    let isolate = r.workspace(msg.workspace_id).is_some_and(|w| w.root.is_some());
    let thread = match r
        .create_thread(NewThread {
            workspace_id: msg.workspace_id,
            lead_id: Some(lead.id),
            title: None,
            harness: lead.harness,
            model: lead.model.clone(),
            effort: lead.effort,
            approval: lead.approval,
            isolate,
        })
        .await
    {
        Ok(t) => t,
        Err(e) => return reply(&hub, &msg, format!("{} could not start: {e:#}", lead.name)),
    };
    // Subscribe before sending, so a fast turn is not missed.
    let mut events = r.subscribe_events();
    if let Err(e) = r.send_message(thread.id, prompt, msg.author.name.clone()).await {
        return reply(&hub, &msg, format!("{} could not start: {e:#}", lead.name));
    }
    let thread = r.thread(thread.id).unwrap_or(thread);
    reply(&hub, &msg, format!("Started {}", link(&thread)));

    let outcome = tokio::time::timeout(MAX_WAIT, async {
        let mut asked = false;
        loop {
            match events.recv().await {
                Ok(env) if env.thread_id == thread.id => match env.event {
                    ThreadEvent::TurnComplete { .. } => return Ok(()),
                    ThreadEvent::Error { message } => return Err(message),
                    ThreadEvent::Status { status: AgentStatus::Blocked } if !asked => {
                        asked = true;
                        let t = r.thread(thread.id).unwrap_or_else(|| thread.clone());
                        reply(&hub, &msg, format!("{} is waiting for an approval in {}", lead.name, link(&t)));
                    }
                    ThreadEvent::Status { status: AgentStatus::Error } => return Err("the agent stopped with an error".to_string()),
                    _ => {}
                },
                Ok(_) => {}
                Err(RecvError::Lagged(_)) => {
                    // Missed some events: look at where the thread is now.
                    match r.thread(thread.id).map(|t| t.status) {
                        Some(AgentStatus::Idle | AgentStatus::Done) => return Ok(()),
                        Some(AgentStatus::Error) => return Err("the agent stopped with an error".to_string()),
                        _ => {}
                    }
                }
                Err(RecvError::Closed) => return Err("the runner stopped".to_string()),
            }
        }
    })
    .await;

    let t = r.thread(thread.id).unwrap_or(thread);
    let text = match outcome {
        Ok(Ok(())) => {
            let answer = r
                .thread_events(t.id)
                .unwrap_or_default()
                .into_iter()
                .rev()
                .find_map(|e| match e.event {
                    ThreadEvent::AssistantText { text } if !text.trim().is_empty() => Some(text),
                    _ => None,
                });
            match answer {
                Some(a) => format!("{}\n\n{}", truncate(&a, ANSWER_CHARS), link(&t)),
                None => format!("Done, without a written answer. {}", link(&t)),
            }
        }
        Ok(Err(e)) => format!("Stopped: {}. {}", truncate(&e, 300), link(&t)),
        // Still working after hours: say so and stop watching.
        Err(_) => format!("Still working on {}", link(&t)),
    };
    reply(&hub, &msg, text);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lead(name: &str) -> Lead {
        Lead {
            id: Uuid::new_v4(),
            workspace_id: Uuid::nil(),
            name: name.into(),
            instructions: String::new(),
            harness: HarnessKind::ClaudeCode,
            model: None,
            effort: Effort::Medium,
            approval: ApprovalLevel::AskRisky,
            avatar_seed: 1,
        }
    }

    #[test]
    fn finds_the_mentioned_lead() {
        let cs = [lead("Design"), lead("Design Lead"), lead("Hub")];
        let (c, rest) = mentioned(&cs, "@design lead: pick a font").unwrap();
        assert_eq!(c.name, "Design Lead");
        assert_eq!(rest, "pick a font");
        let (c, rest) = mentioned(&cs, "  @HUB, restart please").unwrap();
        assert_eq!(c.name, "Hub");
        assert_eq!(rest, "restart please");
        assert_eq!(mentioned(&cs, "@Design").map(|(c, r)| (c.name.as_str(), r)), Some(("Design", "")));
        assert!(mentioned(&cs, "@Hubert hi").is_none());
        assert!(mentioned(&cs, "hey @Hub").is_none());
        assert!(mentioned(&cs, "@nobody").is_none());
    }

    #[test]
    fn truncates_on_a_word() {
        assert_eq!(truncate("short", 10), "short");
        let t = truncate(&"word ".repeat(200), 600);
        assert!(t.ends_with('…') && t.chars().count() <= 601);
        assert_eq!(truncate("ééééé", 3), "ééé…");
    }
}
