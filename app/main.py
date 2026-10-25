"""DepDrift — Production FastAPI Engine.

Authoritative dependency drift detector and changelog analyzer.
Combines:
- GitHub API (5,000 req/hr authenticated via PAT)
- npm & PyPI Registry APIs with semver resolution
- GitHub Advisory Database for CVEs & GHSA security advisories
- Browserbase headless cloud browser for client-rendered SPA changelogs
- Gemma 4 open-weights model for deterministic breaking change analysis
- SQLite persistence for historical audit tracking
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncGenerator

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from app.browserbase_client import fetch_web_changelog
from app.db import delete_audit, get_audit, init_db, list_audits, save_audit
from app.dep_parser import parse_package_json, parse_requirements_txt
from app.gemma_analyzer import analyze_changelog
from app.github_client import GitHubClient, parse_github_input
from app.models import (
    DependencyResult,
    InspectPackageRequest,
    ManifestScanRequest,
    RepoResult,
    ScanProgress,
)
from app.registry_client import check_npm, check_pypi, is_outdated
from app.security_advisories import fetch_security_advisories

load_dotenv()
logger = logging.getLogger("depdrift")

# ── configuration ───────────────────────────────────────────────────

GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "")
GEMMA_MODEL = os.getenv("GEMMA_MODEL", "gemma-4-26b-a4b-it")
GEMMA_API_KEY = os.getenv("GEMMA_API_KEY", "")
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
BROWSERBASE_API_KEY = os.getenv("BROWSERBASE_API_KEY", "")
BROWSERBASE_PROJECT_ID = os.getenv("BROWSERBASE_PROJECT_ID", "")

MAX_DEPS_PER_REPO = 50
MAX_REPOS = 10

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

_http_client: httpx.AsyncClient | None = None


def get_http_client() -> httpx.AsyncClient:
    """Return an initialized HTTP client, creating one on demand if needed."""
    global _http_client  # noqa: PLW0603
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(
            follow_redirects=True,
            timeout=httpx.Timeout(30.0, connect=10.0),
        )
    return _http_client


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None, None]:
    init_db()
    get_http_client()
    yield
    if _http_client and not _http_client.is_closed:
        await _http_client.aclose()


app = FastAPI(
    title="DepDrift API",
    description="Production dependency changelog analyzer & security audit engine",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _sse(data: dict[str, Any]) -> str:
    """Format a dict as a Server-Sent Event."""
    return f"data: {json.dumps(data)}\n\n"


def _build_update_command(name: str, version: str, ecosystem: str) -> str:
    """Generate exact copy-paste update command."""
    if ecosystem == "npm":
        return f"npm install {name}@^{version}"
    return f"pip install {name}=={version}"


# ── single repo scan pipeline ───────────────────────────────────────

async def _process_dependency_list(
    http: httpx.AsyncClient,
    gh: GitHubClient,
    repo_name: str,
    parsed: list[tuple[str, str, str]],  # (name, version, ecosystem)
) -> tuple[list[DependencyResult], int, int, int, int]:
    """Inspect each dependency, fetch changelog, run security checks and Gemma analysis."""
    total = len(parsed)
    results: list[DependencyResult] = []
    outdated_count = 0
    critical_count = 0
    breaking_count = 0
    safe_count = 0

    for dep_name, current_ver, ecosystem in parsed:
        if ecosystem == "npm":
            latest_ver, gh_repo_url = await check_npm(http, dep_name)
        else:
            latest_ver, gh_repo_url = await check_pypi(http, dep_name)

        outdated = is_outdated(current_ver, latest_ver)
        update_cmd = _build_update_command(dep_name, latest_ver, ecosystem)

        if not outdated:
            results.append(DependencyResult(
                name=dep_name,
                ecosystem=ecosystem,
                current_version=current_ver,
                latest_version=latest_ver,
                is_outdated=False,
                risk="CURRENT",
                summary="Package is pinned to or matching latest upstream release.",
                action="No action needed.",
                changelog_url=gh_repo_url + "/releases" if gh_repo_url else "",
                github_repo_url=gh_repo_url,
                browserbase_session=None,
                changelog_source="registry",
                update_command=update_cmd,
                advisories=[],
            ))
            continue

        outdated_count += 1

        # Check for security advisories / CVEs
        advisories = await fetch_security_advisories(
            http, dep_name, ecosystem, current_ver, GITHUB_TOKEN
        )

        changelog = ""
        source = "github_releases"
        bb_session = None

        if gh_repo_url:
            changelog = await gh.get_changelog_text(gh_repo_url)

        # If changelog is missing from GitHub releases, use Browserbase
        if not changelog or len(changelog) < 60:
            target_url = (
                f"https://www.npmjs.com/package/{dep_name}"
                if ecosystem == "npm"
                else f"https://pypi.org/project/{dep_name}/"
            )
            bb_res = await fetch_web_changelog(target_url)
            if bb_res.get("content"):
                changelog = bb_res["content"]
                source = "browserbase"
                bb_session = bb_res.get("session_id")

        analysis = await analyze_changelog(
            http, OLLAMA_URL, GEMMA_MODEL,
            dep_name, current_ver, latest_ver, changelog,
            api_key=GEMMA_API_KEY,
        )

        risk = analysis["risk"]
        # If security advisories with HIGH or CRITICAL exist, elevate risk
        if advisories and any(a.get("severity") in ("CRITICAL", "HIGH") for a in advisories):
            risk = "CRITICAL"

        if risk == "CRITICAL":
            critical_count += 1
        elif risk == "BREAKING":
            breaking_count += 1
        elif risk == "SAFE":
            safe_count += 1

        results.append(DependencyResult(
            name=dep_name,
            ecosystem=ecosystem,
            current_version=current_ver,
            latest_version=latest_ver,
            is_outdated=True,
            risk=risk,
            summary=analysis["summary"],
            action=analysis["action"],
            changelog_url=gh_repo_url + "/releases" if gh_repo_url else "",
            github_repo_url=gh_repo_url,
            browserbase_session=bb_session,
            changelog_source=source,
            update_command=update_cmd,
            advisories=advisories,
        ))

    return results, outdated_count, critical_count, breaking_count, safe_count


async def _scan_single_repo(
    gh: GitHubClient,
    http: httpx.AsyncClient,
    owner: str,
    repo_name: str,
    branch: str = "main",
) -> AsyncGenerator[str, None]:
    """Scan one repository, yielding SSE events for each stage."""
    yield _sse({
        "status": "scanning",
        "repo": repo_name,
        "message": f"Locating dependency manifests in {owner}/{repo_name}…",
    })

    pkg_raw = await gh.fetch_file_raw(owner, repo_name, branch, "package.json")
    req_raw = await gh.fetch_file_raw(owner, repo_name, branch, "requirements.txt")

    parsed: list[tuple[str, str, str]] = []

    if pkg_raw:
        for name, ver in parse_package_json(pkg_raw):
            parsed.append((name, ver, "npm"))

    if req_raw:
        for name, ver in parse_requirements_txt(req_raw):
            parsed.append((name, ver, "pypi"))

    if not parsed:
        yield _sse({
            "status": "repo_done",
            "repo": repo_name,
            "message": f"No supported dependency manifests found in {owner}/{repo_name}.",
            "result": RepoResult(
                repo_name=f"{owner}/{repo_name}",
                repo_url=f"https://github.com/{owner}/{repo_name}",
                default_branch=branch,
                dependencies=[],
                total=0,
                outdated=0,
                critical=0,
            ).model_dump(),
        })
        return

    parsed = parsed[:MAX_DEPS_PER_REPO]
    total = len(parsed)

    yield _sse({
        "status": "scanning",
        "repo": repo_name,
        "message": f"Found {total} dependencies. Querying registries and changelogs…",
    })

    results: list[DependencyResult] = []
    outdated_count = 0
    critical_count = 0
    breaking_count = 0
    safe_count = 0

    for idx, (dep_name, current_ver, ecosystem) in enumerate(parsed, 1):
        yield _sse({
            "status": "checking",
            "repo": repo_name,
            "dep": dep_name,
            "progress": f"{idx}/{total}",
            "message": f"Checking {dep_name} ({ecosystem}) on upstream registry…",
        })

        if ecosystem == "npm":
            latest_ver, gh_repo_url = await check_npm(http, dep_name)
        else:
            latest_ver, gh_repo_url = await check_pypi(http, dep_name)

        outdated = is_outdated(current_ver, latest_ver)
        update_cmd = _build_update_command(dep_name, latest_ver, ecosystem)

        if not outdated:
            results.append(DependencyResult(
                name=dep_name,
                ecosystem=ecosystem,
                current_version=current_ver,
                latest_version=latest_ver,
                is_outdated=False,
                risk="CURRENT",
                summary="Package is up to date.",
                action="No action needed.",
                changelog_url=gh_repo_url + "/releases" if gh_repo_url else "",
                github_repo_url=gh_repo_url,
                browserbase_session=None,
                changelog_source="registry",
                update_command=update_cmd,
                advisories=[],
            ))
            continue

        outdated_count += 1

        advisories = await fetch_security_advisories(
            http, dep_name, ecosystem, current_ver, GITHUB_TOKEN
        )

        changelog = ""
        source = "github_releases"
        bb_session = None

        if gh_repo_url:
            changelog = await gh.get_changelog_text(gh_repo_url)

        if not changelog or len(changelog) < 60:
            target_url = (
                f"https://www.npmjs.com/package/{dep_name}"
                if ecosystem == "npm"
                else f"https://pypi.org/project/{dep_name}/"
            )
            yield _sse({
                "status": "analyzing",
                "repo": repo_name,
                "dep": dep_name,
                "progress": f"{idx}/{total}",
                "message": f"Rendering dynamic changelog via Browserbase cloud browser for {dep_name}…",
            })
            bb_res = await fetch_web_changelog(target_url)
            if bb_res.get("content"):
                changelog = bb_res["content"]
                source = "browserbase"
                bb_session = bb_res.get("session_id")

        yield _sse({
            "status": "analyzing",
            "repo": repo_name,
            "dep": dep_name,
            "progress": f"{idx}/{total}",
            "message": f"Evaluating {dep_name} changelog with Gemma 4…",
        })

        analysis = await analyze_changelog(
            http, OLLAMA_URL, GEMMA_MODEL,
            dep_name, current_ver, latest_ver, changelog,
            api_key=GEMMA_API_KEY,
        )

        risk = analysis["risk"]
        if advisories and any(a.get("severity") in ("CRITICAL", "HIGH") for a in advisories):
            risk = "CRITICAL"

        if risk == "CRITICAL":
            critical_count += 1
        elif risk == "BREAKING":
            breaking_count += 1
        elif risk == "SAFE":
            safe_count += 1

        results.append(DependencyResult(
            name=dep_name,
            ecosystem=ecosystem,
            current_version=current_ver,
            latest_version=latest_ver,
            is_outdated=True,
            risk=risk,
            summary=analysis["summary"],
            action=analysis["action"],
            changelog_url=gh_repo_url + "/releases" if gh_repo_url else "",
            github_repo_url=gh_repo_url,
            browserbase_session=bb_session,
            changelog_source=source,
            update_command=update_cmd,
            advisories=advisories,
        ))

    repo_result = RepoResult(
        repo_name=f"{owner}/{repo_name}",
        repo_url=f"https://github.com/{owner}/{repo_name}",
        default_branch=branch,
        dependencies=results,
        total=total,
        outdated=outdated_count,
        critical=critical_count,
        breaking=breaking_count,
        safe=safe_count,
    )

    yield _sse({
        "status": "repo_done",
        "repo": repo_name,
        "message": f"Finished {owner}/{repo_name}: {total} deps, {outdated_count} outdated, {critical_count} critical.",
        "result": repo_result.model_dump(),
    })


# ── API routes ──────────────────────────────────────────────────────

@app.get("/api/scan")
async def scan(input: str = Query(..., description="GitHub username, owner/repo, or full URL")):
    """Stream GitHub scan results as Server-Sent Events."""
    http = get_http_client()
    gh = GitHubClient(http, GITHUB_TOKEN)

    try:
        owner, repo = parse_github_input(input)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    async def event_stream() -> AsyncGenerator[str, None]:
        start = time.monotonic()
        all_results: list[dict[str, Any]] = []

        if repo:
            info = await gh.get_repo(owner, repo)
            if not info:
                yield _sse({"status": "error", "message": f"Repository {owner}/{repo} not found on GitHub."})
                return
            branch = info.get("default_branch", "main")
            async for event in _scan_single_repo(gh, _http_client, owner, repo, branch):
                yield event
                data = json.loads(event.split("data: ", 1)[1].split("\n")[0])
                if data.get("status") == "repo_done" and data.get("result"):
                    all_results.append(data["result"])
        else:
            yield _sse({"status": "scanning", "message": f"Discovering repositories for GitHub user @{owner}…"})
            repos = await gh.list_repos(owner, limit=MAX_REPOS)
            if not repos:
                yield _sse({"status": "error", "message": f"No public repositories found for user @{owner}."})
                return

            yield _sse({"status": "scanning", "message": f"Found {len(repos)} repositories. Beginning audit…"})

            for r in repos:
                rname = r["name"]
                branch = r.get("default_branch", "main")
                async for event in _scan_single_repo(gh, _http_client, owner, rname, branch):
                    yield event
                    data = json.loads(event.split("data: ", 1)[1].split("\n")[0])
                    if data.get("status") == "repo_done" and data.get("result"):
                        all_results.append(data["result"])

        elapsed = round(time.monotonic() - start, 1)
        total_deps = sum(r.get("total", 0) for r in all_results)
        total_outdated = sum(r.get("outdated", 0) for r in all_results)
        total_critical = sum(r.get("critical", 0) for r in all_results)
        total_breaking = sum(r.get("breaking", 0) for r in all_results)
        total_safe = sum(r.get("safe", 0) for r in all_results)

        total_bb = sum(
            1 for r in all_results for d in r.get("dependencies", []) if d.get("changelog_source") == "browserbase"
        )

        stats = {
            "total_deps": total_deps,
            "outdated": total_outdated,
            "critical": total_critical,
            "breaking": total_breaking,
            "safe": total_safe,
            "browserbase_extractions": total_bb,
            "time_saved_minutes": total_outdated * 2,
            "scan_seconds": elapsed,
            "repos_scanned": len(all_results),
        }

        # Persist audit to SQLite
        audit_id = save_audit(input, "github", all_results, stats)
        stats["audit_id"] = audit_id

        yield _sse({
            "status": "complete",
            "message": f"Scan completed in {elapsed}s.",
            "results": all_results,
            "stats": stats,
        })

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/scan/manifest")
async def scan_manifest(req: ManifestScanRequest):
    """Scan an uploaded or pasted package.json / requirements.txt."""
    http = get_http_client()
    gh = GitHubClient(http, GITHUB_TOKEN)

    parsed: list[tuple[str, str, str]] = []
    content = req.content.strip()

    if req.filename.endswith(".json") or content.startswith("{"):
        for name, ver in parse_package_json(content):
            parsed.append((name, ver, "npm"))
    else:
        for name, ver in parse_requirements_txt(content):
            parsed.append((name, ver, "pypi"))

    if not parsed:
        raise HTTPException(
            status_code=400,
            detail="Could not parse any dependencies from the provided manifest. Ensure it is valid JSON or requirements syntax.",
        )

    parsed = parsed[:MAX_DEPS_PER_REPO]
    start = time.monotonic()

    results, outdated, critical, breaking, safe = await _process_dependency_list(
        _http_client, gh, req.filename, parsed
    )

    elapsed = round(time.monotonic() - start, 1)
    total_bb = sum(1 for d in results if d.changelog_source == "browserbase")

    repo_result = RepoResult(
        repo_name=req.filename,
        repo_url="#",
        default_branch="local",
        dependencies=results,
        total=len(parsed),
        outdated=outdated,
        critical=critical,
        breaking=breaking,
        safe=safe,
    )

    stats = {
        "total_deps": len(parsed),
        "outdated": outdated,
        "critical": critical,
        "breaking": breaking,
        "safe": safe,
        "browserbase_extractions": total_bb,
        "time_saved_minutes": outdated * 2,
        "scan_seconds": elapsed,
        "repos_scanned": 1,
    }

    audit_id = save_audit(req.filename, "manifest", [repo_result.model_dump()], stats)
    stats["audit_id"] = audit_id

    return {
        "status": "complete",
        "results": [repo_result.model_dump()],
        "stats": stats,
    }


@app.post("/api/inspect")
async def inspect_package(req: InspectPackageRequest):
    """Deep-inspect a single package on-demand."""
    http = get_http_client()
    gh = GitHubClient(http, GITHUB_TOKEN)

    if req.ecosystem == "npm":
        latest_ver, gh_repo_url = await check_npm(http, req.name)
    else:
        latest_ver, gh_repo_url = await check_pypi(http, req.name)

    outdated = is_outdated(req.current_version, latest_ver)
    advisories = await fetch_security_advisories(
        _http_client, req.name, req.ecosystem, req.current_version, GITHUB_TOKEN
    )

    changelog = ""
    source = "github_releases"
    bb_session = None

    if gh_repo_url:
        changelog = await gh.get_changelog_text(gh_repo_url)

    if not changelog or len(changelog) < 60:
        target_url = (
            f"https://www.npmjs.com/package/{req.name}"
            if req.ecosystem == "npm"
            else f"https://pypi.org/project/{req.name}/"
        )
        bb_res = await fetch_web_changelog(target_url)
        if bb_res.get("content"):
            changelog = bb_res["content"]
            source = "browserbase"
            bb_session = bb_res.get("session_id")

    analysis = await analyze_changelog(
        http, OLLAMA_URL, GEMMA_MODEL,
        req.name, req.current_version, latest_ver, changelog,
        api_key=GEMMA_API_KEY,
    )

    risk = analysis["risk"]
    if advisories and any(a.get("severity") in ("CRITICAL", "HIGH") for a in advisories):
        risk = "CRITICAL"

    return DependencyResult(
        name=req.name,
        ecosystem=req.ecosystem,
        current_version=req.current_version,
        latest_version=latest_ver,
        is_outdated=outdated,
        risk=risk,
        summary=analysis["summary"],
        action=analysis["action"],
        changelog_url=gh_repo_url + "/releases" if gh_repo_url else "",
        github_repo_url=gh_repo_url,
        browserbase_session=bb_session,
        changelog_source=source,
        update_command=_build_update_command(req.name, latest_ver, req.ecosystem),
        advisories=advisories,
    )


@app.get("/api/history")
async def get_history(limit: int = 50):
    """Retrieve recent scan audit history from SQLite."""
    return list_audits(limit=limit)


@app.get("/api/history/{audit_id}")
async def get_history_item(audit_id: int):
    """Retrieve full audit details by ID."""
    item = get_audit(audit_id)
    if not item:
        raise HTTPException(status_code=404, detail="Audit not found")
    return item


@app.delete("/api/history/{audit_id}")
async def delete_history_item(audit_id: int):
    """Delete an audit from history."""
    success = delete_audit(audit_id)
    if not success:
        raise HTTPException(status_code=404, detail="Audit not found")
    return {"deleted": True, "id": audit_id}


@app.get("/api/diagnostics")
async def run_diagnostics():
    """Live diagnostic check for GitHub API limits, Browserbase, and Gemma 4."""
    http = get_http_client()

    diag: dict[str, Any] = {
        "timestamp": time.time(),
        "github": {"status": "unknown", "rate_limit_remaining": None, "rate_limit_limit": None},
        "browserbase": {"status": "unknown", "configured": bool(BROWSERBASE_API_KEY)},
        "gemma": {"status": "unknown", "model": GEMMA_MODEL, "configured": bool(GEMMA_API_KEY)},
        "registries": {"npm": "unknown", "pypi": "unknown"},
    }

    # Check GitHub rate limits
    try:
        gh_headers = {"User-Agent": "DepDrift-Diagnostics"}
        if GITHUB_TOKEN:
            gh_headers["Authorization"] = f"Bearer {GITHUB_TOKEN}"
        r = await http.get("https://api.github.com/rate_limit", headers=gh_headers, timeout=5.0)
        if r.status_code == 200:
            core = r.json().get("resources", {}).get("core", {})
            diag["github"] = {
                "status": "connected",
                "authenticated": bool(GITHUB_TOKEN),
                "rate_limit_remaining": core.get("remaining"),
                "rate_limit_limit": core.get("limit"),
            }
        else:
            diag["github"] = {"status": "error", "code": r.status_code}
    except Exception as e:
        diag["github"] = {"status": "failed", "error": str(e)}

    # Check Browserbase
    if BROWSERBASE_API_KEY:
        try:
            r = await http.get(
                "https://api.browserbase.com/v1/sessions?limit=1",
                headers={"X-BB-API-Key": BROWSERBASE_API_KEY},
                timeout=6.0,
            )
            if r.status_code in (200, 201):
                diag["browserbase"] = {
                    "status": "ready",
                    "configured": True,
                    "project_id": BROWSERBASE_PROJECT_ID[:8] + "…" if BROWSERBASE_PROJECT_ID else "default",
                }
            else:
                diag["browserbase"] = {"status": "error", "code": r.status_code}
        except Exception as e:
            diag["browserbase"] = {"status": "failed", "error": str(e)}
    else:
        diag["browserbase"] = {"status": "unconfigured"}

    # Check Gemma
    if GEMMA_API_KEY:
        diag["gemma"] = {
            "status": "ready",
            "model": GEMMA_MODEL,
            "provider": "Google AI Studio",
            "configured": True,
        }
    else:
        diag["gemma"] = {"status": "unconfigured"}

    # Check Registries
    try:
        nr = await http.get("https://registry.npmjs.org/express", timeout=4.0)
        diag["registries"]["npm"] = "operational" if nr.status_code == 200 else "degraded"
    except Exception:
        diag["registries"]["npm"] = "down"

    try:
        pr = await http.get("https://pypi.org/pypi/requests/json", timeout=4.0)
        diag["registries"]["pypi"] = "operational" if pr.status_code == 200 else "degraded"
    except Exception:
        diag["registries"]["pypi"] = "down"

    return diag


@app.get("/api/health")
async def health():
    """Health check endpoint."""
    return {
        "status": "ok",
        "model": GEMMA_MODEL,
        "browserbase_configured": bool(BROWSERBASE_API_KEY),
        "gemma_configured": bool(GEMMA_API_KEY),
        "github_configured": bool(GITHUB_TOKEN),
    }


# ── static file serving ────────────────────────────────────────────

@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
