from __future__ import annotations

import logging
import random
import time
from functools import lru_cache
from typing import Any, Callable, TypeVar

from google.oauth2 import service_account
from google.oauth2.credentials import Credentials as UserCredentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from .config import get_settings

logger = logging.getLogger("app.google_clients")

SHEETS_SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive"]

T = TypeVar("T")

RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504}
MAX_RETRIES = 6
BASE_DELAY_SECONDS = 1.0


class GoogleApiRetryExhausted(Exception):
    """Raised when a Google API call fails after all retry attempts."""


def with_retry(func: Callable[[], T], *, description: str) -> T:
    """Call `func`, retrying on 429 / 5xx with exponential backoff + jitter."""
    last_exc: Exception | None = None
    for attempt in range(MAX_RETRIES):
        try:
            return func()
        except HttpError as exc:
            status = getattr(exc.resp, "status", None)
            last_exc = exc
            if status not in RETRYABLE_STATUS_CODES:
                raise
            delay = BASE_DELAY_SECONDS * (2**attempt) + random.uniform(0, 0.5)
            logger.warning(
                "Google API call '%s' failed with status %s (attempt %d/%d); retrying in %.1fs",
                description,
                status,
                attempt + 1,
                MAX_RETRIES,
                delay,
            )
            time.sleep(delay)
        except Exception as exc:  # transient network errors etc.
            last_exc = exc
            delay = BASE_DELAY_SECONDS * (2**attempt) + random.uniform(0, 0.5)
            logger.warning(
                "Google API call '%s' failed with error %r (attempt %d/%d); retrying in %.1fs",
                description,
                exc,
                attempt + 1,
                MAX_RETRIES,
                delay,
            )
            time.sleep(delay)

    logger.error("Google API call '%s' exhausted all retries", description)
    raise GoogleApiRetryExhausted(f"{description} failed after {MAX_RETRIES} attempts") from last_exc


@lru_cache
def get_service_account_credentials() -> service_account.Credentials:
    settings = get_settings()
    return service_account.Credentials.from_service_account_info(
        settings.service_account_info(), scopes=SHEETS_SCOPES
    )


@lru_cache
def get_drive_user_credentials() -> UserCredentials:
    """
    Drive uploads use OAuth-delegated user credentials (not the service account),
    since service accounts have no storage quota on personal Google accounts.
    Generated once via `python -m app.authorize_drive`.
    """
    settings = get_settings()
    client_info = settings.oauth_client_info()
    client_config = client_info.get("installed") or client_info.get("web")
    return UserCredentials(
        token=None,
        refresh_token=settings.google_oauth_refresh_token,
        token_uri=client_config["token_uri"],
        client_id=client_config["client_id"],
        client_secret=client_config["client_secret"],
        scopes=DRIVE_SCOPES,
    )


@lru_cache
def get_sheets_service() -> Any:
    return build("sheets", "v4", credentials=get_service_account_credentials(), cache_discovery=False)


@lru_cache
def get_drive_service() -> Any:
    return build("drive", "v3", credentials=get_drive_user_credentials(), cache_discovery=False)
