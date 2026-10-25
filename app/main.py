"""DepDrift — FastAPI entry point.

Scans GitHub repos for outdated dependencies, fetches changelogs
(via GitHub Releases or Browserbase headless cloud browser for dynamic web pages),
and uses Gemma 4 to classify each update by risk level.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from app.browserbase_client import fetch_web_changelog
from app.dep_parser import parse_package_json, parse_requirements_txt
from app.gemma_analyzer import analyze_changelog
from app.github_client import GitHubClient, parse_github_input
from app.models import DependencyResult, RepoResult, ScanProgress
from app.registry_client import check_npm, check_pypi, is_outdated

load_dotenv()
logger = logging.getLogger("depdrift")

# ── configuration ───────────────────────────────────────────────────

GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "")
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
GEMMA_MODEL = os.getenv("GEMMA_MODEL", "gemma-4-26b-a4b-it")
GEMMA_API_KEY = os.getenv("GEMMA_API_KEY", "")
BROWSERBASE_API_KEY = os.getenv("BROWSERBASE_API_KEY", "")
BROWSERBASE_PROJECT_ID = os.getenv("BROWSERBASE_PROJECT_ID", "")

MAX_DEPS_PER_REPO = 30  # cap to avoid API rate exhaustion
MAX_REPOS = 10

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

# ── shared HTTP client ──────────────────────────────────────────────

_http_client: httpx.AsyncClient | None = None


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None, None]:
    global _http_client  # noqa: PLW0603
    _http_client = httpx.AsyncClient(follow_redirects=True)
    yield
    await _http_client.aclose()


app = FastAPI(title="DepDrift", lifespan=lifespan)


# ── SSE helper ──────────────────────────────────────────────────────

def _sse(data: dict) -> str:
    """Format a dict as a Server-Sent Event."""
    return f"data: {json.dumps(data)}\n\n"


# ── single repo scan pipeline ───────────────────────────────────────

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
        "message": f"Checking dependency files in {owner}/{repo_name}…",
    })

    # Fetch dependency manifest files
    pkg_raw = await gh.fetch_file_raw(owner, repo_name, branch, "package.json")
    req_raw = await gh.fetch_file_raw(owner, repo_name, branch, "requirements.txt")

    parsed: list[tuple[str, str, str]] = []  # (name, version, ecosystem)

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
            "message": f"No dependency files found in {owner}/{repo_name}.",
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

    # Cap per repo to avoid rate exhaustion
    parsed = parsed[:MAX_DEPS_PER_REPO]
    total = len(parsed)

    yield _sse({
        "status": "scanning",
        "repo": repo_name,
        "message": f"Found {total} dependencies in {owner}/{repo_name}. Checking versions…",
    })

    results: list[DependencyResult] = []
    outdated_count = 0
    critical_count = 0

    for idx, (dep_name, current_ver, ecosystem) in enumerate(parsed, 1):
        yield _sse({
            "status": "checking",
            "repo": repo_name,
            "dep": dep_name,
            "progress": f"{idx}/{total}",
            "message": f"Checking {dep_name} ({ecosystem}) on registry…",
        })

        if ecosystem == "npm":
            latest_ver, gh_repo_url = await check_npm(http, dep_name)
        else:
            latest_ver, gh_repo_url = await check_pypi(http, dep_name)

        outdated = is_outdated(current_ver, latest_ver)

        if not outdated:
            results.append(DependencyResult(
                name=dep_name,
                ecosystem=ecosystem,
                current_version=current_ver,
                latest_version=latest_ver,
                is_outdated=False,
                risk="CURRENT",
                summary="Up to date.",
                action="No action needed.",
                changelog_url=gh_repo_url + "/releases" if gh_repo_url else "",
                github_repo_url=gh_repo_url,
                browserbase_session=None,
                changelog_source="registry",
            ))
            continue

        outdated_count += 1

        # Fetch changelog for outdated dependencies
        yield _sse({
            "status": "analyzing",
            "repo": repo_name,
            "dep": dep_name,
            "progress": f"{idx}/{total}",
            "message": f"Analyzing changelog for {dep_name} with Gemma…",
        })

        changelog = ""
        source = "github_releases"
        bb_session = None

        if gh_repo_url:
            changelog = await gh.get_changelog_text(gh_repo_url)

        # If changelog is missing from GitHub releases or empty,
        # use Browserbase cloud browser to render dynamic package page/docs and extract notes
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
                "message": f"Extracting dynamic changelog via Browserbase cloud browser for {dep_name}…",
            })
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

        if analysis["risk"] == "CRITICAL":
            critical_count += 1

        results.append(DependencyResult(
            name=dep_name,
            ecosystem=ecosystem,
            current_version=current_ver,
            latest_version=latest_ver,
            is_outdated=True,
            risk=analysis["risk"],
            summary=analysis["summary"],
            action=analysis["action"],
            changelog_url=gh_repo_url + "/releases" if gh_repo_url else "",
            github_repo_url=gh_repo_url,
            browserbase_session=bb_session,
            changelog_source=source,
        ))

    repo_result = RepoResult(
        repo_name=f"{owner}/{repo_name}",
        repo_url=f"https://github.com/{owner}/{repo_name}",
        default_branch=branch,
        dependencies=results,
        total=total,
        outdated=outdated_count,
        critical=critical_count,
    )

    yield _sse({
        "status": "repo_done",
        "repo": repo_name,
        "message": f"Done: {total} deps, {outdated_count} outdated, {critical_count} critical.",
        "result": repo_result.model_dump(),
    })


# ── API routes ──────────────────────────────────────────────────────

@app.get("/api/scan")
async def scan(input: str = Query(..., description="GitHub username, owner/repo, or full URL")):
    """Stream scan results as Server-Sent Events."""
    assert _http_client is not None
    gh = GitHubClient(_http_client, GITHUB_TOKEN)

    try:
        owner, repo = parse_github_input(input)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    async def event_stream() -> AsyncGenerator[str, None]:
        start = time.monotonic()
        all_results: list[dict] = []

        if repo:
            # single repo scan
            info = await gh.get_repo(owner, repo)
            if not info:
                yield _sse({"status": "error", "message": f"Repo {owner}/{repo} not found."})
                return
            branch = info.get("default_branch", "main")
            async for event in _scan_single_repo(gh, _http_client, owner, repo, branch):
                yield event
                data = json.loads(event.split("data: ", 1)[1].split("\n")[0])
                if data.get("status") == "repo_done" and data.get("result"):
                    all_results.append(data["result"])
        else:
            # multi-repo scan
            yield _sse({"status": "scanning", "message": f"Discovering repos for {owner}…"})
            repos = await gh.list_repos(owner, limit=MAX_REPOS)
            if not repos:
                yield _sse({"status": "error", "message": f"No public repos found for {owner}."})
                return

            yield _sse({"status": "scanning", "message": f"Found {len(repos)} repos. Starting scan…"})

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

        # Count browserbase extractions
        total_bb = sum(
            1 for r in all_results for d in r.get("dependencies", []) if d.get("changelog_source") == "browserbase"
        )

        time_saved = total_outdated * 2

        yield _sse({
            "status": "complete",
            "message": f"Scan finished in {elapsed}s.",
            "results": all_results,
            "stats": {
                "total_deps": total_deps,
                "outdated": total_outdated,
                "critical": total_critical,
                "browserbase_extractions": total_bb,
                "time_saved_minutes": time_saved,
                "scan_seconds": elapsed,
                "repos_scanned": len(all_results),
            },
        })

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/health")
async def health():
    """Health check endpoint."""
    return {
        "status": "ok",
        "model": GEMMA_MODEL,
        "browserbase_configured": bool(os.getenv("BROWSERBASE_API_KEY")),
        "gemma_configured": bool(os.getenv("GEMMA_API_KEY")),
    }


# ── static file serving ────────────────────────────────────────────

@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
