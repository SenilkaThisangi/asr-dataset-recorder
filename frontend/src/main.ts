import "./style.css";
import { ApiError, fetchUsers, fetchUtterances, uploadRecording, type Utterance } from "./api";
import { Recorder, extensionForMimeType } from "./recorder";

const STORAGE_KEY = "asr-recorder:selected-user";

const app = document.getElementById("app")!;

type AppState = {
  user: string | null;
  utterances: Utterance[];
  currentIndex: number;
};

const state: AppState = {
  user: localStorage.getItem(STORAGE_KEY),
  utterances: [],
  currentIndex: 0,
};

const recorder = new Recorder();
// When every utterance is recorded we show a completion card. Once the user
// navigates to a specific item (from the list or the prev/next buttons) we drop
// out of that state so they can review and re-record.
let revisiting = false;
let recordingState: "idle" | "recording" | "recorded" = "idle";
let previewBlob: Blob | null = null;
let previewUrl: string | null = null;
let previewMimeType = "";
let isSaving = false;
let saveError: string | null = null;

async function boot() {
  if (!Recorder.isSupported()) {
    renderFatalError(
      "This browser doesn't support audio recording (no MediaRecorder API). Please use a recent version of Chrome, Firefox, Edge, or Safari."
    );
    return;
  }

  if (!state.user) {
    await renderUserPicker();
  } else {
    await loadUserAndRender();
  }
}

async function renderUserPicker(errorMessage?: string) {
  app.innerHTML = `
    <div class="min-h-screen flex items-center justify-center px-4">
      <div class="w-full max-w-sm">
        <div class="text-center mb-8">
          <div class="mx-auto mb-4 h-12 w-12 rounded-2xl bg-accent-500 flex items-center justify-center shadow-lg shadow-accent-200">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" class="h-6 w-6">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3.75 3.75 0 01-3.75-3.75V4.5a3.75 3.75 0 117.5 0v7.5a3.75 3.75 0 01-3.75 3.75z" />
            </svg>
          </div>
          <h1 class="text-2xl font-semibold tracking-tight text-sand-50">Recording Studio</h1>
          <p class="mt-1.5 text-sm font-medium text-accent-400">Select your name to see your assigned utterances.</p>
        </div>
        <div class="bg-sand-100 rounded-2xl shadow-sm border border-sand-300 p-6">
          <label class="block text-sm font-medium text-ink-700 mb-2" for="user-select">Your name</label>
          <select id="user-select" class="w-full rounded-lg border border-sand-300 bg-sand-100 px-3 py-2.5 text-ink-900 shadow-sm focus:border-accent-400 focus:ring-2 focus:ring-accent-400/40 outline-none transition">
            <option value="">Loading names…</option>
          </select>
          ${errorMessage ? `<p class="mt-3 text-sm text-clay-600">${escapeHtml(errorMessage)}</p>` : ""}
          <button id="continue-btn" disabled class="mt-4 w-full rounded-lg bg-accent-500 disabled:bg-sand-200 disabled:text-ink-500 text-ink-900 font-semibold py-2.5 shadow-sm transition hover:bg-accent-400 disabled:hover:bg-sand-200">
            Continue
          </button>
        </div>
      </div>
    </div>
  `;

  const select = document.getElementById("user-select") as HTMLSelectElement;
  const continueBtn = document.getElementById("continue-btn") as HTMLButtonElement;

  try {
    const users = await fetchUsers();
    if (users.length === 0) {
      select.innerHTML = `<option value="">No users found in sheet</option>`;
      return;
    }
    select.innerHTML =
      `<option value="">Choose a name…</option>` +
      users.map((u) => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join("");
  } catch (err) {
    select.innerHTML = `<option value="">Failed to load</option>`;
    showFatalBanner(errorText(err));
    return;
  }

  select.addEventListener("change", () => {
    continueBtn.disabled = !select.value;
  });

  continueBtn.addEventListener("click", async () => {
    if (!select.value) return;
    state.user = select.value;
    localStorage.setItem(STORAGE_KEY, state.user);
    await loadUserAndRender();
  });
}

async function loadUserAndRender() {
  app.innerHTML = renderLoadingShell();
  try {
    state.utterances = await fetchUtterances(state.user!);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      await renderUserPicker(`No utterances found for "${state.user}". Try a different name.`);
      state.user = null;
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    renderFatalError(errorText(err));
    return;
  }

  state.currentIndex = state.utterances.findIndex((u) => !u.is_recorded);
  if (state.currentIndex === -1) state.currentIndex = 0;
  revisiting = false;

  renderMain();
}

function renderLoadingShell(): string {
  return `
    <div class="min-h-screen flex items-center justify-center">
      <div class="flex items-center gap-3 text-sand-300">
        <svg class="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
        </svg>
        <span class="text-sm">Loading your utterances…</span>
      </div>
    </div>
  `;
}

function renderFatalError(message: string) {
  app.innerHTML = `
    <div class="min-h-screen flex items-center justify-center px-4">
      <div class="max-w-md w-full text-center bg-sand-100 rounded-2xl shadow-sm border border-sand-300 p-8">
        <div class="mx-auto mb-4 h-12 w-12 rounded-full bg-clay-500/15 flex items-center justify-center">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" class="h-6 w-6 text-clay-600">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
        </div>
        <h2 class="text-lg font-semibold text-ink-900">Something went wrong</h2>
        <p class="mt-2 text-sm text-ink-500">${escapeHtml(message)}</p>
        <button onclick="location.reload()" class="mt-5 rounded-lg bg-accent-500 text-ink-900 text-sm font-semibold px-4 py-2 hover:bg-accent-400 transition">Reload</button>
      </div>
    </div>
  `;
}

function showFatalBanner(message: string) {
  const el = document.createElement("div");
  el.className = "fixed top-4 left-1/2 -translate-x-1/2 bg-clay-600 text-sand-50 text-sm px-4 py-2 rounded-lg shadow-lg z-50";
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function switchUser() {
  localStorage.removeItem(STORAGE_KEY);
  state.user = null;
  state.utterances = [];
  revisiting = false;
  recorder.cancel();
  resetRecordingUi();
  renderUserPicker();
}

// ---------- Main recording screen ----------

function renderMain() {
  const total = state.utterances.length;
  const doneCount = state.utterances.filter((u) => u.is_recorded).length;
  const allDone = total > 0 && doneCount === total;
  const current = state.utterances[state.currentIndex];
  // Show the celebratory "all complete" card only when everything is done AND the
  // user hasn't navigated to a specific item to revisit it.
  const showDoneCard = allDone && !revisiting;

  app.innerHTML = `
    <div class="min-h-screen flex flex-col lg:flex-row">
      <aside class="lg:w-80 xl:w-96 shrink-0 border-b lg:border-b-0 lg:border-r border-sand-300 bg-sand-100 flex flex-col max-h-[40vh] lg:max-h-screen">
        <div class="p-5 border-b border-sand-200">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-xs font-medium text-ink-500 uppercase tracking-wide">Contributor</p>
              <p class="text-base font-semibold text-ink-900">${escapeHtml(state.user!)}</p>
            </div>
            <button id="switch-user-btn" class="inline-flex items-center gap-1 rounded-md border border-sand-300 bg-sand-100 px-2.5 py-1 text-xs font-medium text-ink-500 shadow-sm hover:bg-sand-200 hover:text-ink-900 active:scale-95 transition">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-3.5 w-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" /></svg>
              Switch
            </button>
          </div>
          <div class="mt-4">
            <div class="flex items-center justify-between text-xs text-ink-500 mb-1.5">
              <span>${doneCount} of ${total} recorded</span>
              <span>${total > 0 ? Math.round((doneCount / total) * 100) : 0}%</span>
            </div>
            <div class="h-2 w-full rounded-full bg-sand-200 overflow-hidden">
              <div class="h-full rounded-full bg-accent-400 transition-all duration-300" style="width:${total > 0 ? (doneCount / total) * 100 : 0}%"></div>
            </div>
          </div>
        </div>
        <div id="utterance-list" class="overflow-y-auto flex-1 p-2"></div>
      </aside>

      <main class="flex-1 flex items-center justify-center p-4 sm:p-8">
        ${showDoneCard || !current ? renderAllDoneCard() : renderRecordingCard(current, allDone)}
      </main>
    </div>
  `;

  document.getElementById("switch-user-btn")?.addEventListener("click", switchUser);
  renderUtteranceList();

  if (!showDoneCard && current) {
    wireRecordingCard(current);
  }
}

function renderAllDoneCard(): string {
  return `
    <div class="w-full max-w-md text-center bg-sand-100 rounded-2xl shadow-sm border border-sand-300 p-8 animate-fade-in-up">
      <div class="mx-auto mb-5 h-16 w-16 rounded-full bg-accent-500/20 flex items-center justify-center">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" class="h-8 w-8 text-accent-700">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </div>
      <h2 class="text-xl font-semibold text-ink-900">All utterances complete!</h2>
      <p class="mt-2 text-sm text-ink-500">You've recorded every utterance assigned to you. Thank you for contributing to the dataset. You can still revisit and re-record any item from the list.</p>
    </div>
  `;
}

function renderRecordingCard(u: Utterance, allDone: boolean): string {
  return `
    <div class="w-full max-w-xl animate-fade-in-up">
      ${
        allDone
          ? `<button id="back-to-summary-btn" class="mb-3 inline-flex items-center gap-1.5 rounded-lg border border-sand-300 bg-sand-100 px-4 py-2 text-sm font-medium text-ink-700 shadow-sm hover:bg-sand-200 hover:border-sand-400 active:scale-95 transition">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
              Back to summary
            </button>`
          : ""
      }
      <div class="bg-sand-100 rounded-2xl shadow-sm border border-sand-300 p-6 sm:p-8">
        <div class="flex items-center justify-between mb-4">
          <span class="text-xs font-medium text-ink-500 uppercase tracking-wide">Utterance ${escapeHtml(u.utterance_id)}</span>
          <span id="status-badge">${statusBadge(u)}</span>
        </div>

        <p class="text-xl sm:text-2xl font-medium text-ink-900 leading-relaxed mb-8">${escapeHtml(u.utterance_text)}</p>

        <div class="flex flex-col items-center gap-4">
          <div id="record-btn-wrap" class="relative">
            <button id="record-btn" class="relative h-24 w-24 rounded-full bg-red-600 hover:bg-red-700 active:scale-95 transition shadow-lg shadow-red-200 flex items-center justify-center text-white">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="h-9 w-9">
                <circle cx="12" cy="12" r="9" />
              </svg>
            </button>
          </div>
          <p id="record-hint" class="text-sm text-ink-500">Tap to start recording</p>

          <div id="preview-area" class="w-full hidden">
            <audio id="preview-audio" controls class="w-full mt-2"></audio>
            <div class="flex gap-3 mt-4">
              <button id="rerecord-btn" class="flex-1 rounded-lg border border-sand-300 text-ink-700 font-medium py-2.5 hover:bg-sand-200 transition">Re-record</button>
              <button id="save-btn" class="flex-1 rounded-lg bg-accent-500 text-ink-900 font-semibold py-2.5 hover:bg-accent-400 transition shadow-sm">Save recording</button>
            </div>
            <p id="save-error" class="mt-3 text-sm text-clay-600 hidden"></p>
          </div>
        </div>
      </div>

      <div class="flex items-center justify-between mt-4">
        <button id="prev-btn" class="inline-flex items-center gap-1.5 rounded-lg border border-sand-300 bg-sand-100 px-4 py-2 text-sm font-medium text-ink-700 shadow-sm hover:bg-sand-200 hover:border-sand-400 active:scale-95 transition disabled:opacity-40 disabled:pointer-events-none" ${state.currentIndex === 0 ? "disabled" : ""}>
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
          Previous
        </button>
        <button id="next-btn" class="inline-flex items-center gap-1.5 rounded-lg border border-sand-300 bg-sand-100 px-4 py-2 text-sm font-medium text-ink-700 shadow-sm hover:bg-sand-200 hover:border-sand-400 active:scale-95 transition disabled:opacity-40 disabled:pointer-events-none" ${state.currentIndex === state.utterances.length - 1 ? "disabled" : ""}>
          Next
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4"><path stroke-linecap="round" stroke-linejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" /></svg>
        </button>
      </div>
    </div>
  `;
}

function statusBadge(u: Utterance): string {
  if (u.is_recorded) {
    return `<span class="inline-flex items-center gap-1 rounded-full bg-accent-500/20 text-accent-700 text-xs font-semibold px-2.5 py-1">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="h-3.5 w-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
      Recorded
    </span>`;
  }
  return `<span class="inline-flex items-center gap-1 rounded-full bg-sand-200 text-ink-500 text-xs font-medium px-2.5 py-1">Not recorded</span>`;
}

function wireRecordingCard(u: Utterance) {
  resetRecordingUi();

  const recordBtn = document.getElementById("record-btn") as HTMLButtonElement;
  const recordHint = document.getElementById("record-hint")!;
  const previewArea = document.getElementById("preview-area")!;
  const previewAudio = document.getElementById("preview-audio") as HTMLAudioElement;
  const rerecordBtn = document.getElementById("rerecord-btn") as HTMLButtonElement;
  const saveBtn = document.getElementById("save-btn") as HTMLButtonElement;
  const saveErrorEl = document.getElementById("save-error")!;
  const prevBtn = document.getElementById("prev-btn") as HTMLButtonElement;
  const nextBtn = document.getElementById("next-btn") as HTMLButtonElement;

  prevBtn.addEventListener("click", () => navigate(-1));
  nextBtn.addEventListener("click", () => navigate(1));

  document.getElementById("back-to-summary-btn")?.addEventListener("click", () => {
    revisiting = false;
    recorder.cancel();
    renderMain();
  });

  recordBtn.addEventListener("click", async () => {
    if (recordingState === "idle") {
      try {
        await recorder.start();
        recordingState = "recording";
        recordBtn.classList.add("recording-pulse");
        recordBtn.innerHTML = squareIcon();
        recordHint.textContent = "Recording… tap to stop";
      } catch (err) {
        showFatalBanner("Microphone access denied or unavailable.");
      }
    } else if (recordingState === "recording") {
      const { blob, mimeType } = await recorder.stop();
      previewBlob = blob;
      previewMimeType = mimeType;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(blob);
      previewAudio.src = previewUrl;

      recordingState = "recorded";
      recordBtn.classList.remove("recording-pulse");
      document.getElementById("record-btn-wrap")!.classList.add("hidden");
      recordHint.classList.add("hidden");
      previewArea.classList.remove("hidden");
    }
  });

  rerecordBtn.addEventListener("click", () => {
    resetRecordingUi();
    document.getElementById("record-btn-wrap")!.classList.remove("hidden");
    recordHint.classList.remove("hidden");
    recordHint.textContent = "Tap to start recording";
    previewArea.classList.add("hidden");
    (document.getElementById("record-btn") as HTMLButtonElement).innerHTML = circleIcon();
  });

  saveBtn.addEventListener("click", async () => {
    if (!previewBlob || isSaving) return;
    isSaving = true;
    saveError = null;
    saveErrorEl.classList.add("hidden");
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";

    try {
      const ext = extensionForMimeType(previewMimeType);
      const updated = await uploadRecording(u.utterance_id, state.user!, previewBlob, `recording.${ext}`);
      const idx = state.utterances.findIndex((x) => x.utterance_id === u.utterance_id);
      if (idx !== -1) state.utterances[idx] = updated;

      const nextPending = state.utterances.findIndex((x) => !x.is_recorded);
      if (nextPending !== -1) {
        state.currentIndex = nextPending;
      } else {
        // Everything is recorded now — fall back to the completion card.
        revisiting = false;
      }

      renderMain();
    } catch (err) {
      saveError = errorText(err);
      saveErrorEl.textContent = saveError;
      saveErrorEl.classList.remove("hidden");
      saveBtn.disabled = false;
      saveBtn.textContent = "Save recording";
    } finally {
      isSaving = false;
    }
  });
}

function navigate(delta: number) {
  const newIndex = state.currentIndex + delta;
  if (newIndex < 0 || newIndex >= state.utterances.length) return;
  state.currentIndex = newIndex;
  revisiting = true;
  recorder.cancel();
  renderMain();
}

function jumpTo(index: number) {
  if (index === state.currentIndex) return;
  state.currentIndex = index;
  revisiting = true;
  recorder.cancel();
  renderMain();
}

function resetRecordingUi() {
  recordingState = "idle";
  previewBlob = null;
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }
}

function circleIcon(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="h-9 w-9"><circle cx="12" cy="12" r="9" /></svg>`;
}

function squareIcon(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="h-8 w-8"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>`;
}

// ---------- Sidebar list ----------

function renderUtteranceList() {
  const container = document.getElementById("utterance-list");
  if (!container) return;

  container.innerHTML = state.utterances
    .map((u, idx) => {
      const active = idx === state.currentIndex;
      return `
        <button data-idx="${idx}" class="utterance-item w-full text-left px-3 py-2.5 rounded-lg flex items-center gap-3 transition ${
          active ? "bg-accent-500/20 ring-1 ring-accent-500/40" : "hover:bg-sand-200"
        }">
          <span class="shrink-0 h-6 w-6 rounded-full flex items-center justify-center ${
            u.is_recorded ? "bg-accent-500/20 text-accent-700" : "bg-sand-200 text-ink-500"
          }">
            ${
              u.is_recorded
                ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" class="h-3.5 w-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>`
                : `<span class="h-1.5 w-1.5 rounded-full bg-ink-300"></span>`
            }
          </span>
          <span class="min-w-0 flex-1">
            <span class="block text-sm ${active ? "text-accent-700 font-semibold" : "text-ink-700"} truncate">${escapeHtml(
              u.utterance_text
            )}</span>
            <span class="block text-xs text-ink-500">${escapeHtml(u.utterance_id)}</span>
          </span>
        </button>
      `;
    })
    .join("");

  container.querySelectorAll<HTMLButtonElement>(".utterance-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx!, 10);
      jumpTo(idx);
    });
  });
}

// ---------- Helpers ----------

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "An unexpected error occurred.";
}

boot();
