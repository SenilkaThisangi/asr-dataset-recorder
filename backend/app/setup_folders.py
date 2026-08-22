"""
One-off setup script: ensures every distinct user in the Sheet's "user" column
has a corresponding subfolder under the parent Drive folder.

Run from the backend/ directory with the venv activated and env vars set:
    python -m app.setup_folders
"""
from __future__ import annotations

import logging

from . import drive_repo, sheets_repo

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("app.setup_folders")


def main() -> None:
    users = sheets_repo.list_distinct_users()
    logger.info("Found %d distinct user(s) in the sheet: %s", len(users), users)

    for user in users:
        existing = drive_repo.find_user_subfolder_id(user)
        if existing:
            logger.info("Folder already exists for %r (id=%s)", user, existing)
        else:
            folder_id = drive_repo.create_user_subfolder(user)
            logger.info("Created folder for %r (id=%s)", user, folder_id)

    logger.info("Done.")


if __name__ == "__main__":
    main()
