export const SCHEMA = `
CREATE TABLE IF NOT EXISTS kernel_sessions (
	id TEXT PRIMARY KEY,
	data TEXT NOT NULL,
	file TEXT,
	seq INTEGER NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kernel_session_events (
	session_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	type TEXT NOT NULL,
	data TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS kernel_session_snapshots (
	session_id TEXT PRIMARY KEY,
	seq INTEGER NOT NULL,
	data TEXT NOT NULL,
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kernel_approvals (
	id TEXT PRIMARY KEY,
	session_id TEXT NOT NULL,
	tool_call_id TEXT NOT NULL,
	data TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
	expires_at TEXT NOT NULL,
	created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS kernel_approvals_session ON kernel_approvals (session_id, status);

CREATE TABLE IF NOT EXISTS kernel_branches (
	session_id TEXT NOT NULL,
	branch_id TEXT NOT NULL,
	from_seq INTEGER NOT NULL,
	data TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (session_id, branch_id)
);
`;
