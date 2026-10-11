"""Researcher study documents: notes, images and PDFs that Gem uses as context.

A researcher attaches them to a protocol in the portal (e.g. "This study collects home
blood pressure with an Omron M7; here is the manual and a photo of the cuff"). Every
question asked in a Gem session started under that protocol gets them, ahead of the
camera frames, so Gemini can answer from the manual and recognise the study's device.

Storage: notes in SQLite; images/PDFs on disk under ``uploads_dir`` (gitignored) with
metadata in SQLite. These are research materials, not patient data. For Gemini, files are
uploaded once to the Files API (they expire after ~48 h and are re-uploaded on demand);
if that fails the bytes are sent inline.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import io
import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, BackgroundTasks, Response
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field

from ..config import Settings
from ..store import Store, now_iso

log = logging.getLogger("gem.documents")

IMAGE_MIME = {"image/jpeg", "image/png", "image/webp"}
PDF_MIME = "application/pdf"
MAX_IMAGE_EDGE = 2048
MAX_NOTE_CHARS = 20_000
# Gemini Files API keeps files ~48 h; re-upload when less than this is left.
GEMINI_FILE_MIN_REMAINING = timedelta(hours=2)
# Inline fallback limit (Gemini caps whole inline requests at ~20 MB).
MAX_INLINE_BYTES = 12_000_000

DocKind = Literal["note", "image", "pdf"]


class DocumentError(ValueError):
    pass


@dataclass(frozen=True)
class StudyDocument:
    """A document as handed to the brain for one question."""

    doc_id: str
    kind: DocKind
    title: str
    mime_type: str
    text: str | None = None
    data: bytes | None = None           # inline fallback
    file_uri: str | None = None         # Gemini Files API


# -- validation -------------------------------------------------------------------------


def _decode(data_base64: str, limit: int) -> bytes:
    data = data_base64.strip()
    if data.startswith("data:"):
        _, _, data = data.partition(",")
    try:
        raw = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise DocumentError("data_base64 is not valid base64") from exc
    if not raw:
        raise DocumentError("file is empty")
    if len(raw) > limit:
        raise DocumentError(f"file is larger than {limit // 1_000_000} MB")
    return raw


def prepare_file(mime_type: str, data_base64: str, limit: int) -> tuple[DocKind, str, bytes]:
    """Validate an uploaded file. Returns (kind, stored mime type, bytes to store)."""
    raw = _decode(data_base64, limit)
    if mime_type == PDF_MIME:
        if not raw.startswith(b"%PDF-"):
            raise DocumentError("file is not a PDF")
        return "pdf", PDF_MIME, raw
    if mime_type in IMAGE_MIME:
        try:
            with Image.open(io.BytesIO(raw)) as img:
                img = ImageOps.exif_transpose(img)
                if max(img.size) <= MAX_IMAGE_EDGE and mime_type in {"image/jpeg", "image/png"}:
                    img.load()
                    return "image", mime_type, raw
                img = img.convert("RGB")
                img.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE), Image.Resampling.LANCZOS)
                buf = io.BytesIO()
                img.save(buf, format="JPEG", quality=88)
                return "image", "image/jpeg", buf.getvalue()
        except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
            raise DocumentError("could not read the image") from exc
    raise DocumentError("only PDF, JPEG, PNG and WebP files are supported")


# -- Gemini Files API cache -----------------------------------------------------------------


class GeminiFiles:
    """Uploads document files to Gemini once and reuses the URI until it nears expiry."""

    def __init__(self, settings: Settings, store: Store, client: Any | None = None) -> None:
        self._settings = settings
        self._store = store
        self._client = client
        self._locks: dict[str, asyncio.Lock] = {}

    def _get_client(self) -> Any | None:
        if self._client is None and self._settings.gemini_api_key and not self._settings.mock_ai:
            from google import genai

            self._client = genai.Client(api_key=self._settings.gemini_api_key)
        return self._client

    @staticmethod
    def _valid(doc: dict[str, Any]) -> bool:
        if not doc.get("gemini_uri") or not doc.get("gemini_expires_at"):
            return False
        expires = datetime.fromisoformat(doc["gemini_expires_at"])
        return expires - datetime.now(UTC) > GEMINI_FILE_MIN_REMAINING

    async def ensure(self, doc: dict[str, Any], path: Path) -> str | None:
        """Gemini file URI for a stored document, uploading it if needed. None if unavailable."""
        if self._valid(doc):
            return doc["gemini_uri"]
        client = self._get_client()
        if client is None:
            return None
        lock = self._locks.setdefault(doc["doc_id"], asyncio.Lock())
        async with lock:
            fresh = self._store.get_document(doc["doc_id"])
            if fresh is not None and self._valid(fresh):
                return fresh["gemini_uri"]
            from google.genai import types

            try:
                uploaded = await client.aio.files.upload(
                    file=str(path),
                    config=types.UploadFileConfig(mime_type=doc["mime_type"], display_name=doc["title"][:100]),
                )
                for _ in range(30):  # PDFs are processed briefly before they can be used
                    state = str(getattr(uploaded, "state", "") or "")
                    if "PROCESSING" not in state:
                        break
                    await asyncio.sleep(1)
                    uploaded = await client.aio.files.get(name=uploaded.name)
                if "FAILED" in str(getattr(uploaded, "state", "") or ""):
                    raise RuntimeError("Gemini could not process the file")
            except Exception as exc:  # network, quota, unsupported file...
                log.warning("Gemini upload failed for %s: %s", doc["doc_id"], exc)
                return None
            expires = getattr(uploaded, "expiration_time", None) or (datetime.now(UTC) + timedelta(hours=47))
            if expires.tzinfo is None:
                expires = expires.replace(tzinfo=UTC)
            self._store.set_document_gemini_file(doc["doc_id"], uploaded.name, uploaded.uri, expires.isoformat())
            log.info("uploaded study document %s to Gemini (%s)", doc["doc_id"], uploaded.name)
            return uploaded.uri

    async def delete(self, doc: dict[str, Any]) -> None:
        client = self._get_client()
        if client is None or not doc.get("gemini_name"):
            return
        try:
            await client.aio.files.delete(name=doc["gemini_name"])
        except Exception as exc:
            log.info("could not delete Gemini file %s: %s", doc["gemini_name"], exc)


class DocumentLibrary:
    """Storage + retrieval of study documents for prompts."""

    def __init__(self, settings: Settings, store: Store, files: GeminiFiles) -> None:
        self.settings = settings
        self.store = store
        self.files = files
        self.root = Path(settings.uploads_dir)

    def path(self, doc: dict[str, Any]) -> Path:
        return self.root / doc["path"]

    def check_room(self, protocol_id: str, extra_bytes: int) -> None:
        docs = self.store.list_documents(protocol_id)
        if len(docs) >= self.settings.max_documents_per_protocol:
            raise DocumentError(f"at most {self.settings.max_documents_per_protocol} documents per protocol")
        if sum(d["size_bytes"] for d in docs) + extra_bytes > self.settings.max_document_total_bytes:
            raise DocumentError(f"documents for one protocol may total at most {self.settings.max_document_total_bytes // 1_000_000} MB")

    def add_note(self, protocol_id: str, title: str, text: str) -> dict[str, Any]:
        data = text.encode()
        self.check_room(protocol_id, len(data))
        return self.store.add_document({
            "doc_id": str(uuid.uuid4()), "protocol_id": protocol_id, "kind": "note", "title": title,
            "mime_type": "text/plain", "size_bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
            "text": text, "path": None, "created_at": now_iso(),
        })

    def add_file(self, protocol_id: str, title: str, mime_type: str, data_base64: str) -> dict[str, Any]:
        kind, mime, data = prepare_file(mime_type, data_base64, self.settings.max_document_bytes)
        self.check_room(protocol_id, len(data))
        doc_id = str(uuid.uuid4())
        ext = {"application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png"}.get(mime, ".bin")
        rel = f"{protocol_id}/{doc_id}{ext}"
        target = self.root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return self.store.add_document({
            "doc_id": doc_id, "protocol_id": protocol_id, "kind": kind, "title": title,
            "mime_type": mime, "size_bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
            "text": None, "path": rel, "created_at": now_iso(),
        })

    async def remove(self, doc: dict[str, Any]) -> None:
        self.store.delete_document(doc["doc_id"])
        if doc.get("path"):
            self.path(doc).unlink(missing_ok=True)
        await self.files.delete(doc)

    async def for_prompt(self, protocol_id: str | None) -> list[StudyDocument]:
        """Everything Gem should read for a question in a session under ``protocol_id``."""
        if not protocol_id:
            return []
        out: list[StudyDocument] = []
        for doc in self.store.list_documents(protocol_id):
            if doc["kind"] == "note":
                out.append(StudyDocument(doc["doc_id"], "note", doc["title"], "text/plain", text=doc["text"]))
                continue
            path = self.path(doc)
            if not path.exists():
                log.warning("study document %s is missing on disk", doc["doc_id"])
                continue
            uri = await self.files.ensure(doc, path)
            if uri:
                out.append(StudyDocument(doc["doc_id"], doc["kind"], doc["title"], doc["mime_type"], file_uri=uri))
            elif doc["size_bytes"] <= MAX_INLINE_BYTES:
                out.append(StudyDocument(doc["doc_id"], doc["kind"], doc["title"], doc["mime_type"],
                                         data=path.read_bytes()))
            else:
                log.warning("study document %s too large to send inline; skipped", doc["doc_id"])
        return out


# -- HTTP -----------------------------------------------------------------------------------


class NoteIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=120)
    text: str = Field(min_length=1, max_length=MAX_NOTE_CHARS)


class FileIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(default="", max_length=120)
    filename: str = Field(min_length=1, max_length=255)
    mime_type: str = Field(min_length=1, max_length=100)
    data_base64: str = Field(min_length=1, max_length=28_000_000)


class DocumentOut(BaseModel):
    doc_id: str
    protocol_id: str
    kind: DocKind
    title: str
    mime_type: str
    size_bytes: int
    created_at: str
    text: str | None = Field(default=None, description="Notes only")
    uploaded_to_gemini: bool


def document_out(doc: dict[str, Any]) -> DocumentOut:
    return DocumentOut(
        doc_id=doc["doc_id"], protocol_id=doc["protocol_id"], kind=doc["kind"], title=doc["title"],
        mime_type=doc["mime_type"], size_bytes=doc["size_bytes"], created_at=doc["created_at"],
        text=doc["text"], uploaded_to_gemini=bool(doc.get("gemini_uri")),
    )


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content=jsonable_encoder({"error": code, "message": message}))


def build_documents_router(store: Store, library: DocumentLibrary) -> APIRouter:
    router = APIRouter(prefix="/protocols/{protocol_id}/documents", tags=["documents"])

    def missing(protocol_id: str) -> JSONResponse | None:
        if store.get_protocol(protocol_id) is None:
            return _error(404, "protocol_not_found", f"No protocol {protocol_id}.")
        return None

    @router.get("", response_model=list[DocumentOut])
    def list_documents(protocol_id: str) -> Any:
        return missing(protocol_id) or [document_out(d) for d in store.list_documents(protocol_id)]

    @router.post("/notes", status_code=201, response_model=DocumentOut)
    def add_note(protocol_id: str, body: NoteIn) -> Any:
        if (err := missing(protocol_id)) is not None:
            return err
        try:
            return document_out(library.add_note(protocol_id, body.title.strip(), body.text.strip()))
        except DocumentError as exc:
            return _error(422, "bad_document", str(exc))

    @router.post("/files", status_code=201, response_model=DocumentOut)
    def add_file(protocol_id: str, body: FileIn, background: BackgroundTasks) -> Any:
        if (err := missing(protocol_id)) is not None:
            return err
        title = body.title.strip() or body.filename
        try:
            doc = library.add_file(protocol_id, title, body.mime_type.lower(), body.data_base64)
        except DocumentError as exc:
            return _error(422, "bad_document", str(exc))
        # Upload to Gemini now so the patient's first question isn't slowed down by it.
        background.add_task(library.files.ensure, doc, library.path(doc))
        return document_out(doc)

    @router.get("/{doc_id}/content")
    def content(protocol_id: str, doc_id: str) -> Any:
        doc = store.get_document(doc_id)
        if doc is None or doc["protocol_id"] != protocol_id:
            return _error(404, "document_not_found", f"No document {doc_id}.")
        if doc["kind"] == "note":
            return Response(doc["text"] or "", media_type="text/plain; charset=utf-8")
        path = library.path(doc)
        if not path.exists():
            return _error(404, "document_not_found", "File is missing.")
        return Response(path.read_bytes(), media_type=doc["mime_type"])

    @router.delete("/{doc_id}", status_code=204)
    async def delete(protocol_id: str, doc_id: str) -> Response:
        doc = store.get_document(doc_id)
        if doc is None or doc["protocol_id"] != protocol_id:
            return _error(404, "document_not_found", f"No document {doc_id}.")
        await library.remove(doc)
        return Response(status_code=204)

    return router
