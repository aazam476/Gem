from __future__ import annotations

import base64
import io
import ipaddress
import os
import socket
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import load_settings
from app.main import create_app
from app.rules import blood_pressure_preset

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"
LIVE = os.getenv("GEM_LIVE_TESTS") == "1"


@pytest.fixture(autouse=True)
def _no_network(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> None:
    """Hard rule: tests never reach live APIs (except opt-in @pytest.mark.live)."""
    if request.node.get_closest_marker("live") is not None:
        return
    real_connect = socket.socket.connect

    def guarded(self: socket.socket, address: Any) -> Any:
        host = address[0] if isinstance(address, tuple) else None
        if host is not None:
            try:
                if not ipaddress.ip_address(host).is_loopback:
                    raise RuntimeError(f"network access blocked in tests: {address}")
            except ValueError:
                if host != "localhost":
                    raise RuntimeError(f"network access blocked in tests: {address}") from None
        return real_connect(self, address)

    monkeypatch.setattr(socket.socket, "connect", guarded)


def jpeg_b64(color: tuple[int, int, int] = (200, 200, 200), size: tuple[int, int] = (640, 480)) -> str:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="JPEG")
    return base64.b64encode(buf.getvalue()).decode()


@pytest.fixture
def fixture_photo_b64() -> str:
    return base64.b64encode((FIXTURES / "bp_monitor_synthetic.jpg").read_bytes()).decode()


def make_client(tmp_path: Path, *, vision: Any = None, voice: Any = None, **overrides: Any) -> TestClient:
    settings = load_settings(
        database_path=str(tmp_path / "test.db"),
        **{"mock_ai": True, "gemini_api_key": "", "elevenlabs_api_key": "", **overrides},
    )
    return TestClient(create_app(settings, vision=vision, voice=voice))


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    with make_client(tmp_path) as c:
        yield c


def bp_protocol_body(**overrides: Any) -> dict[str, Any]:
    body = {
        "title": "Home blood pressure",
        "prompt_text": "Step 1: Check the blood pressure monitor. Find the systolic and diastolic values.",
        "validation_rules": blood_pressure_preset().model_dump(),
        "activate": True,
    }
    body.update(overrides)
    return body


@pytest.fixture
def protocol(client: TestClient) -> dict[str, Any]:
    resp = client.post("/protocols", json=bp_protocol_body())
    assert resp.status_code == 201, resp.text
    return resp.json()
