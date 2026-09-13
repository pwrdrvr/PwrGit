-- First-run setup is per profile, because PwrGit is one window per profile: a
-- second profile is a second first run, and should get the same guidance.
ALTER TABLE profiles ADD COLUMN onboarding_completed INTEGER NOT NULL DEFAULT 0;

-- Every profile that exists when this migration runs belongs to someone who
-- already set PwrGit up by hand. The wizard is for a first run, not a surprise
-- on upgrade, so they are marked done. A fresh install migrates an empty table
-- and then seeds its profile, which picks up the 0 default and fires the wizard.
UPDATE profiles SET onboarding_completed = 1;
