"""ElevenLabs text-to-speech, streamed straight through to the phone."""

from __future__ import annotations

from collections.abc import AsyncIterator

import httpx

from .config import Settings

ELEVENLABS_URL = "https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream"
OUTPUT_FORMAT = "mp3_44100_64"


class VoiceError(Exception):
    pass


class ElevenLabsVoice:
    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._settings = settings
        self._transport = transport

    def _request_args(self, text: str) -> dict:
        s = self._settings
        return {
            "url": ELEVENLABS_URL.format(voice_id=s.elevenlabs_voice_id),
            "params": {"output_format": OUTPUT_FORMAT},
            "headers": {"xi-api-key": s.elevenlabs_api_key, "accept": "audio/mpeg"},
            "json": {"text": text, "model_id": s.elevenlabs_model_id},
        }

    def _client(self) -> httpx.AsyncClient:
        timeout = httpx.Timeout(20.0, connect=self._settings.voice_connect_timeout_s)
        return httpx.AsyncClient(timeout=timeout, transport=self._transport)

    async def open_stream(self, text: str) -> AsyncIterator[bytes]:
        """Start synthesis; raises VoiceError *before* any bytes are sent to the client."""
        client = self._client()
        try:
            request = client.build_request("POST", **self._request_args(text))
            response = await client.send(request, stream=True)
        except httpx.HTTPError as exc:
            await client.aclose()
            raise VoiceError(type(exc).__name__) from exc
        if response.status_code != 200:
            await response.aclose()
            await client.aclose()
            raise VoiceError(f"ElevenLabs HTTP {response.status_code}")

        async def chunks() -> AsyncIterator[bytes]:
            try:
                async for chunk in response.aiter_bytes():
                    yield chunk
            finally:
                await response.aclose()
                await client.aclose()

        return chunks()

    async def synthesize(self, text: str) -> bytes:
        stream = await self.open_stream(text)
        return b"".join([chunk async for chunk in stream])
