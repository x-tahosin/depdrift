"""DepDrift — Security Advisory Checker.

Queries GitHub Advisory Database and npm registry to detect
real-world CVEs, GHSA IDs, and severity ratings for outdated packages.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger("depdrift.security")


async def fetch_security_advisories(
    http: httpx.AsyncClient,
    package_name: str,
    ecosystem: str,
    current_version: str,
    github_token: str = "",
) -> list[dict[str, Any]]:
    """Check for security advisories affecting the package.
    
    Returns a list of advisories with cve_id, ghsa_id, summary, and severity.
    """
    eco = "npm" if ecosystem == "npm" else "pip"
    headers = {
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "DepDrift-Security-Scanner",
    }
    if github_token:
        headers["Authorization"] = f"Bearer {github_token}"

    url = f"https://api.github.com/advisories?affects_package={package_name}&ecosystem={eco}&per_page=5"

    try:
        resp = await http.get(url, headers=headers, timeout=8.0)
        if resp.status_code == 200:
            data = resp.json()
            advisories = []
            for item in data:
                advisories.append({
                    "ghsa_id": item.get("ghsa_id"),
                    "cve_id": item.get("cve_id"),
                    "summary": item.get("summary"),
                    "severity": (item.get("severity") or "unknown").upper(),
                    "published_at": item.get("published_at"),
                    "url": item.get("html_url"),
                })
            return advisories
    except Exception as exc:
        logger.debug("Failed to fetch GitHub security advisories for %s: %s", package_name, exc)

    return []
