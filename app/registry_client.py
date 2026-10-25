"""npm and PyPI registry clients for version lookups."""

from __future__ import annotations

import re

import httpx

TIMEOUT = 12


async def check_npm(
    client: httpx.AsyncClient, package: str
) -> tuple[str, str]:
    """Return (latest_version, github_repo_url) for an npm package.

    Uses the npm public registry — no auth needed, generous rate limits.
    """
    try:
        # Fetch abbreviated metadata (faster than full doc)
        resp = await client.get(
            f"https://registry.npmjs.org/{package}",
            headers={"Accept": "application/vnd.npm.install-v1+json"},
            timeout=TIMEOUT,
        )
        if resp.status_code != 200:
            return "unknown", ""

        data = resp.json()
        latest = data.get("dist-tags", {}).get("latest", "unknown")

        # Determine GitHub repo URL from repository field
        # Need the full document for this — use a separate HEAD-less call
        repo_url = ""
        full_resp = await client.get(
            f"https://registry.npmjs.org/{package}/latest",
            timeout=TIMEOUT,
        )
        if full_resp.status_code == 200:
            full = full_resp.json()
            repo = full.get("repository", {})
            if isinstance(repo, dict):
                raw_url = repo.get("url", "")
            elif isinstance(repo, str):
                raw_url = repo
            else:
                raw_url = ""
            m = re.search(r"github\.com/([^/]+)/([^/.\s#]+)", raw_url)
            if m:
                repo_url = f"https://github.com/{m.group(1)}/{m.group(2)}"

        return latest, repo_url

    except Exception:
        return "unknown", ""


async def check_pypi(
    client: httpx.AsyncClient, package: str
) -> tuple[str, str]:
    """Return (latest_version, github_repo_url) for a PyPI package."""
    try:
        resp = await client.get(
            f"https://pypi.org/pypi/{package}/json",
            timeout=TIMEOUT,
        )
        if resp.status_code != 200:
            return "unknown", ""

        data = resp.json()
        info = data.get("info", {})
        latest = info.get("version", "unknown")

        # Find GitHub URL in project_urls
        repo_url = ""
        project_urls: dict[str, str] = info.get("project_urls") or {}
        for key in (
            "Source",
            "Repository",
            "Source Code",
            "GitHub",
            "Homepage",
            "Code",
        ):
            url = project_urls.get(key, "")
            if "github.com" in url:
                m = re.search(r"github\.com/([^/]+)/([^/.\s#]+)", url)
                if m:
                    repo_url = f"https://github.com/{m.group(1)}/{m.group(2)}"
                    break

        return latest, repo_url

    except Exception:
        return "unknown", ""


def is_outdated(current: str, latest: str) -> bool:
    """Compare two semver-ish version strings.

    Returns True when *latest* is strictly newer than *current*.
    """
    if current == "unknown" or latest == "unknown":
        return False
    try:
        cur_parts = [int(x) for x in re.findall(r"\d+", current)][:3]
        lat_parts = [int(x) for x in re.findall(r"\d+", latest)][:3]
        # pad to length 3
        while len(cur_parts) < 3:
            cur_parts.append(0)
        while len(lat_parts) < 3:
            lat_parts.append(0)
        return lat_parts > cur_parts
    except (ValueError, IndexError):
        return current != latest
