---
title: "DepDrift: Catch Breaking Changes in Your Deps Before They Break Prod"
published: false
tags: devchallenge, hacktoberfest, browserbase, opensource
canonical_url: https://github.com/x-tahosin/depdrift
cover_image: https://raw.githubusercontent.com/x-tahosin/depdrift/main/docs/cover.png
---

![DepDrift Banner](https://raw.githubusercontent.com/x-tahosin/depdrift/main/docs/cover.png)

*This is a submission for the [Hacktoberfest Open-Source AI Challenge Week 3: Slow and Steady](https://dev.to/challenges/hacktoberfest-week3-2026-10-19)*

**Target Category:** Best Use of Browserbase

---

## What I Built

Every engineer knows the routine: Dependabot opens 15 pull requests on Monday morning. You know you should update, but you also know that reading 15 release changelogs takes 45 minutes of tedious clicking. 

Worse, half of modern libraries do not publish neat GitHub releases. They host their release notes on custom documentation sites built with Docusaurus, Next.js, or VitePress. Plain `curl` or markdown scrapers fail because there is no raw text API, only JavaScript that renders on the client.

So the PRs sit there. Dependencies drift months behind. Critical CVEs go unnoticed.

**DepDrift** is an automated dependency risk auditor. You point it at any GitHub user or repo, or paste a manifest directly. It inspects all outdated packages, navigates dynamic release pages using **Browserbase's headless cloud browser**, and uses **Gemma 4** to triage each update into clear, actionable risk levels:

- **CRITICAL**: Active CVE security vulnerability detected. Update immediately.
- **BREAKING**: Breaking API changes, renamed exports, or removed configuration keys.
- **SAFE**: Backward-compatible bug fixes and performance patches. Safe to batch bump.
- **CURRENT**: Up to date.

### The Web Interface

Here is the clean, dark-mode web interface of DepDrift:

![DepDrift Web Interface](https://raw.githubusercontent.com/x-tahosin/depdrift/main/docs/hero.png)

---

## Demo

- **Live Interactive Demo:** [https://x-tahosin.github.io/depdrift/](https://x-tahosin.github.io/depdrift/)
- **GitHub Repository:** [https://github.com/x-tahosin/depdrift](https://github.com/x-tahosin/depdrift)

Here is a real audit run on my own repository (`x-tahosin/giftofvoice`):

![DepDrift Results Dashboard](https://raw.githubusercontent.com/x-tahosin/depdrift/main/docs/results-dashboard.png)

### What the scan caught in 90 seconds:
1. **`express` (4.21.2 -> 5.3.0)**: Flagged as **CRITICAL** due to known parameter injection advisories (CVE-2024-52798) and major v5 query property changes.
2. **`dotenv` (16.4.7 -> 18.0.9)**: Required a live browser session to render its release notes. Browserbase spun up a headless Chrome session, extracted the changelog, and Gemma flagged breaking config parser updates.
3. **`vite` (6.2.0 -> 8.3.5)**: Flagged as **CRITICAL** for custom middleware script execution vulnerabilities (CVE-2025-30211).
4. **`react` & `react-dom` (19.0.0 -> 19.3.1)**: Verified as **SAFE**, with zero breaking changes, ready for a safe batch bump.

### Deep CVE & Vulnerability Inspector

Clicking any card on the website opens a dedicated drawer showing the exact GitHub Security Advisory IDs (GHSA / CVE), severity ratings, official links, and a 1-click update command:

![Deep CVE Inspector](https://raw.githubusercontent.com/x-tahosin/depdrift/main/docs/cve-modal.png)

---

## How Browserbase Powers the Changelog Engine

Standard scrapers break on modern open-source documentation. When a library publishes release notes inside a client-side SPA or behind client hydration, plain HTTP GET requests return an empty `<div id="root"></div>`.

This is where **Browserbase** shines. DepDrift uses Browserbase's cloud browser infrastructure over the Chrome DevTools Protocol (`connect_over_cdp`):

1. **On-Demand Cloud Session**: DepDrift requests an ephemeral browser session from the Browserbase REST API.
2. **Dynamic Page Hydration**: Playwright connects to the session URL over CDP, opens the release page, and waits for `domcontentloaded` and network idle states.
3. **Intelligent Text Extraction**: It removes navigation bars, footers, and scripts, extracting clean, structured release text from the rendered DOM.
4. **Session Transparency**: Every Browserbase-extracted card displays its unique session ID in the UI so you can verify the exact cloud execution.

```python
# Connecting Playwright to Browserbase cloud browser over CDP
session = await create_browserbase_session()
browser = await playwright.chromium.connect_over_cdp(session["connectUrl"])
page = await browser.new_page()

await page.goto(changelog_url, wait_until="domcontentloaded", timeout=25000)
# Extract clean rendered changelog from the hydrated DOM
changelog_text = await page.evaluate("() => document.querySelector('main, article, .content')?.innerText")
```

---

## Gemma 4 Risk Classification

Raw changelog text is often thousands of words long. DepDrift pipes the extracted changelog diff into **Gemma 4** (`gemma-4-26b-a4b-it`) with a strict JSON schema:

```json
{
  "summary": "1-2 sentence technical summary of what actually changed",
  "risk": "CRITICAL | BREAKING | SAFE | CURRENT",
  "action": "Concrete next step for the developer"
}
```

This turns walls of release notes into instant triage decisions you can act on in 5 seconds.

---

## 1-Click Remediation

DepDrift does not just show you warnings; it gives you the fix:
- **Copy Safe Bump Script**: Generates a single terminal command updating all SAFE packages together (`npm install react@^19.3.1 react-dom@^19.3.1`).
- **Copy PR Markdown**: Formats the entire audit into a GitHub PR description table ready to paste into your repo.
- **Export JSON**: Download the full audit data for CI/CD integration.

---

## Architecture & Code

```
User (Browser)
      │
      ▼
FastAPI Backend (Real-Time SSE Stream)
      │
      ├── GitHub REST API (Finds repos and parses manifests)
      ├── npm & PyPI Registry APIs (Resolves latest versions)
      ├── GitHub Advisory Database (Validates CVEs via SpecifierSet)
      ├── Browserbase (Renders dynamic SPAs via cloud Chrome over CDP)
      └── Gemma 4 (Open-Weights Model analyzes diff and assigns risk)
```

- **Live Hosted Demo:** [https://x-tahosin.github.io/depdrift/](https://x-tahosin.github.io/depdrift/)
- **Source Code:** [https://github.com/x-tahosin/depdrift](https://github.com/x-tahosin/depdrift)
- **License:** MIT
- **Stack:** Python 3.11+, FastAPI, Playwright, Browserbase, Gemma 4, Vanilla CSS/JS
- **Test Suite:** 12/12 unit and integration tests passing

Building DepDrift turned Monday morning dependency dread into a 90-second automated check. Check out the repository, try the live demo, and stop guessing what changed in your stack.
