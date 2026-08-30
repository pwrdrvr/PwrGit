-- A profile can fix its own window palette while every existing profile keeps
-- inheriting the app-level System/Dark/Light setting.
ALTER TABLE profiles ADD COLUMN theme TEXT
  CHECK (theme IS NULL OR theme IN ('dark', 'light'));
