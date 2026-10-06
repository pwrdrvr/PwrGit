-- A profile can be left out of the Profiles menu. Hidden profiles keep their
-- data and still open from Settings → Profiles; they just take no menu row and
-- no ⌘1–⌘9 slot. Every existing profile stays visible.
ALTER TABLE profiles ADD COLUMN show_in_menu INTEGER NOT NULL DEFAULT 1;
