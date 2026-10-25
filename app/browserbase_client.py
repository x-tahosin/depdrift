"""Browserbase-powered headless cloud browser for dynamic changelog extraction."""

from __future__ import annotations

import logging
import os
import re
from typing import Optional

import httpx
from playwright.async_api import async_playwright

logger = logging.getLogger(__name__)

BROWSERBASE_API_KEY = os.getenv("BROWSERBASE_API_KEY", "")
BROWSERBASE_PROJECT_ID = os.getenv("BROWSERBASE_PROJECT_ID", "")
BROWSERBASE_API_URL = "https://api.browserbase.com/v1"


async def fetch_web_changelog(url: str, max_chars: int = 3500) -> dict[str, Optional[str]]:
    """Use a remote Browserbase cloud browser to render and extract a changelog page.
    
    Returns:
        {
            "content": str (extracted text),
            "session_id": str (Browserbase session ID for auditing),
            "source": "browserbase"
        }
    """
    api_key = os.getenv("BROWSERBASE_API_KEY", BROWSERBASE_API_KEY)
    project_id = os.getenv("BROWSERBASE_PROJECT_ID", BROWSERBASE_PROJECT_ID)

    if not api_key:
        return {"content": None, "session_id": None, "source": "none"}

    session_id = None
    try:
        # 1. Create a remote browser session via Browserbase API
        async with httpx.AsyncClient(timeout=15.0) as client:
            payload = {}
            if project_id:
                payload["projectId"] = project_id
            
            resp = await client.post(
                f"{BROWSERBASE_API_URL}/sessions",
                headers={
                    "X-BB-API-Key": api_key,
                    "Content-Type": "application/json"
                },
                json=payload
            )
            if resp.status_code not in (200, 201):
                logger.warning(f"Browserbase session create failed: {resp.status_code} {resp.text}")
                return {"content": None, "session_id": None, "source": "none"}

            session_data = resp.json()
            session_id = session_data.get("id")
            connect_url = session_data.get("connectUrl")

        if not connect_url:
            return {"content": None, "session_id": None, "source": "none"}

        # 2. Connect Playwright over CDP to the remote Browserbase Chrome instance
        async with async_playwright() as p:
            browser = await p.chromium.connect_over_cdp(connect_url, timeout=20000)
            context = browser.contexts[0] if browser.contexts else await browser.new_context()
            page = context.pages[0] if context.pages else await context.new_page()

            # Navigate and extract
            await page.goto(url, wait_until="domcontentloaded", timeout=20000)
            
            # Wait briefly for dynamic changelog content/hydration
            try:
                await page.wait_for_timeout(1500)
            except Exception:
                pass

            # Extract main text content
            text = await page.evaluate("""() => {
                // Remove scripts, styles, nav, footer
                const unwanted = document.querySelectorAll('script, style, nav, footer, header, svg, noscript');
                unwanted.forEach(el => el.remove());
                
                // Prefer main/article content if present
                const main = document.querySelector('main, article, .markdown-body, #readme, .changelog');
                return (main ? main.innerText : document.body.innerText) || '';
            }""")
            
            await browser.close()

            # Clean and normalize text
            cleaned = re.sub(r"\n{3,}", "\n\n", text.strip())[:max_chars]
            return {
                "content": cleaned,
                "session_id": session_id,
                "source": "browserbase"
            }

    except Exception as exc:
        logger.warning(f"Browserbase fetch error for {url}: {exc}")
        return {"content": None, "session_id": session_id, "source": "none"}
