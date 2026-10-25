"""DepDrift — Security Advisory Checker.

Queries GitHub Advisory Database and checks vulnerable version ranges
against the user's current version using packaging.specifiers.
Only attaches advisories that genuinely affect the current installed version.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx
from packaging.specifiers import InvalidSpecifier, SpecifierSet
from packaging.version import InvalidVersion, parse as parse_version

logger = logging.getLogger("depdrift.security")


async def fetch_security_advisories(
    http: httpx.AsyncClient,
    package_name: str,
    ecosystem: str,
    current_version: str,
    github_token: str = "",
) -> list[dict[str, Any]]:
    """Check for security advisories actively affecting the specified package version.

    Only returns advisories where current_version falls within the vulnerable_version_range.
    """
    if not current_version or current_version in ("unknown", "*", "latest"):
        return []

    eco = "npm" if ecosystem == "npm" else "pip"
    headers = {
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "DepDrift-Security-Scanner",
    }
    if github_token:
        headers["Authorization"] = f"Bearer {github_token}"

    url = f"https://api.github.com/advisories?affects={package_name}&ecosystem={eco}&per_page=15"

    try:
        parsed_current = parse_version(current_version)
    except InvalidVersion:
        parsed_current = None

    active_advisories: list[dict[str, Any]] = []

    try:
        resp = await http.get(url, headers=headers, timeout=8.0)
        if resp.status_code == 200:
            data = resp.json()
            for item in data:
                # Check if any vulnerability block actively matches package and current version
                is_active = False
                matched_range = ""

                for v in item.get("vulnerabilities", []):
                    pkg_info = v.get("package", {})
                    if pkg_info.get("name", "").lower() != package_name.lower():
                        continue

                    range_str = v.get("vulnerable_version_range", "").strip()
                    if not range_str:
                        continue

                    matched_range = range_str

                    if parsed_current is not None:
                        try:
                            spec = SpecifierSet(range_str)
                            if parsed_current in spec:
                                is_active = True
                                break
                        except (InvalidSpecifier, Exception):
                            pass

                if is_active:
                    active_advisories.append({
                        "ghsa_id": item.get("ghsa_id"),
                        "cve_id": item.get("cve_id"),
                        "summary": item.get("summary"),
                        "severity": (item.get("severity") or "unknown").upper(),
                        "published_at": item.get("published_at"),
                        "vulnerable_version_range": matched_range,
                        "url": item.get("html_url"),
                    })

    except Exception as exc:
        logger.debug("Failed to fetch GitHub security advisories for %s: %s", package_name, exc)

    return active_advisories
