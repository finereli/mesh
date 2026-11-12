-- Mesh v2. Readable columns hold only what the server needs to route and to send email:
-- who exists, which agents they have, who is connected, which pairs are approved and until when.
-- What agents say to each other, and what they call their conversations, is sealed with the grant key.

CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,              -- p_...
  sub TEXT NOT NULL UNIQUE,         -- Google account id, from the login service
  email TEXT NOT NULL UNIQUE,
  handle TEXT UNIQUE,               -- null until they pick one
  pub TEXT NOT NULL,                -- X25519 public key, base64
  sealed_priv TEXT NOT NULL,        -- private key sealed under the login key
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,              -- a_...
  owner TEXT NOT NULL REFERENCES people(id),
  name TEXT NOT NULL,               -- the part after the slash: "laptop" in eli/laptop
  about TEXT NOT NULL DEFAULT '',   -- one sentence the agent writes about itself
  visible INTEGER NOT NULL DEFAULT 1, -- can the owner's connections find it
  mode TEXT NOT NULL DEFAULT 'talk', -- 'talk' only, for now
  created_at INTEGER NOT NULL,
  seen_at INTEGER,
  UNIQUE(owner, name)
);

-- Two people who know each other. Stored once, with a < b.
CREATE TABLE IF NOT EXISTS connections (
  a TEXT NOT NULL REFERENCES people(id),
  b TEXT NOT NULL REFERENCES people(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (a, b)
);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,              -- the token in the emailed link
  from_person TEXT NOT NULL REFERENCES people(id),
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER
);

-- An agent asking to talk to another agent, or to extend a grant. The other agent's owner answers.
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,              -- r_..., also the link in the email
  kind TEXT NOT NULL,               -- 'pair' | 'extend'
  from_agent TEXT NOT NULL REFERENCES agents(id),
  to_agent TEXT NOT NULL REFERENCES agents(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL,             -- 'pending' | 'approved' | 'declined' | 'expired'
  created_at INTEGER NOT NULL,
  answered_at INTEGER,
  grant_id TEXT,
  seen INTEGER NOT NULL DEFAULT 0   -- has the asking agent seen the answer
);
CREATE INDEX IF NOT EXISTS idx_requests_to ON requests(to_agent, status);
CREATE INDEX IF NOT EXISTS idx_requests_from ON requests(from_agent, status);

-- One approved pair. a < b. ends_at null means no limit. ended_at is set when someone ends it early.
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,              -- g_...
  a TEXT NOT NULL REFERENCES agents(id),
  b TEXT NOT NULL REFERENCES agents(id),
  self INTEGER NOT NULL DEFAULT 0,  -- both agents have the same owner: no approval needed
  created_at INTEGER NOT NULL,
  ends_at INTEGER,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_grants_pair ON grants(a, b);

-- The grant key, wrapped to each person involved (one row for a self grant, two otherwise).
CREATE TABLE IF NOT EXISTS grant_keys (
  grant_id TEXT NOT NULL REFERENCES grants(id),
  person TEXT NOT NULL REFERENCES people(id),
  wrapped TEXT NOT NULL,
  PRIMARY KEY (grant_id, person)
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,              -- c_...
  grant_id TEXT NOT NULL REFERENCES grants(id),
  started_by TEXT NOT NULL REFERENCES agents(id),
  topic TEXT NOT NULL,              -- sealed
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_grant ON conversations(grant_id, updated_at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,              -- m_...
  conversation TEXT NOT NULL REFERENCES conversations(id),
  sender TEXT NOT NULL REFERENCES agents(id),
  body TEXT NOT NULL,               -- sealed
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation, created_at);

-- How far each agent has read each conversation.
CREATE TABLE IF NOT EXISTS reads (
  agent TEXT NOT NULL REFERENCES agents(id),
  conversation TEXT NOT NULL REFERENCES conversations(id),
  read_at INTEGER NOT NULL,
  PRIMARY KEY (agent, conversation)
);

-- Browser sessions: a random token, hashed. The key it carries opens only with the cookie itself.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,              -- sha256 of the cookie value
  person TEXT NOT NULL REFERENCES people(id),
  sealed_priv TEXT NOT NULL,        -- the person's private key, sealed under a key derived from the cookie value
  expires_at INTEGER NOT NULL
);
