"""
One-time setup: authorize this app to upload to Google Drive on behalf of your
personal Google account (service accounts have no storage quota on personal
Gmail, so Drive uploads must be delegated via OAuth instead).

Run from the backend/ directory with the venv activated:
    python -m app.authorize_drive /path/to/client_secret_XXXX.json

This opens a browser for you to sign in and grant Drive access, then prints the
refresh token to paste into GOOGLE_OAUTH_REFRESH_TOKEN (.env locally, or the
Render environment variable in production). It also prints the minified client
JSON to paste into GOOGLE_OAUTH_CLIENT_JSON.
"""
from __future__ import annotations

import json
import sys

from google_auth_oauthlib.flow import InstalledAppFlow

from .google_clients import DRIVE_SCOPES


def main() -> None:
    if len(sys.argv) != 2:
        print("Usage: python -m app.authorize_drive /path/to/client_secret_XXXX.json")
        sys.exit(1)

    client_secret_path = sys.argv[1]

    flow = InstalledAppFlow.from_client_secrets_file(client_secret_path, scopes=DRIVE_SCOPES)
    credentials = flow.run_local_server(port=8765, access_type="offline", prompt="consent")

    if not credentials.refresh_token:
        print(
            "\nNo refresh token was returned. This usually means you've already "
            "authorized this app before and Google didn't re-issue one. Go to "
            "https://myaccount.google.com/permissions, remove access for this app, "
            "and run this script again.",
            file=sys.stderr,
        )
        sys.exit(1)

    with open(client_secret_path) as f:
        client_json = json.load(f)

    print("\nSuccess! Add these to your .env (or Render environment variables):\n")
    print(f"GOOGLE_OAUTH_REFRESH_TOKEN={credentials.refresh_token}")
    print(f"GOOGLE_OAUTH_CLIENT_JSON={json.dumps(client_json)}")


if __name__ == "__main__":
    main()
