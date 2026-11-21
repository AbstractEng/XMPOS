// The web client's error log: every failed action, uncaught error and rejected
// promise, with where it happened. Kept on this browser, printed to the console,
// shown in Device → MENU → Preferences, and on the hosted site also sent to its
// Cloudflare Worker (Workers Logs). Reports carry the error message, its
// context and a short stack, never project or audio data.
export type ErrorEntry = { time: string; context: string; message: string; detail?: string };

const key = "xmp-error-log",
  limit = 50;
let entries: ErrorEntry[] = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(saved) ? saved.slice(-limit) : [];
  } catch {
    return [];
  }
})();
const listeners = new Set<() => void>();

// Reporting: batched, at most 20 entries a batch and 60 a page load, so a
// failure in a loop cannot flood the log. A failed report is not itself logged.
let endpoint: string | undefined;
let pending: ErrorEntry[] = [];
let sent = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
export function reportErrorsTo(url: string | undefined) {
  endpoint = url;
}
function flush() {
  timer = undefined;
  if (!endpoint || !pending.length) return;
  const batch = pending.slice(0, 20);
  pending = pending.slice(20);
  sent += batch.length;
  const body = JSON.stringify({
    page: location.pathname,
    build: import.meta.env.MODE,
    entries: batch,
  });
  try {
    void fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {}
  if (pending.length) timer = setTimeout(flush, 2000);
}
function report(entry: ErrorEntry) {
  if (!endpoint || sent + pending.length >= 60) return;
  pending.push(entry);
  timer ??= setTimeout(flush, 1000);
}
if (typeof addEventListener === "function")
  addEventListener("pagehide", () => {
    if (timer) clearTimeout(timer);
    flush();
  });

const text = (value: unknown, max: number) => String(value ?? "").slice(0, max);

// Handled failures (shown to the user, the song unchanged) are console warnings;
// uncaught errors and rejected promises are console errors.
export function logError(
  context: string,
  error: unknown,
  detail?: string,
  level: "warn" | "error" = "warn",
): string {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
  const stack = error instanceof Error ? error.stack?.split("\n").slice(1, 6).join("\n") : "";
  const entry: ErrorEntry = {
    time: new Date().toISOString(),
    context: text(context, 80),
    message: text(message, 400),
    detail: text([detail, stack].filter(Boolean).join("\n"), 1200) || undefined,
  };
  entries = [...entries, entry].slice(-limit);
  try {
    localStorage.setItem(key, JSON.stringify(entries));
  } catch {}
  console[level](`[XMP] ${entry.context}: ${entry.message}`, error);
  report(entry);
  for (const listener of listeners) listener();
  // A thrown non-Error gets the context as its message.
  return error instanceof Error || typeof error === "string" ? entry.message : entry.context;
}

export const errorLog = (): readonly ErrorEntry[] => entries;

export function clearErrorLog() {
  entries = [];
  try {
    localStorage.removeItem(key);
  } catch {}
  for (const listener of listeners) listener();
}

export const onErrorLogged = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

// A plain-text copy for a bug report: the page, the browser and the entries.
export const errorReport = () =>
  [
    `XMP web client error log · ${location.pathname}${location.search}`,
    navigator.userAgent,
    ...entries.map(
      (e) =>
        `${e.time} · ${e.context} · ${e.message}${e.detail ? `\n  ${e.detail.replace(/\n/g, "\n  ")}` : ""}`,
    ),
  ].join("\n");

let installed = false;
export function installErrorLogging(target: Window = window) {
  if (installed) return;
  installed = true;
  target.addEventListener("error", (event) =>
    logError(
      "Uncaught error",
      event.error ?? event.message,
      event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined,
      "error",
    ),
  );
  target.addEventListener("unhandledrejection", (event) =>
    logError("Unhandled promise rejection", event.reason, undefined, "error"),
  );
}
