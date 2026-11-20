-- Chat threads, reactions, pins and channels.

ALTER TABLE chat_messages ADD COLUMN parent_id TEXT REFERENCES chat_messages(id) ON DELETE CASCADE;
ALTER TABLE chat_messages ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
CREATE INDEX chat_messages_parent ON chat_messages(parent_id, at);

-- One row per (message, person, emoji); reacting again removes it.
CREATE TABLE chat_reactions (
    message_id  TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji       TEXT NOT NULL,
    at          INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
);

-- Channels people created; `general` is implicit.
CREATE TABLE chat_channels (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, name)
);
