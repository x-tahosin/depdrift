---
title: "DepDrift: The AI That Reads the Changelogs I'm Too Lazy to Read"
published: false
tags: devchallenge, hf26challenge, ai, opensource
---

*This is a submission for the [Hacktoberfest Open-Source AI Challenge Week 3: Slow and Steady](https://dev.to/challenges/hacktoberfest-week3-2026-10-19)*

## What I Built

Last Tuesday morning I opened VS Code and saw 23 Dependabot pull requests staring back at me. I closed the tab.

This isn't an isolated confession — it is the quiet daily reality of modern software development. I maintain several open-source repositories across TypeScript, React, and Python. Every single one of them has dependencies that drift behind upstream releases within weeks. 

I know the routine: I *should* click into every repository, find the release notes, read through hundreds of lines of changelog markdown, check whether any exports were renamed, verify if a security vulnerability was patched, and ensure my builds won't implode. 

But I also know that thoroughly auditing 20+ dependency changelogs takes anywhere from 40 to 60 minutes of tedious manual reading. And like most developers, I would rather spend that hour actually writing code. So the pull requests sit there. The dependencies stay outdated. And the security drift quietly accumulates.

**DepDrift** solves this problem by channeling pure developer laziness on my behalf.

You give DepDrift a GitHub username (like `x-tahosin`) or a specific repository. It discovers all project manifests (`package.json` and `requirements.txt`), inspects npm and PyPI registries for newer versions, extracts the release notes, and sends each changelog to **Gemma 4** — Google's state-of-the-art open-weight model. 

Where packages host their changelogs on modern client-side documentation websites (SPAs built with Docusaurus, Next.js, or VitePress where simple raw text endpoints do not exist), DepDrift spins up a cloud headless browser session via **Browserbase**. Browserbase renders the page, executes the client-side JavaScript, extracts the hydrated changelog text from the DOM, and feeds it directly into Gemma 4.

Gemma 4 then acts as an automated triage engineer, classifying each update into four clear, actionable buckets:

- 🔴 **CRITICAL** — Security vulnerability fixes (CVEs), data corruption patches, urgent fixes. *Action: Update immediately.*
- 🟡 **BREAKING** — Renamed exports, deprecated methods, major-version architectural changes. *Action: Review migration notes before bumping.*
- 🟢 **SAFE** — Backwards-compatible bug fixes, performance improvements, internal optimizations. *Action: Safe to batch update.*
- ⚪ **SKIP** — Documentation typos, formatting adjustments, trivial metadata updates. *Action: Ignore safely.*

Instead of spending an entire morning squinting through release notes, I open DepDrift, run a scan in 84 seconds, glance at the color-coded badges, patch the single critical CVE, and get on with my day.

---

## Demo

Here is a real scan of my own repository (`x-tahosin/giftofvoice`):

![DepDrift Scan Results showing 6 dependencies, 6 outdated, 1 critical, 1 Browserbase session, and 12 minutes saved](https://raw.githubusercontent.com/x-tahosin/depdrift/main/docs/demo-results.png)

### What the scan uncovered in under 90 seconds:
1. **`express` (4.21.2 → 5.3.0)** was instantly flagged as **`CRITICAL`** because Gemma identified security vulnerability patches in the major 5.x line.
2. **`dotenv` (16.4.7 → 18.0.9)** had its release notes rendered and extracted dynamically via **Browserbase** (Session ID: `78f81229...`), which Gemma flagged as **`BREAKING`** due to major API changes in the config parser.
3. **`cors`** and **`lucide-react`** were classified as **`BREAKING`** with specific recommendations to review breaking migration guides.
4. **`react`** and **`react-dom`** (19.0.0 → 19.3.1) were verified as **`SAFE`** with zero breaking changes, allowing me to batch-update them with complete confidence.

The entire scan streamed in real time via Server-Sent Events (SSE). You can watch each dependency being checked against the public registries, see the Browserbase cloud browser launch when a web-rendered changelog is encountered, and watch Gemma's structured risk analysis populate the cards dynamically.

---

## Code

🔗 **GitHub Repository:** [https://github.com/x-tahosin/depdrift](https://github.com/x-tahosin/depdrift) (or `{% github x-tahosin/depdrift %}` once public)

The repository is open source under the MIT License and includes:
- The async FastAPI backend with native Server-Sent Events (`app/main.py`)
- The Browserbase headless cloud browser client (`app/browserbase_client.py`)
- The Gemma 4 open-weights prompt engine (`app/gemma_analyzer.py`)
- The lightweight, zero-build vanilla frontend with glassmorphism UI and animated canvas particles (`static/`)

---

## How I Built It

### The Architecture

```
User (Browser Interface)
        │
        ▼
FastAPI Backend (Async SSE Stream)
        │
        ├── 1. GitHub REST API
        │      └── Discovers repos & parses package.json / requirements.txt
        │
        ├── 2. npm & PyPI Registry APIs
        │      └── Resolves latest published semver & repository metadata
        │
        ├── 3. Changelog Extraction Engine
        │      ├── GitHub Releases API (for standard GitHub releases)
        │      └── Browserbase Cloud Browser (for dynamic web changelogs & SPA docs)
        │            └── Playwright over CDP renders page & extracts clean DOM
        │
        └── 4. Gemma 4 Open-Weight Model (Google AI Studio)
               └── Evaluates changelog text with strict JSON schema:
                   { summary, risk: "CRITICAL"|"BREAKING"|"SAFE"|"SKIP", action }
```

### The Tech Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| **AI Model** | **Gemma 4** (`gemma-4-26b-a4b-it`) | High-capacity open weights with deep reasoning for technical changelogs |
| **Cloud Browser** | **Browserbase** | Headless Chrome infrastructure capable of executing JavaScript on modern doc sites |
| **Backend** | **Python 3.11 + FastAPI** | Native async concurrency, low memory footprint, and seamless SSE streaming |
| **Browser Protocol** | **Playwright (Python)** | Connects over Chrome DevTools Protocol (`connect_over_cdp`) directly to Browserbase |
| **Frontend** | **Vanilla HTML / CSS / JS** | Zero bundler overhead, instant page loads, pure native CSS tokens |

### The Browserbase Integration

One of the biggest real-world challenges in building an automated changelog reader is that **changelogs on the modern web are messy**. 

While some repositories publish clean GitHub release tags with raw markdown, hundreds of critical libraries (such as Next.js, Tailwind, Vue, Vite, and complex npm utilities) host their release notes exclusively on dynamic documentation portals built with VitePress, Docusaurus, or Next.js. 

If you use a simple HTTP `curl` or Python `requests` library to fetch these pages, you receive an empty shell:
```html
<div id="__next"></div>
<script src="/_next/static/chunks/main.js"></script>
```

Without JavaScript execution and browser hydration, the release notes are completely invisible to an AI agent.

This is where **Browserbase** becomes essential. In `app/browserbase_client.py`, when DepDrift detects that a package lacks standard GitHub release tags or points to external web documentation, it orchestrates a cloud browser session:

```python
# 1. Create a remote browser session via Browserbase REST API
resp = await client.post(
    "https://api.browserbase.com/v1/sessions",
    headers={"X-BB-API-Key": api_key, "Content-Type": "application/json"},
    json={"projectId": project_id}
)
session_data = resp.json()
connect_url = session_data["connectUrl"]
session_id = session_data["id"]

# 2. Connect Playwright over CDP to the remote Browserbase Chrome instance
async with async_playwright() as p:
    browser = await p.chromium.connect_over_cdp(connect_url, timeout=20000)
    page = await browser.new_page()

    # Navigate to the package documentation / changelog page
    await page.goto(url, wait_until="domcontentloaded", timeout=20000)
    await page.wait_for_timeout(1500)  # Wait for SPA hydration

    # Extract cleaned, rendered content from the DOM
    text = await page.evaluate("""() => {
        const unwanted = document.querySelectorAll('script, style, nav, footer, header, svg');
        unwanted.forEach(el => el.remove());
        const main = document.querySelector('main, article, .markdown-body, #readme');
        return (main ? main.innerText : document.body.innerText) || '';
    }""")
    await browser.close()
```

Every Browserbase session is tracked with its unique `session_id`. When the results render on the dashboard, each dependency that leveraged the cloud browser displays a distinct **`🌐 Browserbase Extracted`** badge alongside its real session ID, giving developers full provenance and auditability.

### Guiding Gemma 4 with Structured Output

Changelogs are notoriously verbose. A single release note can contain 5,000 words detailing minor refactors, contributor shoutouts, and CI badge fixes.

To keep the analysis fast and deterministic, DepDrift prompts **Gemma 4** with strict constraints:
- Low temperature (`0.1`) to prevent creative hallucination.
- Strict JSON output schema containing exactly `summary`, `risk`, and `action`.
- Explicit operational definitions for each risk tier (`CRITICAL`, `BREAKING`, `SAFE`, `SKIP`).

Here is a real example of the output Gemma 4 produced during our scan of `express` (4.21.2 → 5.3.0):

```json
{
  "summary": "Security patch in 5.3.0: contains fixes for reported vulnerabilities and open redirect issues.",
  "risk": "CRITICAL",
  "action": "Update immediately to 5.3.0 and run security regression tests."
}
```

---

## Why Does Open Innovation Matter?

This project is built around **open weights** (Gemma 4) and **open web standards**. Here is why open innovation was essential for DepDrift:

### 1. Security & Privacy: Your Dependency Tree Is a Attack Map
Your repository's `package.json` or `requirements.txt` is essentially an architectural fingerprint. It reveals the exact software versions you run in production and which unpatched CVEs your infrastructure is susceptible to. 

Sending your private dependency manifests to closed commercial AI APIs creates unnecessary compliance and security exposure. With open-weight models like Gemma 4, developers can run inference locally or in private VPCs. The dependency list, the changelog diffs, and the risk reports never leave infrastructure you control.

### 2. Predictable Cost: Zero Per-Token Tax
A medium-sized project can easily depend on 50 to 100 packages. Scanning 100 changelogs with a closed commercial model like GPT-4o would consume ~80,000 tokens per scan. If an engineering team runs this on every pull request, the API costs escalate rapidly into hundreds of dollars a month. 

Open-weight models democratize this workflow: you pay for compute when running, or leverage free developer tiers, with zero marginal per-token penalty.

### 3. Full Customization of the Risk Engine
With open models, the classification logic is not locked inside an opaque proprietary system prompt. If a team has internal architectural constraints — for example, if their backend relies on an internal monkey-patch of `requests` and therefore any change to `requests` must always be treated as `BREAKING` — they can adapt the prompt or fine-tune Gemma's weights on their own historical PR reviews.

---

## The Lazy Payoff

To measure the real-world value of DepDrift, I ran it against my active repository `x-tahosin/giftofvoice`:

| Metric | Before DepDrift (Manual Routine) | With DepDrift (Automated) |
|---|---|---|
| **Packages Outdated** | 6 packages | 6 packages |
| **Changelog Discovery** | Manually searching GitHub & npm docs | Automated via GitHub & Browserbase |
| **Audit Time** | ~2 minutes per changelog = **12 minutes** | **84 seconds** |
| **Context Switching** | 6 browser tabs opened and searched | Single unified dashboard |
| **Critical Findings** | Missed CVE until manual security audit | **1 Critical vulnerability flagged instantly** |

The lazy payoff isn't just saving 10 to 15 minutes of reading per repository. **The real payoff is eliminating the mental friction that causes developers to ignore updates in the first place.**

When I see a single card that says `react: SAFE — bug fixes in 19.3.1, standard test pass recommended`, I don't have to think. I run `npm update react`, run my test suite, and merge the branch. The decision fatigue is gone.

---

## Prize Categories

### 🌟 Best Use of Browserbase
DepDrift integrates **Browserbase**'s headless cloud browser infrastructure as a core component of its changelog ingestion pipeline:
- **Dynamic DOM Rendering:** Resolves and executes JavaScript on modern SPA documentation portals (Docusaurus, Next.js, VitePress) where raw markdown releases do not exist.
- **CDP Protocol Integration:** Leverages Playwright to connect directly to Browserbase cloud sessions via Chrome DevTools Protocol (`connect_over_cdp`).
- **Session Provenance:** Automatically tracks each Browserbase session ID (`session_id`) and displays audit tags directly on the developer dashboard cards.
- **Configuration:** Fully configurable via `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` in `.env`.

---

## What's Next

1. **GitHub Action Integration:** Running DepDrift as a scheduled workflow that posts a weekly summarized drift digest directly into GitHub Discussions.
2. **Automated PR Generation:** Allowing developers to click "Safe Auto-Update" on any `SAFE`-tier dependency to automatically generate a validated, tested pull request.

*Thanks to the DEV Community and the MLH team for hosting Hacktoberfest 2026!*
