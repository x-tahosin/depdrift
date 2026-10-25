"""Gemma-powered changelog analysis via Ollama."""

from __future__ import annotations

import json
import re

import httpx


VALID_RISKS = frozenset({"CRITICAL", "BREAKING", "SAFE", "SKIP"})


async def analyze_changelog(
    client: httpx.AsyncClient,
    ollama_url: str,
    model: str,
    dep_name: str,
    current: str,
    latest: str,
    changelog: str,
) -> dict[str, str]:
    """Send a dependency changelog to Gemma and get a structured analysis.

    Returns {"summary": ..., "risk": ..., "action": ...}.
    Falls back gracefully if Ollama is unreachable.
    """
    if not changelog.strip():
        return {
            "summary": f"Update available: {current} → {latest}. No changelog found.",
            "risk": "UNKNOWN",
            "action": "Review release page manually before updating.",
        }

    prompt = (
        "You are a dependency-update analyst. "
        "Read the changelog below and respond with ONLY valid JSON — "
        "no markdown fences, no explanation.\n\n"
        f"Package: {dep_name}\n"
        f"Current version: {current}\n"
        f"Latest version: {latest}\n\n"
        f"Changelog:\n{changelog[:2500]}\n\n"
        "Respond with exactly this JSON shape:\n"
        '{"summary":"one sentence on what changed",'
        '"risk":"CRITICAL or BREAKING or SAFE or SKIP",'
        '"action":"one sentence telling the developer what to do"}\n\n'
        "Risk guide:\n"
        "- CRITICAL = security fix, data-loss fix, or urgent patch\n"
        "- BREAKING = removed API, renamed exports, major-version incompatibility\n"
        "- SAFE = bug fixes, perf gains, new non-breaking features\n"
        "- SKIP = docs-only, typo fixes, cosmetic changes\n"
    )

    try:
        resp = await client.post(
            f"{ollama_url}/api/generate",
            json={
                "model": model,
                "prompt": prompt,
                "stream": False,
                "options": {"temperature": 0.1, "num_predict": 300},
            },
            timeout=90,
        )

        if resp.status_code != 200:
            return _fallback(current, latest, "Gemma returned non-200")

        raw = resp.json().get("response", "")
        return _parse_gemma_response(raw, current, latest)

    except httpx.ConnectError:
        return _fallback(current, latest, "Ollama not reachable — run it on your DO GPU Droplet")
    except httpx.TimeoutException:
        return _fallback(current, latest, "Gemma timed out")
    except Exception as exc:
        return _fallback(current, latest, str(exc)[:80])


def _parse_gemma_response(raw: str, current: str, latest: str) -> dict[str, str]:
    """Extract JSON from Gemma's response, tolerating markdown fences."""
    # strip markdown code fences if present
    cleaned = re.sub(r"```(?:json)?", "", raw).strip()

    # find first JSON object
    m = re.search(r"\{[^{}]*\}", cleaned, re.DOTALL)
    if not m:
        return _fallback(current, latest, "Could not parse Gemma output")

    try:
        obj = json.loads(m.group())
    except json.JSONDecodeError:
        return _fallback(current, latest, "Invalid JSON from Gemma")

    # normalise risk level
    risk = str(obj.get("risk", "UNKNOWN")).upper().strip()
    if risk not in VALID_RISKS:
        risk = "UNKNOWN"

    return {
        "summary": str(obj.get("summary", f"Update {current} → {latest}"))[:300],
        "risk": risk,
        "action": str(obj.get("action", "Review manually"))[:300],
    }


def _fallback(current: str, latest: str, reason: str) -> dict[str, str]:
    return {
        "summary": f"Update available: {current} → {latest}.",
        "risk": "UNKNOWN",
        "action": f"Manual review needed ({reason}).",
    }
