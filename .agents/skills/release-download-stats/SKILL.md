---
name: release-download-stats
description: Summarize PwrGit GitHub Release asset download counts and estimated transfer volume. Use for per-release or recent-release DMG, macOS updater ZIP, and Windows setup traffic; not for update-check or unique-user analytics.
---

# Release Download Stats

Use the bundled script to read cumulative GitHub Release `download_count` values
from `pwrdrvr/PwrGit`:

```bash
python3 .agents/skills/release-download-stats/scripts/release_download_stats.py
python3 .agents/skills/release-download-stats/scripts/release_download_stats.py --latest 5
python3 .agents/skills/release-download-stats/scripts/release_download_stats.py v0.25.0 v0.24.0
python3 .agents/skills/release-download-stats/scripts/release_download_stats.py --json --latest 10
```

Report the fetch time and release scope. Keep macOS updater ZIPs separate from
DMGs; keep the `PwrGit.dmg` universal and `PwrGit-arm64.dmg` stable aliases
separate from versioned DMGs. Likewise, distinguish `PwrGit.Setup.exe` from
versioned Windows setup executables. Sum aliases and versioned installers only
when a combined download count is useful, and call it asset downloads rather
than unique installations.

GitHub counts are cumulative for each asset, not daily traffic or unique
people. They can include manual downloads, CI, bots, and updater downloads.
Update-check requests for `latest-mac.yml` and `latest.yml` are outside these
installer counts. The script's GiB values estimate transfer volume as asset
size times download count; they are not measured network egress. Use UTC unless
the user requests a different timezone.
