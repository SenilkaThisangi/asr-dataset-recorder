from __future__ import annotations

import logging

from googleapiclient.http import MediaFileUpload

from .config import get_settings
from .google_clients import get_drive_service, with_retry

logger = logging.getLogger("app.drive_repo")

FOLDER_MIME_TYPE = "application/vnd.google-apps.folder"


def _escape_for_query(value: str) -> str:
    return value.replace("\\", "\\\\").replace("'", "\\'")


def find_user_subfolder_id(user: str) -> str | None:
    settings = get_settings()
    service = get_drive_service()
    safe_user = _escape_for_query(user)
    query = (
        f"'{settings.drive_parent_folder_id}' in parents "
        f"and mimeType = '{FOLDER_MIME_TYPE}' "
        f"and name = '{safe_user}' "
        "and trashed = false"
    )

    def call():
        return (
            service.files()
            .list(q=query, fields="files(id, name)", spaces="drive")
            .execute()
        )

    result = with_retry(call, description=f"drive.files.list(find folder for {user})")
    files = result.get("files", [])
    return files[0]["id"] if files else None


def create_user_subfolder(user: str) -> str:
    settings = get_settings()
    service = get_drive_service()

    def call():
        metadata = {
            "name": user,
            "mimeType": FOLDER_MIME_TYPE,
            "parents": [settings.drive_parent_folder_id],
        }
        return service.files().create(body=metadata, fields="id").execute()

    result = with_retry(call, description=f"drive.files.create(folder for {user})")
    return result["id"]


def get_or_create_user_subfolder(user: str) -> str:
    folder_id = find_user_subfolder_id(user)
    if folder_id:
        return folder_id
    logger.info("Creating Drive subfolder for user %r", user)
    return create_user_subfolder(user)


def find_existing_file_id(folder_id: str, filename: str) -> str | None:
    service = get_drive_service()
    safe_name = _escape_for_query(filename)
    query = f"'{folder_id}' in parents and name = '{safe_name}' and trashed = false"

    def call():
        return (
            service.files()
            .list(q=query, fields="files(id, name)", spaces="drive")
            .execute()
        )

    result = with_retry(call, description=f"drive.files.list(find file {filename})")
    files = result.get("files", [])
    return files[0]["id"] if files else None


def upload_or_replace_flac(user: str, utterance_id: str, local_path: str) -> tuple[str, str]:
    """
    Upload local_path as {utterance_id}.flac into the user's Drive subfolder.
    If a file with that name already exists (re-recording), overwrite its content
    in place (same file id) rather than creating a duplicate.
    Returns (file_id, shareable_link).
    """
    service = get_drive_service()
    folder_id = get_or_create_user_subfolder(user)
    filename = f"{utterance_id}.flac"

    existing_file_id = find_existing_file_id(folder_id, filename)

    media = MediaFileUpload(local_path, mimetype="audio/flac", resumable=False)
    try:
        if existing_file_id:
            def call():
                return (
                    service.files()
                    .update(fileId=existing_file_id, media_body=media, fields="id, webViewLink")
                    .execute()
                )

            result = with_retry(call, description=f"drive.files.update({filename})")
            file_id = existing_file_id
        else:
            def call():
                metadata = {"name": filename, "parents": [folder_id]}
                return (
                    service.files()
                    .create(body=metadata, media_body=media, fields="id, webViewLink")
                    .execute()
                )

            result = with_retry(call, description=f"drive.files.create({filename})")
            file_id = result["id"]
    finally:
        # MediaFileUpload keeps its own file handle open (it may need to re-read
        # on retry); close it explicitly so Windows can delete the temp dir after.
        media._fd.close()

    _ensure_anyone_with_link_can_view(file_id)
    link = result.get("webViewLink") or f"https://drive.google.com/file/d/{file_id}/view"
    return file_id, link


def _ensure_anyone_with_link_can_view(file_id: str) -> None:
    service = get_drive_service()

    def call():
        permission = {"type": "anyone", "role": "reader"}
        return (
            service.permissions()
            .create(fileId=file_id, body=permission, fields="id")
            .execute()
        )

    with_retry(call, description=f"drive.permissions.create({file_id})")
