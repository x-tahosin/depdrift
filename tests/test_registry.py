"""Unit tests for registry semver comparison and registry clients."""

import pytest
from app.registry_client import is_outdated


def test_is_outdated_comparison():
    assert is_outdated("4.21.0", "5.3.0") is True
    assert is_outdated("1.0.0", "1.0.1") is True
    assert is_outdated("1.2.0", "1.3.0") is True
    assert is_outdated("2.0.0", "2.0.0") is False
    assert is_outdated("2.0.1", "2.0.0") is False
    assert is_outdated("latest", "1.0.0") is False
    assert is_outdated("*", "1.0.0") is False
    assert is_outdated("", "1.0.0") is False
    assert is_outdated("1.0.0", "") is False


def test_is_outdated_prerelease():
    # Pre-release comparison: 1.0.0 is newer than 1.0.0a1
    assert is_outdated("1.0.0a1", "1.0.0") is True
    assert is_outdated("1.0.0", "1.0.0a1") is False
