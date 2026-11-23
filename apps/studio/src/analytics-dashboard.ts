import "./analytics-dashboard.css";

type Row = Record<string, string | number>;
interface Report {
  days: number;
  generatedAt: string;
  summary: {
    sessions: number;
    active_ms: number;
    average_active_ms: number;
    play_ms: number;
    record_ms: number;
    visible_ms: number;
  };
  daily: Row[];
  counters: Row[];
  pages: Row[];
  workspaces: Row[];
}
const element = <T extends HTMLElement = HTMLElement>(id: string) => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing dashboard ${id}`);
  return node as T;
};
let key = "";
let report: Report | undefined;
const status = element("status");
const duration = (ms: number) =>
  ms < 60000
    ? `${Math.round(ms / 1000)} sec`
    : ms >= 3600000
      ? `${(ms / 3600000).toFixed(1)} hr`
      : `${(ms / 60000).toFixed(1)} min`;
const label = (name: string) =>
  name
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
function table(id: string, headings: string[], rows: (string | number)[][]) {
  const target = element(id);
  target.replaceChildren();
  if (!rows.length) {
    target.textContent = "No activity recorded yet.";
    return;
  }
  const table = document.createElement("table");
  const head = table.createTHead().insertRow();
  for (const title of headings) {
    const cell = document.createElement("th");
    cell.textContent = title;
    cell.scope = "col";
    head.append(cell);
  }
  const body = table.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    for (const value of row) tr.insertCell().textContent = String(value);
  }
  target.append(table);
}
function draw(value: Report) {
  const s = value.summary;
  element("metrics").replaceChildren();
  for (const [title, value] of [
    ["Sessions", s.sessions],
    ["Active time", duration(s.active_ms)],
    ["Average active session", duration(s.average_active_ms)],
    ["Playing", duration(s.play_ms)],
    ["Recording", duration(s.record_ms)],
    ["Foreground time", duration(s.visible_ms)],
  ]) {
    const card = document.createElement("div"),
      name = document.createElement("span"),
      amount = document.createElement("strong");
    name.textContent = String(title);
    amount.textContent = String(value);
    card.append(name, amount);
    element("metrics").append(card);
  }
  const max = Math.max(1, ...value.daily.map((r) => Number(r.active_ms)));
  element("daily").replaceChildren();
  for (const row of value.daily) {
    const line = document.createElement("div"),
      day = document.createElement("span"),
      bar = document.createElement("progress"),
      info = document.createElement("span");
    line.className = "day";
    day.textContent = String(row.day);
    bar.max = max;
    bar.value = Number(row.active_ms);
    bar.setAttribute("aria-label", `${row.day} active time`);
    info.textContent = `${duration(Number(row.active_ms))} · ${row.sessions} sessions`;
    line.append(day, bar, info);
    element("daily").append(line);
  }
  if (!value.daily.length)
    element("daily").textContent = "Activity will appear after someone uses the hosted client.";
  const counters = (kind: string) =>
    value.counters.filter((r) => String(r.name).startsWith(`${kind}:`));
  table(
    "features",
    ["Feature", "Actions", "Sessions"],
    counters("feature").map((r) => [
      label(String(r.name).split(":")[1] ?? ""),
      r.count ?? 0,
      r.sessions ?? 0,
    ]),
  );
  table(
    "controls",
    ["Control", "Screen", "Presses"],
    counters("control").map((r) => {
      const [, control, page] = String(r.name).split(":");
      return [label(control ?? ""), label(page ?? ""), r.count ?? 0];
    }),
  );
  table(
    "screens",
    ["Screen", "Active time"],
    value.pages.map((r) => [label(String(r.name)), duration(Number(r.active_ms))]),
  );
  table(
    "machines",
    ["Machine", "Selections", "Sessions"],
    counters("machine").map((r) => [
      label(String(r.name).split(":")[1] ?? ""),
      r.count ?? 0,
      r.sessions ?? 0,
    ]),
  );
  table(
    "workspaces",
    ["Site", "Workspace", "Sessions", "Active time"],
    value.workspaces.map((r) => [
      r.site ?? "",
      label(String(r.workspace)),
      r.sessions ?? 0,
      duration(Number(r.active_ms)),
    ]),
  );
  element("updated").textContent = `Updated ${new Date(value.generatedAt).toLocaleString()}.`;
}
let pending = false;
let generation = 0;
async function load() {
  if (pending) return;
  const expected = generation;
  pending = true;
  status.textContent = "Loading analytics…";
  try {
    const days = element<HTMLSelectElement>("days").value;
    const response = await fetch(`${import.meta.env.BASE_URL}api/analytics/report?days=${days}`, {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
      credentials: "omit",
    });
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? "The dashboard key was not accepted."
          : "Analytics are unavailable. Try again shortly.",
      );
    const value = (await response.json()) as Report;
    if (expected !== generation) return;
    report = value;
    draw(report);
    element("dashboard").hidden = false;
    element("login").hidden = true;
    element<HTMLInputElement>("key").value = "";
    status.textContent = "";
  } catch (error) {
    if (expected !== generation) return;
    status.textContent = error instanceof Error ? error.message : "Could not load analytics.";
  } finally {
    pending = false;
  }
}
element("login").addEventListener("submit", (e) => {
  e.preventDefault();
  key = element<HTMLInputElement>("key").value.trim();
  void load();
});
element("refresh").addEventListener("click", () => void load());
element("days").addEventListener("change", () => void load());
element("logout").addEventListener("click", () => {
  ++generation;
  key = "";
  report = undefined;
  element("dashboard").hidden = true;
  element("login").hidden = false;
  for (const id of [
    "metrics",
    "daily",
    "features",
    "controls",
    "screens",
    "machines",
    "workspaces",
  ])
    element(id).replaceChildren();
});
element("download").addEventListener("click", () => {
  if (!report) return;
  const rows: (string | number)[][] = [["section", "name", "count_or_ms", "sessions"]];
  for (const [name, value] of Object.entries(report.summary))
    rows.push(["summary", name, value, ""]);
  for (const row of report.counters)
    rows.push(["counter", row.name ?? "", row.count ?? 0, row.sessions ?? 0]);
  for (const row of report.pages)
    rows.push(["screen", row.name ?? "", row.active_ms ?? 0, row.sessions ?? 0]);
  for (const row of report.daily)
    rows.push(["daily_active_ms", row.day ?? "", row.active_ms ?? 0, row.sessions ?? 0]);
  const csv = rows
    .map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","))
    .join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" })),
    link = document.createElement("a");
  link.href = url;
  link.download = `xmp-usage-${report.days}-days.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
