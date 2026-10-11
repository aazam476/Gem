"""Gem behaviour settings a researcher can change from the portal (persisted in SQLite).

- ``idle_after_s``: no movement, speech or scene change for this long -> the app stops
  sending frames (Gem "pauses").
- ``purge_after_s``: inactive this long -> the session and its context window are purged
  (the app ends it; the server's own idle purge uses the same value).
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..store import Store
from .sessions import SessionStore

SETTINGS_KEY = "assistant"


class AssistantSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    idle_after_s: int = Field(ge=15, le=3600, description="Pause frames after this much inactivity")
    purge_after_s: int = Field(ge=60, le=86_400, description="Purge Gem's context after this much inactivity")

    @model_validator(mode="after")
    def _ordered(self) -> AssistantSettings:
        if self.purge_after_s <= self.idle_after_s:
            raise ValueError("purge_after_s must be longer than idle_after_s")
        return self


class SettingsService:
    def __init__(self, store: Store, sessions: SessionStore, defaults: AssistantSettings) -> None:
        self._store = store
        self._sessions = sessions
        raw = store.get_setting(SETTINGS_KEY)
        self._current = AssistantSettings.model_validate(json.loads(raw)) if raw else defaults
        self._sessions.idle_timeout_s = float(self._current.purge_after_s)

    @property
    def current(self) -> AssistantSettings:
        return self._current

    def update(self, new: AssistantSettings) -> AssistantSettings:
        self._store.set_setting(SETTINGS_KEY, new.model_dump_json())
        self._current = new
        # The server-side backstop purge follows the same value.
        self._sessions.idle_timeout_s = float(new.purge_after_s)
        return new


def build_settings_router(service: SettingsService) -> APIRouter:
    router = APIRouter(prefix="/settings", tags=["settings"])

    @router.get("/assistant", response_model=AssistantSettings)
    def get_settings() -> Any:
        return service.current

    @router.put("/assistant", response_model=AssistantSettings)
    def put_settings(body: AssistantSettings) -> Any:
        return service.update(body)

    return router
