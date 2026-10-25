"""GitHub REST API v3 client for DepDrift."""

from __future__ import annotations

import re
from typing import Any

import httpx


class GitHubClient:
    """Thin async wrapper around the GitHub REST API."""

    BASE = "https://api.github.com"
    RAW_BASE = "https://raw.githubusercontent.com"
    TIMEOUT = 15

    def __init__(self, client: httpx.AsyncClient, token: str = "") -> None:
        self._http = client
        self._headers: dict[str, str] = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        if token:
            self._headers["Authorization"] = f"Bearer {token}"

    # ── repo discovery ──────────────────────────────────────────────

    async def list_repos(self, owner: str, limit: int = 30) -> list[dict[str, Any]]:
        """List public repos for a user/org, sorted by most recently pushed."""
        resp = await self._http.get(
            f"{self.BASE}/users/{owner}/repos",
            headers=self._headers,
            params={"per_page": limit, "sort": "pushed", "direction": "desc", "type": "owner"},
            timeout=self.TIMEOUT,
        )
        if resp.status_code != 200:
            return []
        return resp.json()  # type: ignore[no-any-return]

    async def get_repo(self, owner: str, repo: str) -> dict[str, Any] | None:
        """Fetch a single repo's metadata."""
        resp = await self._http.get(
            f"{self.BASE}/repos/{owner}/{repo}",
            headers=self._headers,
            timeout=self.TIMEOUT,
        )
        if resp.status_code != 200:
            return None
        return resp.json()  # type: ignore[no-any-return]

    # ── dependency file fetching ────────────────────────────────────

    async def fetch_file_raw(
        self, owner: str, repo: str, branch: str, path: str
    ) -> str | None:
        """Fetch a file's raw content from a repo."""
        url = f"{self.RAW_BASE}/{owner}/{repo}/{branch}/{path}"
        resp = await self._http.get(url, timeout=self.TIMEOUT, follow_redirects=True)
        if resp.status_code == 200:
            return resp.text
        return None

    get_file = fetch_file_raw

    async def fetch_dep_files(
        self, owner: str, repo: str, branch: str
    ) -> dict[str, str]:
        """Try to fetch known dependency files. Returns {ecosystem: content}."""
        targets = [
            ("package.json", "npm"),
            ("requirements.txt", "pypi"),
        ]
        found: dict[str, str] = {}
        for filename, ecosystem in targets:
            content = await self.fetch_file_raw(owner, repo, branch, filename)
            if content is not None:
                found[ecosystem] = content
        return found

    # ── release notes ───────────────────────────────────────────────

    async def fetch_releases(
        self, owner: str, repo: str, limit: int = 3
    ) -> list[dict[str, Any]]:
        """Fetch recent releases for a repo."""
        resp = await self._http.get(
            f"{self.BASE}/repos/{owner}/{repo}/releases",
            headers=self._headers,
            params={"per_page": limit},
            timeout=self.TIMEOUT,
        )
        if resp.status_code != 200:
            return []
        return resp.json()  # type: ignore[no-any-return]

    async def get_changelog_text(self, github_repo_url: str) -> str:
        """Fetch combined release notes from a GitHub repo URL.

        Returns up to 3 recent releases concatenated, capped at 3 000 chars.
        """
        match = re.search(r"github\.com/([^/]+)/([^/.\s]+)", github_repo_url)
        if not match:
            return ""

        owner, repo = match.group(1), match.group(2)
        releases = await self.fetch_releases(owner, repo, limit=3)
        if not releases:
            return ""

        parts: list[str] = []
        for rel in releases:
            tag = rel.get("tag_name", "")
            body = (rel.get("body") or "")[:1200]
            if body:
                parts.append(f"## {tag}\n{body}")

        return "\n\n".join(parts)[:3000]


# ── URL parsing helpers ─────────────────────────────────────────────

def parse_github_input(raw: str) -> tuple[str, str | None]:
    """Parse user input into (owner, repo_or_None).

    Accepts:
      - https://github.com/owner/repo
      - owner/repo
      - owner            → returns (owner, None)
    """
    raw = raw.strip().rstrip("/")

    # full URL
    m = re.match(r"https?://github\.com/([^/]+)/([^/]+?)(?:\.git)?$", raw)
    if m:
        return m.group(1), m.group(2)

    # shorthand owner/repo
    m = re.match(r"^([A-Za-z0-9_-]+)/([A-Za-z0-9._-]+)$", raw)
    if m:
        return m.group(1), m.group(2)

    # username only
    m = re.match(r"^[A-Za-z0-9_-]+$", raw)
    if m:
        return raw, None

    raise ValueError(f"Cannot parse GitHub input: {raw!r}")
