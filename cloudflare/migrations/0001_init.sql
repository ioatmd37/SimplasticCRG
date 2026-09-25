-- One row per consenting player per game. No names, room codes or IPs are stored:
-- `id` is a random UUID minted by the game server for that player's game, used only
-- so the exit ticket and the satisfaction rating (sent at different times) land in one row.
CREATE TABLE responses (
  id              TEXT PRIMARY KEY,
  play_date       TEXT NOT NULL,     -- YYYY-MM-DD only
  case_id         TEXT NOT NULL,
  role            TEXT,
  case_rating     INTEGER CHECK (case_rating BETWEEN 1 AND 5),
  players_rating  INTEGER CHECK (players_rating BETWEEN 1 AND 5),
  system_rating   INTEGER CHECK (system_rating BETWEEN 1 AND 5),
  comment         TEXT,
  one_liner       TEXT,
  must_not_miss   TEXT,
  s1_s2_trigger   TEXT
);
CREATE INDEX responses_case ON responses (case_id);
CREATE INDEX responses_date ON responses (play_date);
