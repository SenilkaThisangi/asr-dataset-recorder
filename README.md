# ASR Recording Collector

A single-page web app for collecting audio recordings for an ASR training dataset.
Contributors pick their name, see their assigned utterances (pulled from a Google
Sheet), record audio in the browser, and the server converts it to mono FLAC and
uploads it to a per-user folder in Google Drive — updating the tracking sheet as it
goes.

## Stack

- **Backend:** Python + FastAPI, served by uvicorn. ffmpeg (via `subprocess`) does the
  audio conversion.
- **Frontend:** Vite + vanilla TypeScript + Tailwind CSS, built to static assets and
  served by FastAPI. One deployable service.
- **Storage:** Google Sheets (utterance tracking) via a service account; Google Drive
  (audio files) via OAuth-delegated user credentials — see the note in §1.5 on why
  Drive can't use the service account alone on a personal Gmail account.
- **Deploy target:** Render, as a persistent Docker web service (not serverless — so
  ffmpeg and larger uploads work reliably).

---

## 1. Google Cloud setup

### 1.1 Create a project and service account

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create (or
   select) a project.
2. Enable the required APIs: **APIs & Services → Library**, then enable:
   - **Google Sheets API**
   - **Google Drive API**
3. Create a service account: **APIs & Services → Credentials → Create Credentials →
   Service account**. Give it any name (e.g. `asr-recorder`); no special roles are
   needed at the project IAM level — access is granted per-resource in step 1.3.
4. Open the service account, go to the **Keys** tab → **Add Key → Create new key →
   JSON**. This downloads a `.json` key file — keep it secret, never commit it.

### 1.2 Note the service account's email

The key file contains a `client_email` field, e.g.
`asr-recorder@your-project.iam.gserviceaccount.com`. You'll share both the Sheet and
the Drive folder with this exact address.

### 1.3 Share the Sheet and the Drive folder

1. **Google Sheet:** open the sheet containing your utterances (columns:
   `utterance_id`, `user`, `utterance_text`, `status`, `drive_file_link`), click
   **Share**, and add the service account's email with **Editor** access.
2. **Google Drive folder:** create (or pick) a parent folder that will contain one
   subfolder per user. Share that folder with the service account's email, also as
   **Editor**.

### 1.4 Collect the two IDs you'll need

- **Sheet ID** — from the sheet's URL: `https://docs.google.com/spreadsheets/d/`**`SHEET_ID`**`/edit`
- **Drive parent folder ID** — from the folder's URL: `https://drive.google.com/drive/folders/`**`DRIVE_PARENT_FOLDER_ID`**

### 1.5 Drive uploads need OAuth delegation, not just the service account

**Service accounts have no storage quota of their own on a personal (non-Workspace)
Google account.** Uploading files via the service account alone fails with a
`storageQuotaExceeded` / 403 error, even though it has Editor access to the folder.
(This only works out of the box if the parent folder lives in a Google Workspace
**Shared Drive**, where storage is billed to the Shared Drive rather than the
uploading identity.)

The fix used here: Drive uploads authenticate as **you** (the Google account that
owns the parent folder) via a one-time OAuth authorization, while Sheets access stays
on the service account. To set this up:

1. **Configure the OAuth consent screen** (if not already done): Cloud Console →
   **APIs & Services → OAuth consent screen**.
   - User type: **External**
   - Fill in app name / support email / developer email
   - Under **Test users**, add the Gmail address that owns the Drive folder — while
     the app is unpublished ("Testing" status), only test users can complete the
     consent flow.
2. **Create an OAuth Client ID**: **APIs & Services → Credentials → Create
   Credentials → OAuth client ID**, application type **Desktop app**. Download the
   resulting `client_secret_XXXX.json`.
3. **Run the one-time authorization script** (opens a browser for you to sign in and
   grant Drive access):
   ```bash
   cd backend
   source .venv/Scripts/activate
   python -m app.authorize_drive /path/to/client_secret_XXXX.json
   ```
   This prints `GOOGLE_OAUTH_REFRESH_TOKEN` and `GOOGLE_OAUTH_CLIENT_JSON` — copy
   both into your `.env` (locally) and into Render's environment variables (in
   production). The refresh token doesn't expire under normal use, so this is a
   one-time step, not something you repeat per deploy.

---

## 2. Local development setup

### 2.1 Backend (Python, in a venv)

```bash
cd backend
python -m venv .venv

# Activate:
source .venv/Scripts/activate   # Windows (Git Bash)
# .venv\Scripts\Activate.ps1    # Windows (PowerShell)
# source .venv/bin/activate     # macOS/Linux

pip install -r requirements.txt
```

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

- `SHEET_ID` — from step 1.4
- `SHEET_TAB_NAME` — the tab/worksheet name containing the utterance rows (default `Sheet1`)
- `DRIVE_PARENT_FOLDER_ID` — from step 1.4
- `GOOGLE_SERVICE_ACCOUNT_JSON` — the **entire contents** of the downloaded service
  account JSON key file, minified to one line. You can do this with:
  ```bash
  python -c "import json; print(json.dumps(json.load(open('path/to/key.json'))))"
  ```
- `GOOGLE_OAUTH_CLIENT_JSON` and `GOOGLE_OAUTH_REFRESH_TOKEN` — from step 1.5's
  `python -m app.authorize_drive` output. Required for Drive uploads to work.
- If your sheet's column headers don't match `utterance_id` / `user` /
  `utterance_text` / `status` / `drive_file_link` exactly, override them with
  `COL_UTTERANCE_ID`, `COL_USER`, `COL_UTTERANCE_TEXT`, `COL_STATUS`,
  `COL_DRIVE_FILE_LINK` (see `.env.example`/`config.py` for details).

**Tip:** when pasting JSON blobs into `.env`, wrap the value in single quotes
(`KEY='{"a":1}'`) — some editors reformat/wrap long unquoted lines, which breaks
parsing.

You also need **ffmpeg** installed locally and on your `PATH` (the Docker image
installs it automatically for deployment; locally, install via your OS package
manager, e.g. `choco install ffmpeg`, `brew install ffmpeg`, `apt install ffmpeg`).

**(Optional, one-time) Pre-create user folders in Drive:**

```bash
python -m app.setup_folders
```

This reads all distinct values from the sheet's `user` column and creates any
missing subfolders under the parent Drive folder. The app also creates a user's
folder automatically on their first upload if you skip this step.

**Run the backend:**

```bash
uvicorn app.main:app --reload --port 8000
```

### 2.2 Frontend (Vite + TypeScript + Tailwind)

```bash
cd frontend
npm install
npm run dev
```

This starts the Vite dev server (default `http://localhost:5173`) and proxies
`/api/*` requests to the backend on port 8000 (see `vite.config.ts`).

For a production build (also what the Docker image runs):

```bash
npm run build
```

This outputs static assets to `frontend/dist/`, which get copied into the backend
image as `backend/static/` and served directly by FastAPI.

---

## 3. Deploying to Render

1. Push this repo to GitHub (or GitLab).
2. In the Render dashboard, **New → Web Service**, connect the repo. Render will
   detect the `Dockerfile` at the repo root (or use `render.yaml` if you enable
   Blueprint deploys) — no separate build/start commands needed since the Dockerfile
   handles both.
3. Choose a **persistent instance type** (e.g. Starter or higher) — not a serverless
   product — since this app needs ffmpeg available at all times and should handle
   larger file uploads without cold-start constraints.
4. Set the environment variables in the Render dashboard (**Environment** tab):
   - `SHEET_ID`
   - `SHEET_TAB_NAME`
   - `DRIVE_PARENT_FOLDER_ID`
   - `GOOGLE_SERVICE_ACCOUNT_JSON` — paste the minified JSON key as the value
     (Render env vars support multi-line/large string values fine).
   - `GOOGLE_OAUTH_CLIENT_JSON` and `GOOGLE_OAUTH_REFRESH_TOKEN` — from step 1.5.
     Run the authorization script locally (it needs a browser) and copy the printed
     values into Render; there's no way to run the interactive browser flow on
     Render itself.
   - Any `COL_*` overrides your sheet needs (see §2.1).
5. Deploy. Render builds the Docker image (frontend build stage, then Python stage
   with ffmpeg installed) and runs `uvicorn` on the assigned `$PORT`.

If you're using `render.yaml` for Blueprint-based deploys, the env var keys are
already declared there (`sync: false` means you'll be prompted to fill in the actual
secret values in the dashboard rather than committing them).

---

## 4. How it works

- **User picker:** `GET /api/users` returns distinct values from the sheet's `user`
  column. The frontend remembers the selected name in `localStorage` so returning
  visitors skip the picker.
- **Utterance list:** `GET /api/users/{user}/utterances` returns only that user's
  rows.
- **Recording:** the browser records via `MediaRecorder` in its native format (webm/
  opus in most browsers). On save, the raw blob is uploaded to
  `POST /api/utterances/{utterance_id}/recording?user={user}`.
- **Conversion:** the backend runs
  `ffmpeg -y -i input.webm -ac 1 -c:a flac output.flac` — downmixing to mono while
  deliberately **not** passing `-ar`, so the original sample rate is preserved.
- **Upload:** the FLAC file is uploaded to Drive as `{utterance_id}.flac` inside
  `ParentFolder/{user}/`. If a file with that name already exists (re-recording), its
  content is replaced in place rather than creating a duplicate.
- **Sheet update:** the row is re-located **by matching `utterance_id`** (not row
  position, so it's safe even if rows get reordered) and its `status` and
  `drive_file_link` cells are updated via a batch update.
- **Reliability:** all Sheets/Drive API calls retry with exponential backoff + jitter
  on HTTP 429 and 5xx responses (up to 6 attempts). If the Sheet update still fails
  after retries — even though the Drive upload succeeded — the API returns a clear
  503 error and the row is **not** marked as recorded, so nothing is silently lost.
  The frontend surfaces this error to the user so they know to retry.

## Project layout

```
backend/
  app/
    main.py           FastAPI app + routes
    config.py          Settings (env vars)
    google_clients.py  Auth + retry/backoff wrapper
    sheets_repo.py      Sheet read/write, matched by utterance_id
    drive_repo.py       Drive folder/file management
    audio_convert.py    ffmpeg subprocess wrapper
    setup_folders.py    One-off script to pre-create user folders
  requirements.txt
  .env.example
frontend/
  src/
    main.ts       App logic / DOM rendering
    api.ts         Backend API client
    recorder.ts    MediaRecorder wrapper
    style.css       Tailwind entry point
  package.json
  vite.config.ts
Dockerfile        Multi-stage: Node build -> Python + ffmpeg runtime
render.yaml       Render Blueprint config
```
