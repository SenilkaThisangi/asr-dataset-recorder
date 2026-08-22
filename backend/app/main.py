from __future__ import annotations

import logging
import tempfile
import uuid
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import drive_repo, sheets_repo
from .audio_convert import AudioConversionError, convert_to_mono_flac
from .config import get_settings
from .google_clients import GoogleApiRetryExhausted
from .sheets_repo import SheetSchemaError, UtteranceNotFoundError

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("app.main")

app = FastAPI(title="ASR Recording Collector")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class UtteranceOut(BaseModel):
    utterance_id: str
    user: str
    utterance_text: str
    status: str
    drive_file_link: str
    is_recorded: bool


def _to_out(u: sheets_repo.Utterance) -> UtteranceOut:
    return UtteranceOut(
        utterance_id=u.utterance_id,
        user=u.user,
        utterance_text=u.utterance_text,
        status=u.status,
        drive_file_link=u.drive_file_link,
        is_recorded=u.is_recorded,
    )


@app.get("/api/users")
def get_users() -> list[str]:
    try:
        return sheets_repo.list_distinct_users()
    except SheetSchemaError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except GoogleApiRetryExhausted as exc:
        raise HTTPException(status_code=503, detail=f"Google Sheets unavailable: {exc}") from exc


@app.get("/api/users/{user}/utterances")
def get_utterances_for_user(user: str) -> list[UtteranceOut]:
    try:
        utterances = sheets_repo.list_utterances_for_user(user)
    except SheetSchemaError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except GoogleApiRetryExhausted as exc:
        raise HTTPException(status_code=503, detail=f"Google Sheets unavailable: {exc}") from exc

    if not utterances:
        raise HTTPException(status_code=404, detail=f"No utterances found for user '{user}'")

    return [_to_out(u) for u in utterances]


@app.post("/api/utterances/{utterance_id}/recording")
async def upload_recording(utterance_id: str, user: str, file: UploadFile = File(...)) -> UtteranceOut:
    settings = get_settings()

    try:
        utterance = sheets_repo.find_utterance(utterance_id)
    except UtteranceNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except GoogleApiRetryExhausted as exc:
        raise HTTPException(status_code=503, detail=f"Google Sheets unavailable: {exc}") from exc

    if utterance.user != user:
        raise HTTPException(
            status_code=403,
            detail=f"Utterance '{utterance_id}' does not belong to user '{user}'",
        )

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_path = Path(tmpdir)
        input_suffix = Path(file.filename or "recording.webm").suffix or ".webm"
        input_path = tmp_path / f"input{input_suffix}"
        output_path = tmp_path / f"{uuid.uuid4().hex}.flac"

        size = 0
        with open(input_path, "wb") as f:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > settings.max_upload_bytes:
                    raise HTTPException(status_code=413, detail="Upload too large")
                f.write(chunk)

        if size == 0:
            raise HTTPException(status_code=400, detail="Uploaded file is empty")

        try:
            convert_to_mono_flac(str(input_path), str(output_path))
        except AudioConversionError as exc:
            logger.exception("Audio conversion failed for utterance %s", utterance_id)
            raise HTTPException(status_code=500, detail=f"Audio conversion failed: {exc}") from exc

        try:
            _file_id, link = drive_repo.upload_or_replace_flac(user, utterance_id, str(output_path))
        except GoogleApiRetryExhausted as exc:
            logger.exception("Drive upload failed for utterance %s", utterance_id)
            raise HTTPException(
                status_code=503,
                detail="Failed to upload recording to Google Drive after several retries. "
                "Nothing was saved — please try again.",
            ) from exc

    try:
        updated = sheets_repo.mark_recorded(utterance_id, link)
    except GoogleApiRetryExhausted as exc:
        logger.exception("Sheet update failed for utterance %s after Drive upload succeeded", utterance_id)
        raise HTTPException(
            status_code=503,
            detail=(
                "Recording was uploaded to Drive, but updating the tracking sheet failed "
                "after several retries. Please retry so the sheet reflects the correct status."
            ),
        ) from exc

    return _to_out(updated)


# --- Static frontend (built by Vite into ../frontend/dist, copied into the image) ---
FRONTEND_DIST = Path(__file__).resolve().parent.parent / "static"
if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}")
    def spa_catch_all(full_path: str):
        candidate = FRONTEND_DIST / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIST / "index.html")
