import sys
import io
import json
import requests
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

API_KEY = "zxZNiSpR5RuKjM99LrbRSqaB"
HEADERS = {
    "api-key": API_KEY,
    "Content-Type": "application/json"
}

POST_FILE = Path(__file__).resolve().parent.parent / "DEV_POST.md"

def main():
    if not POST_FILE.exists():
        print(f"Error: {POST_FILE} not found")
        sys.exit(1)

    content = POST_FILE.read_text(encoding="utf-8")
    
    # Check existing articles on account
    print("Checking existing articles on DEV.to...")
    res = requests.get("https://dev.to/api/articles/me/all", headers=HEADERS)
    if res.status_code != 200:
        print(f"Error fetching articles: {res.status_code} - {res.text}")
        sys.exit(1)
        
    articles = res.json()
    depdrift_article = None
    for a in articles:
        if "depdrift" in a.get("title", "").lower() or "depdrift" in a.get("slug", "").lower():
            depdrift_article = a
            break
            
    payload = {
        "article": {
            "title": "DepDrift: Catch Breaking Changes in Your Dependencies Before Prod",
            "body_markdown": content,
            "published": True,
            "main_image": "https://raw.githubusercontent.com/x-tahosin/depdrift/main/docs/cover.png",
            "canonical_url": "https://github.com/x-tahosin/depdrift",
            "tags": ["devchallenge", "hf26challenge", "browserbase", "opensource"]
        }
    }
    
    if depdrift_article:
        art_id = depdrift_article["id"]
        print(f"Found existing DepDrift draft/article ID {art_id}. Updating via PUT...")
        update_url = f"https://dev.to/api/articles/{art_id}"
        resp = requests.put(update_url, headers=HEADERS, json=payload)
        if resp.status_code in (200, 201):
            data = resp.json()
            print(f"SUCCESS: Article updated successfully!")
            print(f"Article ID: {data.get('id')}")
            print(f"Draft Edit URL: https://dev.to/dashboard/articles/{data.get('id')}/edit")
            print(f"Public URL: {data.get('url')}")
        else:
            print(f"Update failed ({resp.status_code}): {resp.text}")
            sys.exit(1)
    else:
        print("No existing DepDrift article found. Creating new draft via POST...")
        create_url = "https://dev.to/api/articles"
        resp = requests.post(create_url, headers=HEADERS, json=payload)
        if resp.status_code in (200, 201):
            data = resp.json()
            print(f"SUCCESS: New draft created on DEV.to!")
            print(f"Article ID: {data.get('id')}")
            print(f"Draft Edit URL: https://dev.to/dashboard/articles/{data.get('id')}/edit")
            print(f"Public/Preview URL: {data.get('url')}")
        else:
            print(f"Creation failed ({resp.status_code}): {resp.text}")
            sys.exit(1)

if __name__ == "__main__":
    main()
