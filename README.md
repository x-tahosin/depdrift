# DepDrift 🔄

**Know what changed in your stack before it breaks your code.**

DepDrift scans your GitHub repos overnight, reads every dependency changelog with [Gemma](https://ai.google.dev/gemma) running on a [DigitalOcean GPU Droplet](https://www.digitalocean.com/products/gpu-droplets), and delivers a color-coded morning report: what's critical, what's breaking, what's safe to ignore.

Built for the [Hacktoberfest Open-Source AI Challenge: Week 3 — Slow and Steady](https://dev.to/challenges/hacktoberfest-week3-2026-10-19).

## Why?

Every developer has outdated dependencies they keep ignoring. Dependabot opens PRs, but who reads the changelogs? DepDrift does — with Gemma.

**The lazy payoff:** Instead of manually reading 20 changelogs (40+ minutes), DepDrift scans everything in under a minute and tells you which updates actually matter.

## How It Works

1. Enter a GitHub username or `owner/repo`
2. DepDrift fetches every `package.json` and `requirements.txt`
3. Checks npm registry and PyPI for newer versions
4. Fetches GitHub release notes for outdated dependencies
5. Sends each changelog to **Gemma** (via Ollama) for analysis
6. Returns a risk classification: 🔴 CRITICAL · 🟡 BREAKING · 🟢 SAFE · ⚪ SKIP

## Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python 3.11+ · FastAPI · httpx |
| AI Model | Gemma 2 (via Ollama on DO GPU Droplet) |
| Frontend | Vanilla HTML/CSS/JS · glass-morphism dark theme |
| Hosting | DigitalOcean Droplet (app) + GPU Droplet (model) |
| Data | GitHub REST API · npm registry · PyPI API |

## Quick Start (Local)

```bash
# 1. Install Ollama and pull Gemma
curl -fsSL https://ollama.ai/install.sh | sh
ollama pull gemma2:2b

# 2. Clone and install
git clone https://github.com/x-tahosin/depdrift.git
cd depdrift
pip install -r requirements.txt

# 3. (Optional) Set a GitHub token for higher API limits
cp .env.example .env
# edit .env and add your GITHUB_TOKEN

# 4. Run
uvicorn app.main:app --reload --port 8000

# 5. Open http://localhost:8000
```

## Deploy on DigitalOcean

```bash
# 1. Create a GPU Droplet with 1-Click Ollama
#    Pull gemma2:9b on the GPU Droplet:
#    ollama pull gemma2:9b

# 2. Clone this repo on a regular Droplet
git clone https://github.com/x-tahosin/depdrift.git
cd depdrift

# 3. Set environment
export OLLAMA_URL=http://<gpu-droplet-private-ip>:11434
export GEMMA_MODEL=gemma2:9b
export GITHUB_TOKEN=<your-token>

# 4. Run with Docker Compose
docker compose up -d
```

Or use the `docker-compose.yml` to run both services on a single GPU Droplet.

## Why Open Innovation Matters

- **Privacy:** Your repo data and dependency analysis stay on YOUR DigitalOcean droplet — not sent to a third-party API.
- **Cost:** After the GPU Droplet hourly cost, there are no per-token charges. Run it as many times as you want.
- **Control:** Swap Gemma for any Ollama-compatible model. Customize the risk-classification prompt. Fine-tune for your stack.
- **Offline:** Once deployed, it works without any external AI service. The model runs locally on DO infrastructure.

## License

MIT
