"""Parse dependency files into (name, version) pairs."""

from __future__ import annotations

import json
import re


def parse_package_json(content: str) -> list[tuple[str, str]]:
    """Extract production dependencies from package.json.

    Returns list of (package_name, pinned_version) tuples.
    Strips semver range prefixes (^, ~, >=, etc.).
    """
    try:
        pkg = json.loads(content)
    except (json.JSONDecodeError, TypeError):
        return []

    deps: dict[str, str] = {}
    deps.update(pkg.get("dependencies", {}) or {})
    # intentionally skip devDependencies — focus on production deps

    result: list[tuple[str, str]] = []
    for name, version_spec in deps.items():
        # skip workspace/file/git references
        if any(version_spec.startswith(p) for p in ("file:", "link:", "git", "http", "/")):
            continue
        # strip range operators: ^4.18.2 → 4.18.2
        clean = re.sub(r"^[^0-9]*", "", version_spec)
        if clean and re.match(r"\d", clean):
            result.append((name, clean))

    return result


def parse_requirements_txt(content: str) -> list[tuple[str, str]]:
    """Extract packages from requirements.txt.

    Returns list of (package_name, pinned_version) tuples.
    """
    result: list[tuple[str, str]] = []
    for raw_line in content.splitlines():
        line = raw_line.strip()
        # skip blanks, comments, options, includes
        if not line or line.startswith("#") or line.startswith("-"):
            continue

        # handle extras: package[extra]==1.0
        # handle operators: ==, >=, ~=, <=, !=
        match = re.match(
            r"^([A-Za-z0-9_][A-Za-z0-9._-]*)"  # package name
            r"(?:\[.*?\])?"                       # optional extras
            r"\s*[=~><!=]+\s*"                    # operator
            r"([0-9][^\s,;#]*)",                  # version
            line,
        )
        if match:
            result.append((match.group(1).lower(), match.group(2)))
        elif re.match(r"^[A-Za-z0-9_][A-Za-z0-9._-]*$", line):
            # bare package name with no version pinned
            result.append((line.lower(), "unknown"))

    return result
