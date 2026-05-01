CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  work TEXT NOT NULL,
  template_id TEXT NOT NULL,
  status TEXT NOT NULL,
  current_phase_idx INTEGER DEFAULT 0,
  yolo BOOLEAN DEFAULT 0,
  attached_files TEXT,
  -- Optional absolute path to the user's repo for the Ship phase. When set,
  -- doer cwd is this path (real edits land in the user's working tree).
  -- When unset, ship phase auto-skips and chat ends `approved`.
  repo_path TEXT,
  -- PR URL written by the Ship phase on success (status=merged).
  pr_url TEXT,
  -- Failure context written when ship fails (status=blocked).
  ship_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS phase_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  phase_idx INTEGER NOT NULL,
  phase_kind TEXT NOT NULL,
  role TEXT NOT NULL,
  agent_id TEXT,
  state TEXT NOT NULL,
  output TEXT,
  cost_usd REAL DEFAULT 0,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  FOREIGN KEY (chat_id) REFERENCES chats(id)
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  yaml TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS secrets (
  provider TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  meta TEXT,
  updated_at INTEGER NOT NULL
);

-- Personas: a worldview/role a reviewer wears (system prompt + metadata).
-- Built-ins are seeded from prompts/personas/*.md on daemon startup.
-- Users can clone a built-in, edit, and save as their own (builtin=0).
CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  one_liner TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  recommended_lineage TEXT,
  builtin INTEGER NOT NULL DEFAULT 0,
  forked_from TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chats_status ON chats(status);
CREATE INDEX IF NOT EXISTS idx_phase_events_chat ON phase_events(chat_id, phase_idx);
