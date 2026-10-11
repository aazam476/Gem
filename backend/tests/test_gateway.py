"""Correctness invariants of the deterministic gateway (Lucera track).

Run: pytest tests/test_gateway.py
"""

from __future__ import annotations

import math
import threading
import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.gateway import compile_rules, evaluate
from app.rules import CrossFieldRule, MetricRule, ValidationRules, blood_pressure_preset

from .conftest import bp_protocol_body, make_client

RULES = compile_rules(blood_pressure_preset())


def codes(verdict) -> list[str]:
    return [i.code for i in verdict.errors]


# -- pure function -------------------------------------------------------------


class TestEvaluate:
    def test_valid_reading_accepted(self) -> None:
        v = evaluate(RULES, {"systolic": 128, "diastolic": 82, "pulse": 71})
        assert v.outcome == "accepted"
        assert v.values == {"systolic": 128.0, "diastolic": 82.0, "pulse": 71.0}
        assert v.errors == () and v.flags == ()

    def test_optional_metric_may_be_absent(self) -> None:
        assert evaluate(RULES, {"systolic": 120, "diastolic": 80}).outcome == "accepted"

    def test_hallucinated_900_rejected(self) -> None:
        v = evaluate(RULES, {"systolic": 900, "diastolic": 82})
        assert v.outcome == "rejected"
        assert codes(v) == ["implausible"]

    def test_implausibly_low_rejected(self) -> None:
        assert codes(evaluate(RULES, {"systolic": 120, "diastolic": 5})) == ["implausible"]

    def test_above_expected_range_is_flagged_not_discarded(self) -> None:
        v = evaluate(RULES, {"systolic": 210, "diastolic": 100})
        assert v.outcome == "flagged"
        assert [f.code for f in v.flags] == ["above_range"]
        assert v.values["systolic"] == 210.0

    def test_below_expected_range_is_flagged(self) -> None:
        v = evaluate(RULES, {"systolic": 85, "diastolic": 55})
        assert v.outcome == "flagged"
        assert [f.code for f in v.flags] == ["below_range"]

    @pytest.mark.parametrize("value,ok", [(50, True), (260, True), (49.9, False), (260.1, False)])
    def test_hard_limits_are_inclusive(self, value: float, ok: bool) -> None:
        v = evaluate(RULES, {"systolic": value, "diastolic": 40})
        assert (v.outcome != "rejected") is ok

    def test_missing_required_metric_rejected(self) -> None:
        v = evaluate(RULES, {"systolic": 120})
        assert codes(v) == ["missing_metric"]

    def test_null_required_metric_rejected(self) -> None:
        assert codes(evaluate(RULES, {"systolic": 120, "diastolic": None})) == ["missing_metric"]

    @pytest.mark.parametrize("bad", ["120", True, [120], {"v": 1}, math.nan, math.inf])
    def test_non_numbers_rejected(self, bad: Any) -> None:
        v = evaluate(RULES, {"systolic": bad, "diastolic": 80})
        assert codes(v) == ["not_a_number"]

    def test_unknown_metric_rejected(self) -> None:
        v = evaluate(RULES, {"systolic": 120, "diastolic": 80, "glucose": 5})
        assert codes(v) == ["unexpected_metric"]

    @pytest.mark.parametrize("bad", [None, [], "120/80", 120])
    def test_malformed_payload_rejected(self, bad: Any) -> None:
        assert codes(evaluate(RULES, bad)) == ["malformed"]

    def test_cross_field_systolic_must_exceed_diastolic(self) -> None:
        v = evaluate(RULES, {"systolic": 90, "diastolic": 95})
        assert v.outcome == "rejected"
        assert codes(v) == ["cross_field"]

    def test_equal_systolic_diastolic_rejected(self) -> None:
        assert codes(evaluate(RULES, {"systolic": 100, "diastolic": 100})) == ["cross_field"]

    def test_deterministic(self) -> None:
        payload = {"systolic": 210, "diastolic": 100, "pulse": 300}
        first = evaluate(RULES, payload)
        assert all(evaluate(RULES, payload) == first for _ in range(1000))


class TestRuleSchema:
    def test_bad_ordering_refused(self) -> None:
        with pytest.raises(ValidationError):
            MetricRule(name="systolic", min=90, max=180, hard_min=100, hard_max=260)

    def test_duplicate_metric_names_refused(self) -> None:
        m = MetricRule(name="x", min=1, max=2, hard_min=0, hard_max=3)
        with pytest.raises(ValidationError):
            ValidationRules(metrics=[m, m])

    def test_cross_field_must_reference_known_metrics(self) -> None:
        m = MetricRule(name="x", min=1, max=2, hard_min=0, hard_max=3)
        with pytest.raises(ValidationError):
            ValidationRules(metrics=[m], cross_field=[CrossFieldRule(left="x", right="y")])


# -- HTTP: POST /ingest_vitals ---------------------------------------------------


def submit(client: TestClient, protocol_id: str, readings: Any, key: str | None = None, **extra: Any):
    body = {
        "protocol_id": protocol_id,
        "patient_id": "patient-demo-001",
        "session_id": "session-1",
        "idempotency_key": key or str(uuid.uuid4()),
        "readings": readings,
        **extra,
    }
    return client.post("/ingest_vitals", json=body)


class TestIngestEndpoint:
    def test_valid_201(self, client: TestClient, protocol: dict) -> None:
        r = submit(client, protocol["protocol_id"], {"systolic": 128, "diastolic": 82})
        assert r.status_code == 201
        body = r.json()
        assert body["result"] == "accepted"
        assert body["event"]["extracted_data"] == {"systolic": 128.0, "diastolic": 82.0}
        assert body["validation_ns"] > 0
        assert body["voice_line_id"] == "saved"

    def test_out_of_bounds_422_and_not_stored(self, client: TestClient, protocol: dict) -> None:
        r = submit(client, protocol["protocol_id"], {"systolic": 900, "diastolic": 82})
        assert r.status_code == 422
        assert r.json()["error"] == "rejected"
        assert r.json()["errors"][0]["code"] == "implausible"
        assert r.json()["voice_line_id"] == "retake_unusual"
        assert client.get("/events").json() == []
        rejections = client.get("/rejections").json()
        assert len(rejections) == 1 and rejections[0]["errors"][0]["metric"] == "systolic"

    def test_flagged_is_stored(self, client: TestClient, protocol: dict) -> None:
        r = submit(client, protocol["protocol_id"], {"systolic": 210, "diastolic": 100})
        assert r.status_code == 201
        assert r.json()["result"] == "flagged"
        assert r.json()["voice_line_id"] == "saved_flagged"
        events = client.get("/events").json()
        assert events[0]["status"] == "flagged" and events[0]["flags"][0]["code"] == "above_range"

    def test_missing_metric_422(self, client: TestClient, protocol: dict) -> None:
        r = submit(client, protocol["protocol_id"], {"systolic": 128})
        assert r.status_code == 422 and r.json()["errors"][0]["code"] == "missing_metric"

    @pytest.mark.parametrize("body", [
        {},
        {"protocol_id": "x"},
        {"protocol_id": "x", "patient_id": "p", "session_id": "s", "idempotency_key": "k", "readings": [1]},
        {"protocol_id": "x", "patient_id": "p", "session_id": "s", "idempotency_key": "has space", "readings": {}},
    ])
    def test_malformed_payload_422(self, client: TestClient, protocol: dict, body: dict) -> None:
        r = client.post("/ingest_vitals", json=body)
        assert r.status_code == 422 and r.json()["error"] == "malformed"

    def test_non_json_body_422(self, client: TestClient, protocol: dict) -> None:
        r = client.post("/ingest_vitals", content=b"systolic=900", headers={"content-type": "application/json"})
        assert r.status_code == 422

    def test_duplicate_key_counts_once(self, client: TestClient, protocol: dict) -> None:
        first = submit(client, protocol["protocol_id"], {"systolic": 128, "diastolic": 82}, key="k-1")
        again = submit(client, protocol["protocol_id"], {"systolic": 128, "diastolic": 82}, key="k-1")
        assert first.status_code == 201
        assert again.status_code == 409 and again.json()["error"] == "duplicate"
        assert again.json()["event"]["event_id"] == first.json()["event"]["event_id"]
        assert len(client.get("/events").json()) == 1

    def test_key_reuse_with_different_payload_409_conflict(self, client: TestClient, protocol: dict) -> None:
        submit(client, protocol["protocol_id"], {"systolic": 128, "diastolic": 82}, key="k-2")
        r = submit(client, protocol["protocol_id"], {"systolic": 140, "diastolic": 90}, key="k-2")
        assert r.status_code == 409 and r.json()["error"] == "idempotency_conflict"
        assert len(client.get("/events").json()) == 1

    def test_concurrent_duplicates_count_once(self, client: TestClient, protocol: dict) -> None:
        results: list[int] = []
        barrier = threading.Barrier(32)

        def worker() -> None:
            barrier.wait()
            r = submit(client, protocol["protocol_id"], {"systolic": 128, "diastolic": 82}, key="race")
            results.append(r.status_code)

        threads = [threading.Thread(target=worker) for _ in range(32)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert sorted(results) == [201] + [409] * 31
        assert len(client.get("/events").json()) == 1

    def test_inactive_protocol_409(self, client: TestClient, protocol: dict) -> None:
        client.post(f"/protocols/{protocol['protocol_id']}/deactivate")
        r = submit(client, protocol["protocol_id"], {"systolic": 128, "diastolic": 82})
        assert r.status_code == 409 and r.json()["error"] == "protocol_inactive"

    def test_unknown_protocol_404(self, client: TestClient) -> None:
        r = submit(client, "does-not-exist", {"systolic": 128, "diastolic": 82})
        assert r.status_code == 404 and r.json()["error"] == "protocol_not_found"

    def test_rules_change_takes_effect_immediately(self, client: TestClient, protocol: dict) -> None:
        rules = blood_pressure_preset().model_dump()
        rules["metrics"][0]["hard_max"] = 200
        rules["metrics"][0]["max"] = 150
        newer = client.post("/protocols", json=bp_protocol_body(validation_rules=rules)).json()
        r = submit(client, newer["protocol_id"], {"systolic": 220, "diastolic": 80})
        assert r.status_code == 422

    def test_gateway_token_enforced_when_configured(self, tmp_path) -> None:
        with make_client(tmp_path, gateway_token="s3cret") as c:
            pid = c.post("/protocols", json=bp_protocol_body()).json()["protocol_id"]
            body = {"protocol_id": pid, "patient_id": "p", "session_id": "s",
                    "idempotency_key": "k", "readings": {"systolic": 120, "diastolic": 80}}
            assert c.post("/ingest_vitals", json=body).status_code == 401
            ok = c.post("/ingest_vitals", json=body, headers={"X-Gateway-Token": "s3cret"})
            assert ok.status_code == 201

    def test_metrics_report_validation_latency(self, client: TestClient, protocol: dict) -> None:
        for _ in range(5):
            submit(client, protocol["protocol_id"], {"systolic": 128, "diastolic": 82})
        m = client.get("/metrics/gateway").json()
        assert m["validation"]["count"] == 5
        assert 0 < m["validation"]["p50_us"] <= m["validation"]["p99_us"]
        assert m["events_stored"] == 5
