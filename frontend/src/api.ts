export interface Utterance {
  utterance_id: string;
  user: string;
  utterance_text: string;
  status: string;
  drive_file_link: string;
  is_recorded: boolean;
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "ApiError";
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (body?.detail) detail = body.detail;
    } catch {
      // ignore
    }
    throw new ApiError(detail, res.status);
  }
  return res.json() as Promise<T>;
}

export async function fetchUsers(): Promise<string[]> {
  const res = await fetch("/api/users");
  return handle<string[]>(res);
}

export async function fetchUtterances(user: string): Promise<Utterance[]> {
  const res = await fetch(`/api/users/${encodeURIComponent(user)}/utterances`);
  return handle<Utterance[]>(res);
}

export async function uploadRecording(
  utteranceId: string,
  user: string,
  blob: Blob,
  filename: string
): Promise<Utterance> {
  const form = new FormData();
  form.append("file", blob, filename);
  const res = await fetch(
    `/api/utterances/${encodeURIComponent(utteranceId)}/recording?user=${encodeURIComponent(user)}`,
    { method: "POST", body: form }
  );
  return handle<Utterance>(res);
}
