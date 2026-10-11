"""Researcher study documents (notes, images, PDFs) given to Gem as context."""

from __future__ import annotations

import asyncio
import base64
import io
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.assistant.brain import BrainReply, Prompt
from app.assistant.documents import GeminiFiles, StudyDocument
from app.assistant.sessions import SessionStore
from app.config import load_settings
from app.main import create_app

from .conftest import bp_protocol_body, jpeg_b64

PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def png_bytes(size=(64, 48)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, (10, 120, 200)).save(buf, format="PNG")
    return buf.getvalue()


class RecordingBrain:
    def __init__(self) -> None:
        self.prompts: list[Prompt] = []

    async def reply(self, prompt: Prompt) -> BrainReply:
        self.prompts.append(prompt)
        return BrainReply("q", True, "ok", ())


class FakeFiles(GeminiFiles):
    """Pretend Files API: records uploads, returns stable URIs."""

    def __init__(self, settings, store, fail: bool = False) -> None:
        super().__init__(settings, store, client=None)
        self.uploads: list[str] = []
        self.fail = fail

    async def ensure(self, doc: dict[str, Any], path: Path) -> str | None:
        if self._valid(doc):
            return doc["gemini_uri"]
        if self.fail:
            return None
        self.uploads.append(doc["doc_id"])
        uri = f"https://files.example/{doc['doc_id']}"
        expires = (datetime.now(UTC) + timedelta(hours=47)).isoformat()
        self._store.set_document_gemini_file(doc["doc_id"], f"files/{doc['doc_id']}", uri, expires)
        return uri


def make(tmp_path, *, brain=None, files_factory=None, **settings: Any) -> TestClient:
    s = load_settings(database_path=str(tmp_path / "d.db"), mock_ai=True, gemini_api_key="",
                      elevenlabs_api_key="", uploads_dir=str(tmp_path / "uploads"), **settings)
    app = create_app(s, brain=brain, session_store=SessionStore(idle_timeout_s=600, max_frames=50))
    if files_factory is not None:
        app.state.documents.files = files_factory(s, app.state.store)
    return TestClient(app)


def new_protocol(c: TestClient) -> str:
    return c.post("/protocols", json=bp_protocol_body()).json()["protocol_id"]


# -- CRUD -------------------------------------------------------------------------------


def test_notes_and_files_lifecycle(tmp_path) -> None:
    c = make(tmp_path)
    pid = new_protocol(c)
    note = c.post(f"/protocols/{pid}/documents/notes",
                  json={"title": "About the study", "text": "We measure morning BP with an Omron M7."})
    assert note.status_code == 201 and note.json()["kind"] == "note"
    pdf = c.post(f"/protocols/{pid}/documents/files",
                 json={"filename": "manual.pdf", "mime_type": "application/pdf", "data_base64": b64(PDF)})
    assert pdf.status_code == 201, pdf.text
    assert pdf.json()["kind"] == "pdf" and pdf.json()["title"] == "manual.pdf"
    img = c.post(f"/protocols/{pid}/documents/files",
                 json={"title": "The cuff", "filename": "cuff.png", "mime_type": "image/png", "data_base64": b64(png_bytes())})
    assert img.status_code == 201 and img.json()["mime_type"] == "image/png"

    listed = c.get(f"/protocols/{pid}/documents").json()
    assert [d["kind"] for d in listed] == ["note", "pdf", "image"]
    assert c.get(f"/protocols/{pid}/documents/{pdf.json()['doc_id']}/content").content == PDF
    assert "Omron" in c.get(f"/protocols/{pid}/documents/{note.json()['doc_id']}/content").text

    stored = list((tmp_path / "uploads" / pid).iterdir())
    assert len(stored) == 2
    assert c.delete(f"/protocols/{pid}/documents/{pdf.json()['doc_id']}").status_code == 204
    assert len(list((tmp_path / "uploads" / pid).iterdir())) == 1
    assert [d["kind"] for d in c.get(f"/protocols/{pid}/documents").json()] == ["note", "image"]


def test_large_images_are_downscaled(tmp_path) -> None:
    c = make(tmp_path)
    pid = new_protocol(c)
    big = base64.b64decode(jpeg_b64(size=(4000, 3000)))
    doc = c.post(f"/protocols/{pid}/documents/files",
                 json={"filename": "photo.jpg", "mime_type": "image/jpeg", "data_base64": b64(big)}).json()
    data = c.get(f"/protocols/{pid}/documents/{doc['doc_id']}/content").content
    with Image.open(io.BytesIO(data)) as im:
        assert max(im.size) == 2048


@pytest.mark.parametrize("body,fragment", [
    ({"filename": "x.pdf", "mime_type": "application/pdf", "data_base64": b64(b"not a pdf")}, "not a PDF"),
    ({"filename": "x.png", "mime_type": "image/png", "data_base64": b64(b"garbage")}, "could not read"),
    ({"filename": "x.docx", "mime_type": "application/msword", "data_base64": b64(b"x")}, "only PDF"),
    ({"filename": "x.pdf", "mime_type": "application/pdf", "data_base64": "!!!"}, "base64"),
])
def test_rejects_bad_files(tmp_path, body, fragment) -> None:
    c = make(tmp_path)
    pid = new_protocol(c)
    r = c.post(f"/protocols/{pid}/documents/files", json=body)
    assert r.status_code == 422 and r.json()["error"] == "bad_document" and fragment in r.json()["message"]


def test_limits(tmp_path) -> None:
    c = make(tmp_path, max_document_bytes=100, max_documents_per_protocol=2)
    pid = new_protocol(c)
    too_big = c.post(f"/protocols/{pid}/documents/files",
                     json={"filename": "m.pdf", "mime_type": "application/pdf", "data_base64": b64(PDF * 10)})
    assert too_big.status_code == 422
    for i in range(2):
        assert c.post(f"/protocols/{pid}/documents/notes", json={"title": f"n{i}", "text": "t"}).status_code == 201
    third = c.post(f"/protocols/{pid}/documents/notes", json={"title": "n3", "text": "t"})
    assert third.status_code == 422 and "at most 2" in third.json()["message"]


def test_unknown_protocol(tmp_path) -> None:
    c = make(tmp_path)
    assert c.get("/protocols/nope/documents").status_code == 404
    assert c.post("/protocols/nope/documents/notes", json={"title": "a", "text": "b"}).status_code == 404


# -- Gem reads them ------------------------------------------------------------------------


def test_gem_gets_the_active_protocols_documents(tmp_path) -> None:
    brain = RecordingBrain()
    c = make(tmp_path, brain=brain)
    pid = new_protocol(c)
    c.post(f"/protocols/{pid}/documents/notes", json={"title": "Device", "text": "Omron M7, cuff on left arm."})
    c.post(f"/protocols/{pid}/documents/files",
           json={"filename": "manual.pdf", "mime_type": "application/pdf", "data_base64": b64(PDF)})
    session = c.post("/sessions", json={}).json()
    assert session["study_documents"] == 2
    c.post(f"/sessions/{session['session_id']}/turns", json={"text": "Which arm?"})
    docs = brain.prompts[0].documents
    assert [d.kind for d in docs] == ["note", "pdf"]
    assert docs[0].text == "Omron M7, cuff on left arm."
    assert docs[1].data == PDF and docs[1].file_uri is None  # no Gemini key -> inline fallback


def test_documents_use_gemini_files_when_available_and_upload_once(tmp_path) -> None:
    brain = RecordingBrain()
    holder: dict[str, FakeFiles] = {}

    def factory(settings, store):
        holder["files"] = FakeFiles(settings, store)
        return holder["files"]

    c = make(tmp_path, brain=brain, files_factory=factory)
    pid = new_protocol(c)
    doc = c.post(f"/protocols/{pid}/documents/files",
                 json={"filename": "manual.pdf", "mime_type": "application/pdf", "data_base64": b64(PDF)}).json()
    assert holder["files"].uploads == [doc["doc_id"]]  # uploaded right away in the background
    assert c.get(f"/protocols/{pid}/documents").json()[0]["uploaded_to_gemini"] is True
    sid = c.post("/sessions", json={}).json()["session_id"]
    c.post(f"/sessions/{sid}/turns", json={"text": "one"})
    c.post(f"/sessions/{sid}/turns", json={"text": "two"})
    assert holder["files"].uploads == [doc["doc_id"]]  # reused, not re-uploaded
    assert brain.prompts[1].documents[0].file_uri == f"https://files.example/{doc['doc_id']}"


def test_sessions_without_an_active_protocol_get_no_documents(tmp_path) -> None:
    brain = RecordingBrain()
    c = make(tmp_path, brain=brain)
    pid = new_protocol(c)
    c.post(f"/protocols/{pid}/documents/notes", json={"title": "a", "text": "b"})
    c.post(f"/protocols/{pid}/deactivate")
    sid = c.post("/sessions", json={}).json()["session_id"]
    c.post(f"/sessions/{sid}/turns", json={"text": "hi"})
    assert brain.prompts[0].documents == []


def test_mock_brain_mentions_documents(tmp_path) -> None:
    c = make(tmp_path)
    pid = new_protocol(c)
    c.post(f"/protocols/{pid}/documents/notes", json={"title": "Omron M7 tips", "text": "Rest 5 minutes."})
    sid = c.post("/sessions", json={}).json()["session_id"]
    body = c.post(f"/sessions/{sid}/turns", json={"text": "What does the manual say?"}).json()
    assert "Omron M7 tips" in body["answer"]


# -- GeminiFiles against a fake SDK client ------------------------------------------------


class FakeSdkFiles:
    def __init__(self, states=("ACTIVE",), fail=False) -> None:
        self.states = list(states)
        self.fail = fail
        self.uploaded: list[str] = []
        self.deleted: list[str] = []

    def _file(self, name: str):
        state = self.states.pop(0) if self.states else "ACTIVE"
        return type("F", (), {"name": name, "uri": f"https://gen/{name}", "state": state,
                              "expiration_time": datetime.now(UTC) + timedelta(hours=48)})()

    async def upload(self, *, file, config):
        if self.fail:
            raise RuntimeError("quota")
        self.uploaded.append(file)
        return self._file("files/abc")

    async def get(self, *, name):
        return self._file(name)

    async def delete(self, *, name):
        self.deleted.append(name)


def gemini_files(tmp_path, sdk: FakeSdkFiles):
    from app.store import Store

    settings = load_settings(database_path=str(tmp_path / "g.db"), gemini_api_key="k", mock_ai=False,
                             uploads_dir=str(tmp_path / "up"))
    store = Store(settings.database_path)
    pid = store.create_protocol("t", "p", __import__("app.rules", fromlist=["x"]).blood_pressure_preset(), True).protocol_id
    client = type("C", (), {"aio": type("A", (), {"files": sdk})()})()
    files = GeminiFiles(settings, store, client=client)
    from app.assistant.documents import DocumentLibrary

    lib = DocumentLibrary(settings, store, files)
    doc = lib.add_file(pid, "manual", "application/pdf", b64(PDF))
    return files, lib, store, doc


def test_gemini_files_upload_waits_for_processing_and_caches(tmp_path, monkeypatch) -> None:
    real_sleep = asyncio.sleep
    monkeypatch.setattr(asyncio, "sleep", lambda s: real_sleep(0))
    sdk = FakeSdkFiles(states=("PROCESSING", "PROCESSING", "ACTIVE"))
    files, lib, store, doc = gemini_files(tmp_path, sdk)
    uri = asyncio.run(files.ensure(doc, lib.path(doc)))
    assert uri == "https://gen/files/abc" and len(sdk.uploaded) == 1
    again = asyncio.run(files.ensure(store.get_document(doc["doc_id"]), lib.path(doc)))
    assert again == uri and len(sdk.uploaded) == 1


def test_gemini_files_reupload_near_expiry(tmp_path) -> None:
    sdk = FakeSdkFiles()
    files, lib, store, doc = gemini_files(tmp_path, sdk)
    soon = (datetime.now(UTC) + timedelta(minutes=30)).isoformat()
    store.set_document_gemini_file(doc["doc_id"], "files/old", "https://gen/old", soon)
    asyncio.run(files.ensure(store.get_document(doc["doc_id"]), lib.path(doc)))
    assert len(sdk.uploaded) == 1


def test_gemini_files_failure_falls_back_to_inline(tmp_path) -> None:
    files, lib, store, doc = gemini_files(tmp_path, FakeSdkFiles(fail=True))
    docs = asyncio.run(lib.for_prompt(doc["protocol_id"]))
    assert docs[0].file_uri is None and docs[0].data == PDF


def test_deleting_a_document_deletes_the_gemini_file(tmp_path) -> None:
    sdk = FakeSdkFiles()
    files, lib, store, doc = gemini_files(tmp_path, sdk)
    asyncio.run(files.ensure(doc, lib.path(doc)))
    asyncio.run(lib.remove(store.get_document(doc["doc_id"])))
    assert sdk.deleted == ["files/abc"] and not lib.path(doc).exists()


def test_gemini_brain_puts_documents_first(tmp_path) -> None:
    from .test_assistant import FakeModels, gemini_brain, reply_json, sample_prompt

    models = FakeModels(text=reply_json())
    p = sample_prompt()
    p = Prompt(p.system_prompt, p.history, p.frames, p.audio, p.audio_mime, p.text, documents=[
        StudyDocument("d1", "note", "Device", "text/plain", text="Omron M7"),
        StudyDocument("d2", "pdf", "Manual", "application/pdf", file_uri="https://gen/files/m"),
        StudyDocument("d3", "image", "Cuff", "image/png", data=png_bytes()),
    ])
    asyncio.run(gemini_brain(models).reply(p))
    contents = models.kwargs["contents"]
    assert [c.role for c in contents][:4] == ["user", "model", "user", "model"]  # docs, ack, frames, ack
    parts = contents[0].parts
    assert any('<document title="Device">' in (x.text or "") for x in parts)
    assert any(x.file_data and x.file_data.file_uri == "https://gen/files/m" for x in parts)
    assert any(x.inline_data and x.inline_data.mime_type == "image/png" for x in parts)
    assert "research team's documents" in models.kwargs["config"].system_instruction
