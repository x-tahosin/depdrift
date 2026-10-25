"""Unit tests for dependency parsers (package.json and requirements.txt)."""

import json
import pytest
from app.dep_parser import parse_package_json, parse_requirements_txt


def test_parse_package_json_dependencies():
    content = json.dumps({
        "name": "test-pkg",
        "dependencies": {
            "express": "^4.21.2",
            "cors": "~2.8.5",
            "lodash": "4.17.21"
        },
        "devDependencies": {
            "jest": "^29.0.0"
        }
    })
    parsed = parse_package_json(content, include_dev=True)
    names = [name for name, _ in parsed]
    assert "express" in names
    assert "cors" in names
    assert "lodash" in names
    assert "jest" in names
    assert len(parsed) == 4


def test_parse_package_json_clean_version():
    content = json.dumps({
        "dependencies": {
            "pkg-a": "^1.2.3",
            "pkg-b": "~2.0.1",
            "pkg-c": ">=3.0.0",
            "pkg-d": "4.5.6"
        }
    })
    parsed = dict(parse_package_json(content))
    assert parsed["pkg-a"] == "1.2.3"
    assert parsed["pkg-b"] == "2.0.1"
    assert parsed["pkg-c"] == "3.0.0"
    assert parsed["pkg-d"] == "4.5.6"


def test_parse_package_json_invalid():
    assert parse_package_json("not json") == []
    assert parse_package_json("{}") == []


def test_parse_requirements_txt_simple():
    content = """
    fastapi==0.110.0
    uvicorn>=0.28.0
    httpx~=0.27.0
    pydantic
    # a comment
    requests==2.31.0 --no-deps
    """
    parsed = dict(parse_requirements_txt(content))
    assert parsed["fastapi"] == "0.110.0"
    assert parsed["uvicorn"] == "0.28.0"
    assert parsed["httpx"] == "0.27.0"
    assert parsed["requests"] == "2.31.0"
    assert parsed["pydantic"] == "unknown"
    assert "#" not in parsed


def test_parse_requirements_txt_empty():
    assert parse_requirements_txt("") == []
    assert parse_requirements_txt("# only comments\n# here") == []
