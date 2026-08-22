from __future__ import annotations

import logging
from dataclasses import dataclass

from .config import get_settings
from .google_clients import get_sheets_service, with_retry

logger = logging.getLogger("app.sheets_repo")


@dataclass
class Utterance:
    utterance_id: str
    user: str
    utterance_text: str
    status: str
    drive_file_link: str
    row_number: int  # 1-indexed sheet row, including header

    @property
    def is_recorded(self) -> bool:
        return self.status.strip().lower() == get_settings().status_recorded_value.lower()


class SheetSchemaError(Exception):
    pass


class UtteranceNotFoundError(Exception):
    pass


def _col_letter(index: int) -> str:
    """0-indexed column number -> spreadsheet column letter (A, B, ..., Z, AA, ...)."""
    letters = ""
    n = index + 1
    while n > 0:
        n, remainder = divmod(n - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters


def _read_all_rows() -> tuple[list[str], list[list[str]]]:
    settings = get_settings()
    service = get_sheets_service()
    range_name = f"{settings.sheet_tab_name}!A:Z"

    def call():
        return (
            service.spreadsheets()
            .values()
            .get(spreadsheetId=settings.sheet_id, range=range_name)
            .execute()
        )

    result = with_retry(call, description="sheets.values.get")
    values = result.get("values", [])
    if not values:
        raise SheetSchemaError("Sheet appears to be empty; expected a header row.")

    header = values[0]
    rows = values[1:]
    return header, rows


def _header_indices(header: list[str]) -> dict[str, int]:
    settings = get_settings()
    required = {
        settings.col_utterance_id: None,
        settings.col_user: None,
        settings.col_utterance_text: None,
        settings.col_status: None,
        settings.col_drive_file_link: None,
    }
    for idx, name in enumerate(header):
        if name in required:
            required[name] = idx

    missing = [name for name, idx in required.items() if idx is None]
    if missing:
        raise SheetSchemaError(f"Sheet header is missing required column(s): {missing}")

    return {name: idx for name, idx in required.items()}


def _row_to_utterance(row: list[str], indices: dict[str, int], row_number: int) -> Utterance:
    settings = get_settings()

    def cell(col_name: str) -> str:
        idx = indices[col_name]
        return row[idx] if idx < len(row) else ""

    return Utterance(
        utterance_id=cell(settings.col_utterance_id),
        user=cell(settings.col_user),
        utterance_text=cell(settings.col_utterance_text),
        status=cell(settings.col_status),
        drive_file_link=cell(settings.col_drive_file_link),
        row_number=row_number,
    )


def list_distinct_users() -> list[str]:
    header, rows = _read_all_rows()
    indices = _header_indices(header)
    settings = get_settings()
    user_idx = indices[settings.col_user]

    seen: dict[str, None] = {}
    for row in rows:
        if user_idx < len(row):
            name = row[user_idx].strip()
            if name:
                seen[name] = None
    return list(seen.keys())


def list_utterances_for_user(user: str) -> list[Utterance]:
    header, rows = _read_all_rows()
    indices = _header_indices(header)
    settings = get_settings()
    user_idx = indices[settings.col_user]

    result = []
    for offset, row in enumerate(rows):
        row_number = offset + 2  # +1 for 0-index -> 1-index, +1 for header row
        if user_idx < len(row) and row[user_idx].strip() == user:
            result.append(_row_to_utterance(row, indices, row_number))
    return result


def find_utterance(utterance_id: str) -> Utterance:
    """Find a single utterance row by matching on utterance_id, never on row position."""
    header, rows = _read_all_rows()
    indices = _header_indices(header)
    settings = get_settings()
    id_idx = indices[settings.col_utterance_id]

    for offset, row in enumerate(rows):
        if id_idx < len(row) and row[id_idx].strip() == utterance_id:
            row_number = offset + 2
            return _row_to_utterance(row, indices, row_number)

    raise UtteranceNotFoundError(f"No row found with utterance_id={utterance_id!r}")


def mark_recorded(utterance_id: str, drive_file_link: str) -> Utterance:
    """
    Re-locate the row by utterance_id (in case rows shifted since last read) and
    update its status + drive_file_link cells directly, via batchUpdate.
    """
    settings = get_settings()
    utterance = find_utterance(utterance_id)

    header, _ = _read_all_rows()
    indices = _header_indices(header)
    status_col = _col_letter(indices[settings.col_status])
    link_col = _col_letter(indices[settings.col_drive_file_link])
    row_number = utterance.row_number

    service = get_sheets_service()

    def call():
        body = {
            "valueInputOption": "RAW",
            "data": [
                {
                    "range": f"{settings.sheet_tab_name}!{status_col}{row_number}",
                    "values": [[settings.status_recorded_value]],
                },
                {
                    "range": f"{settings.sheet_tab_name}!{link_col}{row_number}",
                    "values": [[drive_file_link]],
                },
            ],
        }
        return (
            service.spreadsheets()
            .values()
            .batchUpdate(spreadsheetId=settings.sheet_id, body=body)
            .execute()
        )

    with_retry(call, description=f"sheets.values.batchUpdate(utterance_id={utterance_id})")

    utterance.status = settings.status_recorded_value
    utterance.drive_file_link = drive_file_link
    return utterance
