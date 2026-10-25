"""Pydantic models for DepDrift API."""

from __future__ import annotations

from typing import Any, Optional
from pydantic import BaseModel, Field


class ScanRequest(BaseModel):
    """Incoming scan request body."""
    input: str  # GitHub username, owner/repo, or full URL


class ManifestScanRequest(BaseModel):
    """Direct manifest upload or paste."""
    filename: str = Field(default="package.json", description="e.g. package.json or requirements.txt")
    content: str = Field(..., description="Raw text of the manifest file")
    ecosystem: str = Field(default="auto", description="auto, npm, or pypi")


class InspectPackageRequest(BaseModel):
    """Quick inspection of a single package."""
    name: str
    current_version: str
    ecosystem: str = "npm"  # "npm" or "pypi"


class AdvisoryInfo(BaseModel):
    """Security advisory information."""
    ghsa_id: Optional[str] = None
    cve_id: Optional[str] = None
    summary: Optional[str] = None
    severity: str = "UNKNOWN"
    published_at: Optional[str] = None
    url: Optional[str] = None


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
    changelog_url: str = ""
    github_repo_url: str = ""
    browserbase_session: Optional[str] = None
    changelog_source: Optional[str] = None  # "github_releases" | "browserbase" | "registry"
    update_command: str = ""
    advisories: list[dict[str, Any]] = Field(default_factory=list)


class RepoResult(BaseModel):
    """Scan result for one repository or manifest."""
    repo_name: str
    repo_url: str
    default_branch: str = "main"
    dependencies: list[DependencyResult]
    total: int
    outdated: int
    critical: int
    breaking: int = 0
    safe: int = 0


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
