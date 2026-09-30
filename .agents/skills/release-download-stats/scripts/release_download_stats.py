#!/usr/bin/env python3
"""Summarize PwrGit GitHub Release asset download counts."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from datetime import datetime, timezone
from typing import Any


DEFAULT_REPO = "pwrdrvr/PwrGit"
CATEGORIES = {
    "mac_zip": "macOS updater ZIPs",
    "universal_dmg_alias": "PwrGit.dmg alias",
    "arm64_dmg_alias": "PwrGit-arm64.dmg alias",
    "versioned_dmg": "Versioned DMGs",
    "setup_alias": "PwrGit.Setup.exe alias",
    "versioned_setup": "Versioned Windows setups",
}
GIB = 1_073_741_824


def fetch_releases(repo: str) -> list[dict[str, Any]]:
    if not shutil.which("gh"):
        raise SystemExit("gh CLI is not installed or not on PATH")

    result = subprocess.run(
        ["gh", "api", "--paginate", "--slurp", f"repos/{repo}/releases?per_page=100"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        raise SystemExit(result.stderr.strip() or "gh api failed")

    try:
        pages = json.loads(result.stdout)
        if not isinstance(pages, list) or any(not isinstance(page, list) for page in pages):
            raise ValueError("expected paginated release arrays")
        return [release for page in pages for release in page]
    except (json.JSONDecodeError, ValueError) as exc:
        raise SystemExit(f"failed to parse GitHub releases: {exc}") from exc


def select_releases(
    releases: list[dict[str, Any]], tags: list[str], latest: int | None
) -> list[dict[str, Any]]:
    published = sorted(
        (release for release in releases if not release.get("draft")),
        key=lambda release: str(release.get("published_at") or release.get("created_at") or ""),
        reverse=True,
    )
    if latest is not None:
        return published[:latest]
    if not tags:
        return published

    by_tag = {str(release.get("tag_name")): release for release in published}
    selected = []
    missing = []
    for tag in tags:
        release = by_tag.get(tag) or by_tag.get(f"v{tag}")
        if release is None:
            missing.append(tag)
        else:
            selected.append(release)
    if missing:
        recent = ", ".join(str(release.get("tag_name")) for release in published[:10])
        raise SystemExit(f"release tag not found: {', '.join(missing)}. Recent tags: {recent}")
    return selected


def classify_asset(name: str) -> str | None:
    if name == "PwrGit.dmg":
        return "universal_dmg_alias"
    if name == "PwrGit-arm64.dmg":
        return "arm64_dmg_alias"
    if name == "PwrGit.Setup.exe":
        return "setup_alias"
    if name.startswith("PwrGit-") and name.endswith("-mac.zip"):
        return "mac_zip"
    if name.startswith("PwrGit-") and name.endswith(".dmg"):
        return "versioned_dmg"
    if name.startswith("PwrGit-") and name.endswith("-setup.exe"):
        return "versioned_setup"
    return None


def collect_assets(releases: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = []
    for release in releases:
        for asset in release.get("assets") or []:
            name = str(asset.get("name") or "")
            category = classify_asset(name)
            if category is None:
                continue
            size = int(asset.get("size") or 0)
            downloads = int(asset.get("download_count") or 0)
            rows.append(
                {
                    "tag": release.get("tag_name"),
                    "asset": name,
                    "category": category,
                    "size_bytes": size,
                    "downloads": downloads,
                    "estimated_bytes": size * downloads,
                    "url": asset.get("browser_download_url"),
                }
            )
    return rows


def totals(rows: list[dict[str, Any]]) -> dict[str, dict[str, int | float]]:
    result: dict[str, dict[str, int | float]] = {}
    for category in CATEGORIES:
        matching = [row for row in rows if row["category"] == category]
        downloads = sum(row["downloads"] for row in matching)
        estimated_bytes = sum(row["estimated_bytes"] for row in matching)
        result[category] = {
            "downloads": downloads,
            "estimated_bytes": estimated_bytes,
            "estimated_gib": round(estimated_bytes / GIB, 2),
        }
    return result


def by_release(
    releases: list[dict[str, Any]], rows: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    summaries = []
    for release in releases:
        tag = str(release.get("tag_name"))
        release_rows = [row for row in rows if row["tag"] == tag]
        summaries.append(
            {
                "tag": tag,
                "published_at": release.get("published_at"),
                "prerelease": bool(release.get("prerelease")),
                "totals": totals(release_rows),
            }
        )
    return summaries


def markdown_table(headers: list[str], rows: list[list[Any]]) -> str:
    lines = [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
    ]
    lines.extend("| " + " | ".join(str(cell) for cell in row) + " |" for row in rows)
    return "\n".join(lines)


def print_markdown(data: dict[str, Any]) -> None:
    print(f"Repository: `{data['repo']}`")
    print(f"Fetched: {data['fetched_at']}")
    print(f"Releases included: {data['release_count']}")
    print()
    print("## Totals")
    print()
    print(
        markdown_table(
            ["Asset group", "Downloads", "Estimated GiB"],
            [
                [CATEGORIES[category], values["downloads"], values["estimated_gib"]]
                for category, values in data["totals"].items()
            ],
        )
    )
    print()
    print("## By Release")
    print()
    print(
        markdown_table(
            ["Published (UTC)", "Tag", "mac ZIP", "PwrGit.dmg", "arm64 alias", "Versioned DMG", "Setup alias", "Versioned setup"],
            [
                [
                    item["published_at"],
                    item["tag"],
                    *[item["totals"][category]["downloads"] for category in CATEGORIES],
                ]
                for item in data["by_release"]
            ],
        )
    )
    print()
    print("## Asset Details")
    print()
    print(
        markdown_table(
            ["Tag", "Asset", "Size MiB", "Downloads", "Estimated GiB"],
            [
                [
                    row["tag"],
                    row["asset"],
                    round(row["size_bytes"] / 1_048_576, 1),
                    row["downloads"],
                    round(row["estimated_bytes"] / GIB, 2),
                ]
                for row in data["assets"]
            ],
        )
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tags", nargs="*", help="Exact release tags, with optional leading v")
    parser.add_argument("--repo", default=DEFAULT_REPO, help=f"GitHub repo (default: {DEFAULT_REPO})")
    parser.add_argument("--latest", type=int, help="Include the latest N published releases")
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of Markdown")
    args = parser.parse_args()
    if args.latest is not None and args.latest <= 0:
        parser.error("--latest must be positive")
    if args.tags and args.latest is not None:
        parser.error("pass either release tags or --latest")

    releases = select_releases(fetch_releases(args.repo), args.tags, args.latest)
    rows = collect_assets(releases)
    data = {
        "repo": args.repo,
        "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        "release_count": len(releases),
        "totals": totals(rows),
        "by_release": by_release(releases, rows),
        "assets": rows,
    }
    if args.json:
        print(json.dumps(data, indent=2))
    else:
        print_markdown(data)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
