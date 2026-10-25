"""Integration tests for DepDrift FastAPI API endpoints using TestClient."""

import pytest
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_health_endpoint():
    resp = client.get("/api/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert "model" in data
    assert "browserbase_configured" in data


def test_diagnostics_endpoint():
    resp = client.get("/api/diagnostics")
    assert resp.status_code == 200
    data = resp.json()
    assert "github" in data
    assert "browserbase" in data
    assert "gemma" in data
    assert "registries" in data


def test_history_endpoint():
    resp = client.get("/api/history")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


def test_manifest_scan_invalid_syntax():
    resp = client.post(
        "/api/scan/manifest",
        json={"filename": "package.json", "content": "not valid json"}
    )
    assert resp.status_code == 400
