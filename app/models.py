"""Pydantic models for DepDrift API."""

from __future__ import annotations

from typing import Optional
from pydantic import BaseModel


class ScanRequest(BaseModel):
    """Incoming scan request body."""
    input: str  # GitHub username, owner/repo, or full URL


class DependencyResult(BaseModel):
    """Single dependency analysis result."""
    name: str
    ecosystem: str  # "npm" | "pypi"
    current_version: str
    latest_version: str
    is_outdated: bool
    risk: str  # CRITICAL | BREAKING | SAFE | SKIP | CURRENT
    summary: str
    action: str
    changelog_url: str
    github_repo_url: str
    browserbase_session: Optional[str] = None
    changelog_source: Optional[str] = None  # "github_releases" | "browserbase" | "registry"


class RepoResult(BaseModel):
    """Scan result for one repository."""
    repo_name: str
    repo_url: str
    default_branch: str
    dependencies: list[DependencyResult]
    total: int
    outdated: int
    critical: int


class ScanProgress(BaseModel):
    """SSE progress event payload."""
    status: str  # scanning | checking | analyzing | repo_done | complete | error
    message: str
    repo: str | None = None
    dep: str | None = None
    progress: str | None = None  # "3/47"
    result: RepoResult | None = None
    results: list[RepoResult] | None = None
    stats: dict | None = None
