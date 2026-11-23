// Both browser workspaces use the same project format and autosave store.
import { installErrorLogging, logError, reportErrorsTo } from "./error-log.ts";
import { installUsageAnalytics } from "./usage.ts";
import "./usage.css";
import { APP_VERSION } from "./version.ts";

document.title = `${document.title} · ${APP_VERSION}`;

installErrorLogging();
if (import.meta.env.MODE === "hosted")
  reportErrorsTo(`${import.meta.env.BASE_URL}api/client-errors`);
if (import.meta.env.MODE === "hosted") {
  try {
    installUsageAnalytics(
      new URLSearchParams(location.search).get("view") === "studio" ? "studio" : "device",
    );
  } catch {
    /* Analytics availability never prevents music startup. */
  }
}
const boot = document.getElementById("boot-screen");
const image = boot?.querySelector("img");
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Let fast loads show the artwork too, with a cap for a slow image response.
const artwork = image
  ? Promise.race([
      image.decode().then(
        () => wait(500),
        () => undefined,
      ),
      wait(1200),
    ])
  : undefined;

try {
  if (new URLSearchParams(location.search).get("view") === "studio") await import("./main.ts");
  else await import("./device/wasm-app.ts");
  await artwork;
  document.getElementById("app")?.removeAttribute("inert");
  boot?.remove();
} catch (error) {
  if (!boot) throw error;
  logError("XMP startup failed", error);
  document.getElementById("boot-status")?.remove();
  const recovery = document.getElementById("boot-recovery");
  recovery?.querySelector("button")?.addEventListener("click", () => location.reload());
  recovery?.removeAttribute("hidden");
}
