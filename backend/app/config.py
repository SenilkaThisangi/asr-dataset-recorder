import json
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Google Sheets
    sheet_id: str
    sheet_tab_name: str = "Sheet1"

    # Google Drive
    drive_parent_folder_id: str

    # Service account credentials JSON, provided as a raw JSON string via env var.
    # Used for Sheets access.
    google_service_account_json: str

    # OAuth client (Desktop app) + refresh token for Drive access, since service
    # accounts have no storage quota of their own on personal (non-Workspace)
    # Google accounts. Generated once via `python -m app.authorize_drive`.
    google_oauth_client_json: str
    google_oauth_refresh_token: str

    # Column names in the sheet (in case the sheet header ever changes)
    col_utterance_id: str = "utterance_id"
    col_user: str = "user"
    col_utterance_text: str = "utterance_text"
    col_status: str = "status"
    col_drive_file_link: str = "drive_file_link"

    status_recorded_value: str = "recorded"

    # Uploads / conversion
    max_upload_bytes: int = 50 * 1024 * 1024  # 50 MB safety cap
    ffmpeg_binary: str = "ffmpeg"

    def service_account_info(self) -> dict:
        return json.loads(self.google_service_account_json)

    def oauth_client_info(self) -> dict:
        return json.loads(self.google_oauth_client_json)


@lru_cache
def get_settings() -> Settings:
    return Settings()
