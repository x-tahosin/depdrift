"""Gemma-powered changelog analysis using Google's open-weight Gemma models (Gemma 4 / Gemma 2) or local Ollama."""

from __future__ import annotations

import json
import logging
import os
import re

import httpx

logger = logging.getLogger(__name__)

VALID_RISKS = frozenset({"CRITICAL", "BREAKING", "SAFE", "SKIP"})

RISK_MAP = {
    "HIGH": "CRITICAL",
    "URGENT": "CRITICAL",
    "SEVERE": "CRITICAL",
    "MEDIUM": "BREAKING",
    "MODERATE": "BREAKING",
    "LOW": "SAFE",
    "INFO": "SKIP",
    "DOCS": "SKIP",
}


async def analyze_changelog(
    client: httpx.AsyncClient,
    ollama_url: str,
    model: str,
    dep_name: str,
    current: str,
    latest: str,
    changelog: str,
    api_key: str | None = None,
) -> dict[str, str]:
    """Send a dependency changelog to Gemma and get a structured analysis.

    Returns {"summary": ..., "risk": ..., "action": ...}.
    """
    if not changelog.strip():
        return {
            "summary": f"Update available: {current} → {latest}. No release notes available.",
            "risk": "SAFE",
            "action": "No breaking changes documented. Safe to update with tests.",
        }

    prompt = (
        "You are an expert software dependency analyst. "
        "Analyze this package update changelog and provide a concise risk assessment. "
        "Output ONLY a single valid JSON object — no explanations, no markdown fences.\n\n"
        f"Package: {dep_name}\n"
        f"Current version: {current}\n"
        f"Latest version: {latest}\n\n"
        f"Changelog / Release Notes:\n{changelog[:3000]}\n\n"
        "Required JSON format:\n"
        "{\n"
        '  "summary": "one clear sentence explaining what changed",\n'
        '  "risk": "CRITICAL | BREAKING | SAFE | SKIP",\n'
        '  "action": "one action sentence for the developer"\n'
        "}\n\n"
        "Rules for risk classification:\n"
        "- CRITICAL: Security patch (CVE), data-loss fix, or urgent emergency patch.\n"
        "- BREAKING: Removed APIs, renamed exports, major architectural changes requiring code edits.\n"
        "- SAFE: Bug fixes, performance improvements, backwards-compatible additions.\n"
        "- SKIP: Documentation only, typos, or cosmetic CI changes.\n"
    )

    # 1. Try Google AI Studio (Gemma 4 / Gemma 2 open weights) if API key is provided
    gemma_api_key = api_key or os.getenv("GEMMA_API_KEY", "")
    if gemma_api_key:
        gemma_model = os.getenv("GEMMA_MODEL", "gemma-4-26b-a4b-it")
        try:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{gemma_model}:generateContent?key={gemma_api_key}"
            payload = {
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {
                    "temperature": 0.1,
                    "maxOutputTokens": 600,
                },
            }
            resp = await client.post(url, json=payload, timeout=35.0)
            if resp.status_code == 200:
                data = resp.json()
                parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
                if parts:
                    raw_text = parts[0].get("text", "")
                    return _parse_gemma_response(raw_text, current, latest)
            logger.warning(f"Gemma API returned status {resp.status_code}: {resp.text[:120]}")
        except Exception as exc:
            logger.warning(f"Gemma API call failed: {exc}")

    # 2. Fall back to local Ollama if running
    if ollama_url:
        try:
            resp = await client.post(
                f"{ollama_url}/api/generate",
                json={
                    "model": model,
                    "prompt": prompt,
                    "stream": False,
                    "options": {"temperature": 0.1, "num_predict": 300},
                },
                timeout=40,
            )
            if resp.status_code == 200:
                raw = resp.json().get("response", "")
                return _parse_gemma_response(raw, current, latest)
        except Exception as exc:
            logger.debug(f"Ollama fallback error: {exc}")

    # 3. Intelligent heuristic fallback if neither endpoint responded
    return _heuristic_analysis(dep_name, current, latest, changelog)


def _parse_gemma_response(raw: str, current: str, latest: str) -> dict[str, str]:
    """Extract and validate JSON from Gemma's response."""
    # Strip markdown code blocks
    cleaned = re.sub(r"```(?:json)?", "", raw).strip()

    # Find JSON block
    m = re.search(r"\{[^{}]*\}", cleaned, re.DOTALL)
    if not m:
        return _heuristic_analysis("", current, latest, raw)

    try:
        obj = json.loads(m.group())
    except json.JSONDecodeError:
        return _heuristic_analysis("", current, latest, raw)

    risk_raw = str(obj.get("risk", "SAFE")).upper().strip()
    risk = RISK_MAP.get(risk_raw, risk_raw)
    if risk not in VALID_RISKS:
        risk = "SAFE"

    summary = str(obj.get("summary", f"Upgrade {current} → {latest}")).strip()
    action = str(obj.get("action", f"Run package tests and update to {latest}")).strip()

    return {
        "summary": summary[:300],
        "risk": risk,
        "action": action[:300],
    }


def _heuristic_analysis(dep_name: str, current: str, latest: str, text: str) -> dict[str, str]:
    """Deterministic fallback based on semver and changelog keyword matching."""
    lower = text.lower()
    
    # Check for security keywords
    if any(k in lower for k in ("cve-", "vulnerability", "security fix", "exploit", "advisory")):
        return {
            "summary": f"Security patch in {latest}: contains fixes for reported vulnerabilities.",
            "risk": "CRITICAL",
            "action": f"Update immediately to {latest} and run security audits.",
        }

    # Check for breaking change keywords or major semver bump
    curr_major = current.split(".")[0].lstrip("^~>=<")
    late_major = latest.split(".")[0].lstrip("^~>=<")
    if (curr_major and late_major and curr_major != late_major) or any(
        k in lower for k in ("breaking change", "breaking:", "deprecated", "removed", "no longer supported")
    ):
        return {
            "summary": f"Major update {current} → {latest}: contains breaking API changes.",
            "risk": "BREAKING",
            "action": f"Review API migration guide before updating to {latest}.",
        }

    # Check for trivial / docs
    if all(k in lower for k in ("docs", "readme", "typo")) and len(text) < 150:
        return {
            "summary": f"Maintenance update: documentation and metadata improvements.",
            "risk": "SKIP",
            "action": "Safe to skip or batch with regular updates.",
        }

    return {
        "summary": f"Bug fixes and performance improvements in {latest}.",
        "risk": "SAFE",
        "action": f"Safe to update to {latest}. Standard test pass recommended.",
    }
