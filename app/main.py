"""DepDrift — FastAPI entry point.

Scans GitHub repos for outdated dependencies, fetches changelogs,
and uses Gemma (via Ollama on a DigitalOcean GPU Droplet) to classify
each update by risk level.
"""

from __future__ import annotations

import asyncio
import json
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

from app.dep_parser import parse_package_json, parse_requirements_txt
from app.gemma_analyzer import analyze_changelog
from app.github_client import GitHubClient, parse_github_input
from app.models import DependencyResult, RepoResult, ScanProgress
from app.registry_client import check_npm, check_pypi, is_outdated

load_dotenv()

# ── configuration ───────────────────────────────────────────────────

GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "")
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
GEMMA_MODEL = os.getenv("GEMMA_MODEL", "gemma2:2b")
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
    return f"data: {json.dumps(data, default=str)}\n\n"


# ── core scan logic ────────────────────────────────────────────────

async def _scan_single_repo(
    gh: GitHubClient,
    http: httpx.AsyncClient,
    owner: str,
    repo_name: str,
    branch: str,
) -> AsyncGenerator[str, None]:
    """Scan one repo and yield SSE events for each dependency."""

    yield _sse({"status": "scanning", "repo": repo_name, "message": f"Fetching dependency files from {owner}/{repo_name}…"})

    dep_files = await gh.fetch_dep_files(owner, repo_name, branch)
    if not dep_files:
        yield _sse({"status": "repo_done", "repo": repo_name, "message": "No dependency files found."})
        return

    # parse all deps
    all_deps: list[tuple[str, str, str]] = []  # (name, version, ecosystem)
    if "npm" in dep_files:
        for name, ver in parse_package_json(dep_files["npm"]):
            all_deps.append((name, ver, "npm"))
    if "pypi" in dep_files:
        for name, ver in parse_requirements_txt(dep_files["pypi"]):
            all_deps.append((name, ver, "pypi"))

    # cap
    all_deps = all_deps[:MAX_DEPS_PER_REPO]
    total = len(all_deps)

    if total == 0:
        yield _sse({"status": "repo_done", "repo": repo_name, "message": "No parseable dependencies."})
        return

    yield _sse({
        "status": "checking",
        "repo": repo_name,
        "message": f"Found {total} dependencies. Checking versions…",
    })

    results: list[DependencyResult] = []
    outdated_count = 0
    critical_count = 0

    for idx, (dep_name, current_ver, ecosystem) in enumerate(all_deps, 1):
        yield _sse({
            "status": "checking",
            "repo": repo_name,
            "dep": dep_name,
            "progress": f"{idx}/{total}",
            "message": f"Checking {dep_name} ({idx}/{total})…",
        })

        # look up latest version + source repo
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
            ))
            continue

        outdated_count += 1

        # fetch changelog for outdated deps
        yield _sse({
            "status": "analyzing",
            "repo": repo_name,
            "dep": dep_name,
            "progress": f"{idx}/{total}",
            "message": f"Analyzing changelog for {dep_name} with Gemma…",
        })

        changelog = ""
        if gh_repo_url:
            changelog = await gh.get_changelog_text(gh_repo_url)

        analysis = await analyze_changelog(
            http, OLLAMA_URL, GEMMA_MODEL,
            dep_name, current_ver, latest_ver, changelog,
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
                # capture repo_done result
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

        # estimate: 2 minutes per manual changelog read × outdated deps
        time_saved = total_outdated * 2

        yield _sse({
            "status": "complete",
            "message": f"Scan finished in {elapsed}s.",
            "results": all_results,
            "stats": {
                "total_deps": total_deps,
                "outdated": total_outdated,
                "critical": total_critical,
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
    return {"status": "ok", "model": GEMMA_MODEL, "ollama": OLLAMA_URL}


# ── static file serving ────────────────────────────────────────────

@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
