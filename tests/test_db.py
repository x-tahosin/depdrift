"""Unit tests for SQLite audit history persistence."""

import os
import pytest
from app.db import delete_audit, get_audit, init_db, list_audits, save_audit


def test_audit_lifecycle(tmp_path, monkeypatch):
    test_db = tmp_path / "test_depdrift.db"
    monkeypatch.setattr("app.db.DB_PATH", test_db)
    init_db()

    target = "test-owner/test-repo"
    results = [
        {
            "repo_name": "test-owner/test-repo",
            "dependencies": [
                {"name": "express", "risk": "CRITICAL", "is_outdated": True},
                {"name": "cors", "risk": "BREAKING", "is_outdated": True},
                {"name": "react", "risk": "SAFE", "is_outdated": True},
                {"name": "lodash", "risk": "CURRENT", "is_outdated": False},
            ]
        }
    ]
    stats = {
        "total_deps": 4,
        "outdated": 3,
        "critical": 1,
        "breaking": 1,
        "safe": 1,
    }

    audit_id = save_audit(target, "github", results, stats)
    assert audit_id > 0

    # Test list_audits
    audits = list_audits(limit=10)
    assert len(audits) == 1
    assert audits[0]["target"] == target
    assert audits[0]["total_deps"] == 4
    assert audits[0]["critical_count"] == 1
    assert audits[0]["breaking_count"] == 1
    assert audits[0]["safe_count"] == 1

    # Test get_audit
    full = get_audit(audit_id)
    assert full is not None
    assert full["target"] == target
    assert len(full["results"]) == 1
    assert full["stats"]["total_deps"] == 4

    # Test delete_audit
    deleted = delete_audit(audit_id)
    assert deleted is True
    assert get_audit(audit_id) is None
    assert len(list_audits()) == 0
