"""Inactivity timings editable from the portal."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.assistant.sessions import SessionStore
from app.config import load_settings
from app.main import create_app

from .test_assistant import FakeClock


def make(tmp_path, clock=None) -> TestClient:
    s = load_settings(database_path=str(tmp_path / "s.db"), mock_ai=True, gemini_api_key="",
                      elevenlabs_api_key="", uploads_dir=str(tmp_path / "up"))
    store = SessionStore(idle_timeout_s=s.session_idle_timeout_s, max_frames=10, clock=clock or FakeClock())
    return TestClient(create_app(s, session_store=store))


def test_defaults(tmp_path) -> None:
    c = make(tmp_path)
    assert c.get("/settings/assistant").json() == {"idle_after_s": 60, "purge_after_s": 600}


def test_update_persists_and_sessions_report_it(tmp_path) -> None:
    c = make(tmp_path)
    r = c.put("/settings/assistant", json={"idle_after_s": 120, "purge_after_s": 1800})
    assert r.status_code == 200 and r.json() == {"idle_after_s": 120, "purge_after_s": 1800}
    session = c.post("/sessions", json={}).json()
    assert session["idle_after_s"] == 120 and session["purge_after_s"] == 1800
    assert session["idle_timeout_s"] == 1800
    again = make(tmp_path)  # restart: read back from SQLite
    assert again.get("/settings/assistant").json()["purge_after_s"] == 1800


@pytest.mark.parametrize("body", [
    {"idle_after_s": 300, "purge_after_s": 120},   # purge must be longer
    {"idle_after_s": 5, "purge_after_s": 600},     # too short
    {"idle_after_s": 60, "purge_after_s": 999_999},
    {"idle_after_s": 60},
])
def test_rejects_bad_values(tmp_path, body) -> None:
    c = make(tmp_path)
    r = c.put("/settings/assistant", json=body)
    assert r.status_code == 422 and r.json()["error"] == "malformed"
    assert c.get("/settings/assistant").json() == {"idle_after_s": 60, "purge_after_s": 600}


def test_server_purge_follows_the_setting(tmp_path) -> None:
    clock = FakeClock()
    c = make(tmp_path, clock)
    c.put("/settings/assistant", json={"idle_after_s": 30, "purge_after_s": 120})
    sid = c.post("/sessions", json={}).json()["session_id"]
    clock.t += 121
    assert c.get(f"/sessions/{sid}").status_code == 410
