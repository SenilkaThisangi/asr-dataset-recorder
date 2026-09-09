# Configurable I/O + Auth + Deploy — Implementation Plan

Status: draft, for review before implementation.
Scope: this phase covers **configurable input/output, full contributor/admin
authentication, admin management UIs, admin-facing operations (error
visibility + dataset export), and deploy**. Multi-tenancy and non-Drive
storage remain out of scope (see §7).

> Note: an earlier draft of this plan deferred authentication to a later
> phase and used a single `ADMIN_PASSWORD` gate plus a separate
> `admin_users` table. That is superseded. Auth is now in scope and is built
> on a single `users` table (speaker + access_code + is_admin), per the
> planning decisions below.

---

## 1. Decisions locked in (from planning discussion)

- **One dataset per deployment for now.** Config is a single editable
  `settings` row, not a multi-tenant `projects` table — but the schema is
  written so a `project_id` could be added later without a rewrite.
- **Utterances always come from a Google Sheet.** Sheet ID, tab name, and
  column-name overrides become editable settings instead of env-only.
- **Audio capture:** browser requests the configured sample rate/channels via
  `getUserMedia` constraints (best effort — not all browsers/devices honor
  it), but **ffmpeg on the server is the source of truth** and always
  re-encodes to the exact configured output (format, sample rate, channels).
- **Audio output:** FLAC, **mono only** (channel toggle stored for future but
  UI stays mono). Sample rate is admin-selectable between **"preserve
  original"** (default) and **16000** (ASR standard). No downsampling unless
  the admin explicitly selects 16kHz.
- **Storage stays Google Drive**, but parent folder ID, per-user subfolder
  naming pattern, and filename pattern become settings instead of hardcoded.
  (S3/local storage explicitly out of scope for this phase.)
- **Database (Neon Postgres) stores only metadata** — settings, recording
  tracking records, and user accounts (contributors + admins). **Audio files
  are never stored in the DB**, only their Drive file ID/link.
- **Tracking:** every recording is always logged to the DB (`recordings`
  table) as the source of truth. Writing status back to the Google Sheet is
  an optional mirror (a setting toggle). This fixes the current fragility
  where a failed Sheet write after a successful Drive upload was the only
  failure mode that mattered.
- **Google Sheets writeback resilience:** retry with exponential backoff on
  429 (rate limit) and 5xx errors. Because the DB write is the source of
  truth and happens first, an exhausted-retry Sheet failure degrades the
  optional mirror only — it never loses the "recorded" status.
- **Authentication (in scope this phase):**
  - **Contributors log in** with their **speaker name + a unique access_code**,
    validated against the Neon `users` table. This replaces the old
    no-password name dropdown and protects the recording UI from anonymous
    submissions. (Speaker names are enforced unique when added.)
  - **Admins** are normal users with `is_admin = true` — they can record
    like anyone else, plus access the admin area.
  - Session persisted via signed cookie so users don't re-enter credentials
    each page load.
  - All admin routes are protected **server-side** (is_admin checked on every
    admin API call, not just hidden in the frontend).
- **Admin capabilities (in scope this phase):**
  - **Settings UI** — edit the settings row (sheet config, output
    format/rate, Drive config, Sheet-mirror toggle) via a real form.
  - **User management UI** — add/edit/remove users and their access codes,
    toggle is_admin, no redeploy needed. Cannot remove/demote the last
    remaining admin; cannot delete/demote your own account.
  - **Error visibility** — an admin view of failed uploads / failed Sheet
    mirror writes, so failures don't disappear silently.
  - **Dataset export** — admin can see overall progress and export a
    manifest (CSV) of recordings: utterance_id, user, Drive link, status,
    timestamp.
- **Contributor UX:** brief in-app recording instructions shown to
  contributors (the admin who deploys won't be present to explain it).
- **Stack additions:** SQLAlchemy + `psycopg` (sync), Alembic for migrations,
  Neon pooled connection string.
- **Deploy target:** Oracle Cloud Always Free Compute VM, running the
  existing Dockerfile via Docker Compose, with Caddy in front for automatic
  TLS. Render is dropped; `render.yaml` will be removed at the end. (Plan is
  portable to a friend's home server later — see §5/§8 — since the app is a
  standard Docker container.)

---

## 2. Data model (Neon Postgres)

```
settings                 (single row, id=1; shaped for future project_id)
  id                      int PK
  sheet_id                text
  sheet_tab_name          text
  col_utterance_id        text      -- MANDATORY (read)
  col_utterance_text      text      -- MANDATORY (read)
  col_speaker             text      -- MANDATORY (read) — unique key + display
  col_status              text      -- required only when mirror_to_sheet = true (written)
  col_drive_file_link     text      -- required only when mirror_to_sheet = true (written)
  status_recorded_value   text
  drive_parent_folder_id  text
  drive_subfolder_pattern text      -- e.g. "{speaker}"
  drive_filename_pattern  text      -- e.g. "{utterance_id}"
  output_format           text      -- "flac" (default) | "wav" | "mp3"
  output_sample_rate      text      -- "preserve" (default) | "16000"
  output_channels         text      -- "mono" (fixed for now, stored for future)
  mirror_to_sheet         bool      -- write status/link back to the Sheet too
  updated_at              timestamptz

users                     -- contributors AND admins (single table)
  id                      int PK
  speaker                 text unique   -- key + display; must match the Sheet speaker column; no duplicates allowed
  access_code             text unique   -- login credential (see security note)
  is_admin                bool default false
  created_at              timestamptz

recordings                -- always written, regardless of sheet mirroring
  id                      int PK
  utterance_id            text
  speaker                 text
  drive_file_id           text
  drive_file_link         text
  output_format           text      -- format actually used for this recording
  sample_rate             int       -- actual sample rate ffmpeg produced
  duration_seconds        numeric   nullable
  file_size_bytes         int
  recorded_at             timestamptz
  source                  text      -- "app" | "backfill" (distinguishes migrated rows)
  client_info             jsonb     nullable   -- browser/mime, for debugging

error_log                 -- admin-visible failures (uploads, sheet mirror, etc.)
  id                      int PK
  kind                    text      -- "drive_upload" | "sheet_mirror" | "convert" | ...
  utterance_id            text      nullable
  speaker                 text      nullable
  message                 text
  details                 jsonb     nullable
  occurred_at             timestamptz
  resolved                bool default false
```

Notes:
- **Login uses `speaker` + `access_code`.** The `speaker` value is the unique
  key and must exactly match the value in the Sheet's speaker column so
  utterance filtering works. Validate the speaker → Sheet mapping in the admin
  user-management UI.
- **Speaker names must be unique.** The `users.speaker` column is UNIQUE, and
  the admin user-management UI rejects adding a speaker whose name already
  exists. This is what makes it safe to use the single `speaker` field as the
  login/folder key — no two contributors can collide (they're further
  distinguished by their own access codes at login).
- **Access codes are auto-generated** by the user-management UI — short and
  human-friendly (e.g. a 6-character lowercase-alphanumeric code like
  `k7m2qx`), not long or complex, since these are shared with a trusted group
  and typed by hand. The app guarantees uniqueness. (Manual entry can be
  allowed as an override, but auto-generate is the default.)
- **Access code storage:** for this trusted-internal-contributor use case,
  storing access codes in plaintext in Neon is an accepted, documented
  tradeoff. If the app ever holds anything more sensitive, switch to hashed
  codes. This tradeoff is noted in the README, not left implicit.
- Google Sheets credentials (service account) and Drive OAuth
  (client+refresh token) **stay as env vars/secrets**, not DB rows — deploy-
  level secrets, not user-editable settings, never exposed through an admin
  form.

### 2.1 Mandatory vs optional sheet fields (applies to EVERY deployment)

The system defines a fixed set of **logical fields** it needs; each deployment
maps those logical fields to whatever its own Sheet columns are actually named
(via the `col_*` settings). The logical fields are fixed and required; the
real column names are configurable per deployment.

- **Always mandatory (the app reads these — can't function without them):**
  `utterance_id`, `utterance_text`, `speaker`.
- **Mandatory only when `mirror_to_sheet` is ON (the app writes these):**
  `status`, `drive_link`. When mirroring is off these columns are unused, so
  they are not required.

**Setup-time validation:** when an admin saves settings, the backend fetches
the target Sheet's header row and verifies every mandatory logical field is
mapped to a column that actually exists in the Sheet. If a mandatory mapping
points to a missing column (or a required column is blank), the save is
**rejected with a clear error** naming the offending field — so a bad mapping
can never silently break recording for contributors. If `mirror_to_sheet` is
on, `status` and `drive_link` are included in this validation.

### 2.2 How new deployments learn their column names

Auto-pickup from old env vars (§5) is a **one-time migration convenience for
the ORIGINAL deployment only** — it exists so the current sheet's `COL_*`
values aren't lost when switching off Render. It is NOT the general mechanism.

For **any fresh deployment** (including a friend's), there are no old env vars
to read. The general mechanism is: the seed migration writes sensible default
column names into the settings row, and the admin then **maps each logical
field to their own Sheet's actual column names in the admin settings UI**,
where the setup-time validation above confirms the mapping is correct before
it saves.

---

## 3. Backend changes

### 3.1 New dependencies
`sqlalchemy`, `psycopg[binary]`, `alembic`, plus `itsdangerous` (session
cookies), and `passlib`/`bcrypt` only if you opt into hashed access codes
(plaintext path needs none).

### 3.2 New modules
- `app/db.py` — engine/session setup from `DATABASE_URL` (Neon pooled URL).
- `app/models.py` — SQLAlchemy models: `Settings`, `User`, `Recording`,
  `ErrorLog`.
- `app/settings_repo.py` — replaces most hardcoded `config.py` values; loads
  the single settings row (cached, invalidated on admin save).
- `app/auth.py` — login route (speaker + access_code), session cookie,
  `require_user` and `require_admin` dependencies.
- `app/recordings_repo.py` — log every recording to the DB (source of truth).
- `app/errors_repo.py` — record failures to `error_log`; queried by the admin
  error view.
- `app/backfill.py` — one-time importer of pre-existing recordings into the
  `recordings` table (§3.6a); idempotent, no-op on fresh deployments.
- `alembic/` — migration scaffold; first migration creates the tables +
  seeds the default settings row from current env-var defaults.

### 3.3 `config.py` — split into two tiers
- **Deploy secrets** (stay as env vars, `Settings(BaseSettings)`):
  `DATABASE_URL`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_OAUTH_CLIENT_JSON`,
  `GOOGLE_OAUTH_REFRESH_TOKEN`, `SESSION_SECRET`, `max_upload_bytes`,
  `ffmpeg_binary`. (`ADMIN_PASSWORD` is **removed** — admins now live in the
  `users` table.)
- **Runtime-editable config** (DB-backed, via `settings_repo`): everything in
  the sheet / Drive-folder / column-name section of `config.py`, plus the new
  output-format fields.

### 3.4 `audio_convert.py` — parameterize the ffmpeg call
```python
def convert(input_path, output_path, *, format: str, sample_rate: str, channels: str):
    args = ["-ac", "1" if channels == "mono" else "2"]
    if sample_rate != "preserve":
        args += ["-ar", sample_rate]
    args += CODEC_ARGS[format]   # flac -> "-c:a flac"; wav -> "-c:a pcm_s16le"; mp3 -> "-c:a libmp3lame -b:a 192k"
    ...
```
Output file extension/content-type driven by `format`. Return the actual
sample rate produced (for the `recordings.sample_rate` field).

### 3.5 `drive_repo.py` — pattern-driven paths
`upload_recording` takes the settings' `drive_subfolder_pattern` /
`drive_filename_pattern` and `.format(speaker=..., utterance_id=...)`s them,
plus the correct extension/mimetype for the chosen output format. On first use
it auto-creates a speaker's subfolder if it doesn't exist. Upload failures are
written to `error_log`.

### 3.6 `sheets_repo.py` — column names from settings, mirroring optional + resilient
- Reads `col_*` names from the DB settings row instead of `config.py`.
- On settings save, validates mandatory logical fields against the Sheet's
  actual header row (see §2.1) — rejects the save with a clear error if a
  mandatory column is missing or unmapped.
- `mark_recorded` locates the row to update by **matching on the
  utterance_id column** (never by row position).
- Wrapped in retry-with-exponential-backoff on 429/5xx.
- The upload route calls `recordings_repo.log_recording(...)` **first**
  (source of truth), then, only if `settings.mirror_to_sheet`, mirrors to the
  Sheet. A mirror failure after exhausted retries is written to `error_log`
  and surfaced to the admin, but does not fail the recording.

### 3.6a `backfill.py` — one-time import of pre-existing recordings
A script (run inside the venv, once, per deployment that needs it) that scans
the existing Sheet + Drive folder and creates `recordings` rows for utterances
already recorded before the DB became the source of truth, so the admin
progress/export views reflect complete history rather than only new activity.
- Matches Sheet rows where the status column indicates "recorded" and/or a
  drive_link is present; resolves the corresponding Drive file.
- Writes each as a `recordings` row with `source = "backfill"` (so migrated
  rows are distinguishable from app-captured ones).
- Idempotent: safe to re-run — skips utterance_ids already present in
  `recordings`.
- For a fresh deployment with no prior recordings, backfill is simply a no-op.

### 3.7 Auth routes (`app/auth.py`)
- `GET/POST /login` — speaker + access_code form → validates against `users` →
  signed session cookie.
- `POST /logout` — clear session.
- `require_user` dependency — gates the recording UI/endpoints (no anonymous
  submissions).
- `require_admin` dependency — gates all admin routes.

### 3.8 Admin routes (`app/admin_routes.py`, all behind `require_admin`)
- `GET/POST /admin/settings` — view/edit the settings row; validate + save;
  bust the settings cache.
- `GET /admin/users`, `POST /admin/users`, `PATCH/DELETE /admin/users/{id}` —
  user management. New users get an **auto-generated short access_code**
  (unique, ~6 lowercase-alphanumeric chars); manual override allowed. Reject
  adding a speaker whose name already exists (names are unique). Enforce:
  cannot delete/demote the last admin; cannot delete/demote yourself.
- `GET /admin/errors` — list `error_log` entries; allow marking resolved.
- `GET /admin/export` — stream a CSV manifest of `recordings`
  (utterance_id, speaker, drive_link, format, sample_rate, recorded_at,
  source).
- `GET /admin/progress` — summary counts (recorded vs pending per speaker).

### 3.9 `main.py`
- Mount auth + admin routes.
- Recording UI/endpoints behind `require_user`.
- `upload_recording` route pulls `format`/`sample_rate`/`channels` from
  settings (not hardcoded), passes to `audio_convert.convert`, logs to
  `recordings`, optionally mirrors to Sheet, logs failures to `error_log`.
- CORS single-origin (same-origin deploy).

---

## 4. Frontend changes

- **Login page** — `login.html` + `login.ts`: speaker + access_code form,
  posts to `/login`. On success, redirect to the recorder. Shown to everyone
  before the recorder loads.
- **Recorder UI (`recorder.ts` / main page)** — unchanged core loop
  (view/record/re-record/next, per-speaker progress list, "all complete"
  state), now gated behind login and filtered to the logged-in speaker's rows
  (matched by speaker name, shown as a greeting). Adds brief **in-app
  instructions** for contributors (quiet room, consistent mic distance, how to
  re-record). `start()` accepts optional `sampleRate`/`channelCount`
  constraints passed to `getUserMedia` as a hint; falls back silently if
  ignored (server re-encodes regardless).
- **Admin settings page** — `admin.html` + `admin.ts` (Vite multi-page
  build): form bound to the settings API — sheet id/tab/columns (including the
  speaker column mapping), `<select>` for output format + sample rate, Drive
  folder/pattern fields, "mirror to sheet" checkbox, save button. Save is
  blocked with a clear message if mandatory column mappings fail validation
  (§2.1).
- **Admin users page** — table of users (speaker, access_code, is_admin) with
  add/edit/remove; access codes auto-generated on add; duplicate speaker names
  rejected; guardrails for last-admin/self.
- **Admin errors page** — table of `error_log` entries with a "mark
  resolved" action.
- **Admin export/progress** — progress summary + a "Download CSV" button
  hitting `/admin/export`.
- All admin screens reuse the existing minimal Tailwind styling — part of the
  same app, functional and clean rather than heavily polished.

---

## 5. Deployment changes

- Drop `render.yaml`.
- Add `docker-compose.yml`: existing app image + Caddy reverse proxy for TLS
  via Let's Encrypt, pointed at your domain.
- `.env.example` updated: remove per-column env vars (now DB-backed, seeded by
  the first migration), remove `ADMIN_PASSWORD`, add `DATABASE_URL`,
  `SESSION_SECRET`.
- README rewritten (see §8) — Neon setup, Oracle VM setup, Caddy TLS, first
  Alembic migration, seeding the first admin user.
- Seed migration reads existing `COL_*` overrides from the environment at
  migration time **if present** — this is a one-time convenience for the
  ORIGINAL deployment only, so its current sheet's column mapping isn't lost
  when switching off Render. Fresh deployments (§8) have no such env vars; they
  get default column names seeded and map their own columns in the admin UI
  (§2.2).
- **First admin bootstrap:** since there's no `ADMIN_PASSWORD` anymore, the
  migration (or a one-off `create_admin` script run inside the venv) inserts
  the initial admin user (speaker + auto-generated access_code +
  is_admin=true) so you can log in and manage everyone else from the UI.
- **Backfill (optional, per deployment):** after first migration, run
  `backfill.py` (§3.6a) once if there are pre-existing recordings to import
  into the `recordings` table; skip on a clean start.

---

## 6. Suggested implementation order

1. DB layer: models (`Settings`, `User`, `Recording`, `ErrorLog`), Alembic
   migration + seed (settings row + first admin user), `settings_repo.py`.
2. Auth: `/login`, session cookie, `require_user` / `require_admin`.
3. Refactor `audio_convert.py` + `drive_repo.py` + `sheets_repo.py` to read
   from settings; add utterance_id-match + retry/backoff to Sheet writeback;
   add setup-time column-mapping validation (§2.1).
4. `recordings` table + always-log-to-DB in the upload route; make Sheet
   mirroring conditional; wire `error_log` on failures.
5. Gate the recorder UI behind login; add contributor instructions.
6. Admin settings CRUD + page (with mandatory-field validation on save).
7. Admin user management CRUD + page (auto-generated codes; last-admin/self
   guardrails).
8. Admin error view + dataset export/progress.
9. Recorder mic-constraint hint (small; slot in anytime after step 1).
10. `backfill.py` — one-time import of pre-existing recordings (run per
    deployment as needed).
11. Docker Compose + Caddy + Oracle VM deploy; retire `render.yaml`.
12. README end-to-end (incl. handoff instructions for a second deployment).

---

## 7. Explicitly deferred (next phase)

- **Multi-tenancy** (`projects` table, dataset switcher) — settings row and
  models are shaped so `project_id` can be added later without a rewrite.
- **Non-Drive storage backends** (S3/R2/local).
- **Stereo output** (field stored, UI stays mono-only).
- **Hashed access codes / stronger auth** (OAuth, per-user passwords) — the
  `users` table can extend into this; plaintext codes are the accepted
  tradeoff for now.
- **Centralized cross-deployment admin control** — explicitly not possible
  with the independent-deployment model and intentionally not pursued.

---

## 8. Handoff to a second collector (separate deployment)

Because each collector runs an **independent copy** (own app instance, own
Neon DB, own Google service account + Drive + Sheet), enabling a friend to
run her own collection needs **no code changes beyond what's above** — it's a
documentation + isolation task:

- README includes a "Deploy your own instance" section: fork/clone, create
  your own Neon project, your own Google Cloud service account + Drive folder
  + Sheet, set your own env vars, run the migration (seeds your settings row +
  your first admin), deploy (Oracle VM or a friend's home server via the same
  Docker Compose), configure the rest in the admin settings UI.
- Confirm **nothing is hardcoded** to your dataset anywhere in code — all
  dataset-specific values live in env vars or the DB settings row (this is
  already the goal of the configurability work; the handoff is the test of
  it).
- Each deployment is fully isolated: no shared secrets, no shared database,
  no cross-deployment access. She owns and administers her instance entirely.

---

## Decisions resolved during review

- **Column migration for the original deployment:** the seed migration
  **auto-picks-up** the existing `COL_*` env values. Note the current sheet's
  headers contain typos (`utterence_id`, `utterence`) — config must match the
  actual Sheet headers exactly, so keep them as-is unless the Sheet columns
  themselves are also renamed. (General mechanism for new deployments is the
  admin column-mapping UI — §2.2.)
- **Backfill:** yes — import pre-existing recordings into the `recordings`
  table via `backfill.py` (§3.6a) so admin views show complete history.
- **Access codes:** auto-generated, kept **short and simple** (~6
  lowercase-alphanumeric chars), unique, typed by hand by a trusted group.

## Open questions before implementation starts

1. Drive subfolder/filename pattern — default is `{speaker}/{utterance_id}.{ext}`.
   Confirm this structure, or specify a different default. - this structure is ok go ahead

---

## 9. Task list (one atomic commit each)

Each item below is a single-responsibility commit. Ordering is deliberate:
foundation items (1–6) are pure additions nothing else imports yet; the I/O
refactors (12–14, 17) are kept behavior-neutral by having callers pass the
current hardcoded values / settings that match today's config, so every
commit leaves the app runnable; #11 (login required) and #18 (DB as source of
truth) are the two commits that intentionally change observable behavior.

> Convention: commit messages are imperative and scoped, e.g.
> `db: add SQLAlchemy models for settings/user/recording/errorlog`.

### Foundation

- [ ] **1. Add DB dependencies & connection layer.** Add `sqlalchemy`,
  `psycopg[binary]`, `alembic`, `itsdangerous` to `requirements.txt`; add
  `app/db.py` (engine/session from `DATABASE_URL`). No models, no usage yet.
- [ ] **2. Define SQLAlchemy models.** `app/models.py` — `Settings`, `User`,
  `Recording`, `ErrorLog` (schema per §2). Not wired anywhere yet.
- [ ] **3. Alembic scaffold + initial migration.** `alembic/`, `alembic.ini`,
  first migration creating all four tables. No seed logic yet.
- [ ] **4. Seed migration: default settings row + `COL_*` env pickup.**
  Inserts the `id=1` settings row, reading `COL_*` from env if present
  (original-deployment convenience, §5), else defaults (§2.2).
- [ ] **5. First-admin bootstrap script.** `app/create_admin.py` — one-off,
  inserts an admin user with an auto-generated access code. Standalone.
- [ ] **6. `settings_repo.py` — load/cache the settings row.** Read path only,
  with cache + `invalidate()`. Nothing consumes it yet.

### Auth

- [ ] **7. Access-code generator utility.** Unique ~6-char
  lowercase-alphanumeric generator with DB-uniqueness check. Used by #5 and #21.
- [ ] **8. `app/auth.py` — session + dependencies.** Signed-cookie session
  helpers, `require_user`, `require_admin`. No routes mounted yet.
- [ ] **9. Login/logout routes.** `GET/POST /login`, `POST /logout` against
  `users`; mounted in `main.py`. Frontend still the old one.
- [ ] **10. Login page (frontend).** `login.html` + `login.ts`, speaker +
  access_code form; Vite multi-page config.
- [ ] **11. Gate the recorder behind `require_user`.** Recording routes require
  login; frontend redirects to `/login` when unauthenticated; utterance list
  filtered to the logged-in speaker. Removes the anonymous name dropdown.
  *(Behavior change.)*

### I/O refactor

- [ ] **12. Parameterize `audio_convert.py`.** `convert(..., format,
  sample_rate, channels)` with `CODEC_ARGS` map; return actual sample rate.
  Callers pass today's values (mono/flac/preserve) — no behavior change.
- [ ] **13. Pattern-driven Drive paths in `drive_repo.py`.** `upload_recording`
  uses `drive_subfolder_pattern` / `drive_filename_pattern` + format-correct
  extension/mimetype, from settings.
- [ ] **14. `sheets_repo.py` reads column names from settings.** Swap
  `config.py` `col_*` for the settings row. Behavior identical when settings
  match current config.
- [ ] **15. Sheet writeback: utterance_id-match + retry/backoff.**
  `mark_recorded` locates the row by matching the utterance_id column; wrap in
  exponential-backoff retry on 429/5xx.
- [ ] **16. Setup-time column-mapping validation.** Backend helper: fetch Sheet
  header, verify mandatory logical fields map to real columns, raise a clear
  error (§2.1). Not wired to a route yet (used by #20).
- [ ] **17. `config.py` two-tier split.** Deploy secrets stay as
  `BaseSettings`; remove now-DB-backed fields; remove `ADMIN_PASSWORD`; add
  `SESSION_SECRET`.

### Tracking

- [ ] **18. `recordings_repo.py` + always-log-to-DB.** Upload route logs every
  recording to `recordings` first (source of truth); Sheet mirror becomes
  conditional on `settings.mirror_to_sheet`. *(Behavior change.)*
- [ ] **19. `errors_repo.py` + wire failures to `error_log`.** Drive /
  conversion / sheet-mirror failures recorded; mirror failure no longer fails
  the recording.

### Admin

- [ ] **20. Admin settings CRUD routes + page.** `GET/POST /admin/settings`
  behind `require_admin`; `admin.html` + `admin.ts` form; save blocked on
  validation failure (#16).
- [ ] **21. Admin user management CRUD routes + page.** `/admin/users`
  GET/POST/PATCH/DELETE; auto-generated codes (#7); duplicate-speaker
  rejection; last-admin / self guardrails; users table UI.
- [ ] **22. Admin error view.** `GET /admin/errors` + mark-resolved; errors
  page UI.
- [ ] **23. Admin export + progress.** `GET /admin/export` (CSV stream),
  `GET /admin/progress` (counts); progress summary + download button UI.

### Polish & deploy

- [ ] **24. Contributor in-app recording instructions.** Brief guidance block
  in the recorder UI (quiet room, mic distance, re-record).
- [ ] **25. Recorder mic-constraint hint.** `recorder.start()` accepts
  `sampleRate` / `channelCount`, passed to `getUserMedia` as a best-effort
  hint.
- [ ] **26. `backfill.py` — one-time pre-existing recordings importer.** Scans
  Sheet + Drive, creates `source="backfill"` rows; idempotent; no-op on a
  fresh deploy (§3.6a).
- [ ] **27. Docker Compose + Caddy; retire `render.yaml`.**
  `docker-compose.yml` (app + Caddy TLS); delete `render.yaml`; `.env.example`
  updated (`DATABASE_URL`, `SESSION_SECRET`; remove `ADMIN_PASSWORD` + `COL_*`).
- [ ] **28. README rewrite.** Neon setup, Oracle VM + Docker Compose, Caddy
  TLS, migration + first-admin, backfill, "deploy your own instance" handoff
  (§8), plaintext-access-code tradeoff note.

### Meta

- [ ] **0. Commit `PLAN.md`.** Currently staged; land it before #1.