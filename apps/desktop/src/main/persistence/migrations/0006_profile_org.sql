-- Per-profile default GitHub org/owner for new repos (e.g. "pwrdrvr", "Giphy").
-- Stored now; consumed when clone/create lands.
ALTER TABLE profiles ADD COLUMN org TEXT;
