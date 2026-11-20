//! Office: docs, sheets, slides, databases, calendar, forms.
//!
//! Every document's content is a Yjs document the runner keeps with `yrs`;
//! these types are only the metadata around it and the public face of a form.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub enum DocKind {
    Doc,
    Sheet,
    Slides,
    Database,
    Form,
}

impl DocKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DocKind::Doc => "doc",
            DocKind::Sheet => "sheet",
            DocKind::Slides => "slides",
            DocKind::Database => "database",
            DocKind::Form => "form",
        }
    }
}

/// One office document. Its content lives in `<data>/office/<ws>/<id>.ydoc`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct Doc {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub kind: DocKind,
    pub title: String,
    #[serde(default)]
    pub icon: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub created_by: String,
    /// For a form: the database it writes rows to.
    #[serde(default)]
    pub parent_id: Option<Uuid>,
}

/// Payload of the `office-update` notice: a Yjs update (base64, v1) for one doc.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct DocUpdate {
    pub id: Uuid,
    pub update: String,
    pub by: String,
    /// The sending client's session id, so it can skip its own echo.
    pub client: Option<String>,
}

/// Payload of the `office-awareness` notice: cursors and selections, never stored.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct DocAwareness {
    pub id: Uuid,
    pub state: serde_json::Value,
    pub by: String,
}

/// A question of a form as anyone with the link sees it: no internal data.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct PublicQuestion {
    /// The database field it fills.
    pub id: String,
    pub label: String,
    /// text, number, select, multi_select, date, checkbox, url, person
    pub kind: String,
    pub required: bool,
    pub help: Option<String>,
    /// Choices for select and multi-select.
    pub options: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/protocol/")]
pub struct PublicForm {
    pub id: Uuid,
    pub title: String,
    pub description: String,
    pub questions: Vec<PublicQuestion>,
}
