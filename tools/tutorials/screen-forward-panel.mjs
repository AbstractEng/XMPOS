// Single-screen teaching drawing: readable controls alongside a large screen.
// Deliberately adjusted proportions, not a scale hardware drawing.
export function screenForwardPanel(active = [], screen = "", title = "") {
  const on = (id) => active.includes(id);
  const litButtons = [
    "bank-a",
    "bank-b",
    "bank-c",
    "bank-d",
    "note-repeat",
    "full-level",
    "16-level",
    "tap",
    "rec",
    "overdub",
    "stop",
    "play",
    "play-start",
  ];
  const box = (id, label, x, y, w = 150, h = 54, size = 22) =>
    `<g data-control="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${on(id) ? "#38383d" : id.startsWith("pad-") ? "#46464c" : "#28282c"}" stroke="${on(id) ? "#e6c779" : "#67676c"}" stroke-width="${on(id) ? 4 : 1.5}"/>${litButtons.includes(id) ? `<rect data-feedback-light="${id}" x="${x + w * 0.28}" y="${y + 5}" width="${w * 0.44}" height="4" rx="2" fill="#55555b"/>` : ""}<text x="${x + w / 2}" y="${y + h / 2 + size * 0.35}" text-anchor="middle" font-size="${size}" font-weight="600" fill="${on(id) ? "#f2efe9" : "#eeeeef"}">${
      w < 100 && label.includes(" ")
        ? label
            .split(" ")
            .map(
              (word, line) =>
                `<tspan x="${x + w / 2}" y="${y + h / 2 - size * 0.2 + line * size * 1.1}">${word}</tspan>`,
            )
            .join("")
        : label
    }</text></g>`;
  const label = title.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  const keyColumns = [548, 732, 862, 992, 1122, 1252, 1436];
  const panelKey = (id, text, column, y) => box(id, text, keyColumns[column] - 49, y, 98, 54, 18);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1876 914" role="img" aria-label="MPC Live Mk1 teaching drawing with readable controls and one enlarged screen" font-family="Manrope,sans-serif">
  <rect x="3" y="3" width="1870" height="908" rx="24" fill="#171719" stroke="#454549" stroke-width="3"/>
  <text x="26" y="43" fill="#eeeeef" font-size="25" font-weight="600">MPC LIVE Mk1</text><text x="26" y="68" fill="#b8b8bd" font-size="15">XMP · teaching control map</text>
  ${["A", "B", "C", "D"].map((n, i) => box(`bank-${n.toLowerCase()}`, n, 26 + i * 92, 96, 80, 42, 22)).join("")}
  ${["NOTE REPEAT", "FULL LEVEL", "16 LEVEL", "ERASE"].map((n, i) => box(["note-repeat", "full-level", "16-level", "erase"][i], n, 26 + i * 92, 177, 80, 60, 16)).join("")}
  ${Array.from({ length: 16 }, (_, i) => {
    const n = (3 - Math.floor(i / 4)) * 4 + (i % 4) + 1;
    return box(`pad-${n}`, String(n), 26 + (i % 4) * 92, 282 + Math.floor(i / 4) * 92, 80, 80, 27);
  }).join("")}
  <text x="26" y="676" fill="#b8b8bd" font-size="18">Gold outline = button press</text>
  <rect x="24" y="719" width="356" height="162" rx="12" fill="#101012" stroke="#444449"/>
  <text x="44" y="752" fill="#b8b8bd" font-size="17">ACTION</text><foreignObject x="44" y="774" width="314" height="94"><div xmlns="http://www.w3.org/1999/xhtml" style="font:600 30px/1.3 Manrope,sans-serif;color:#e6c779">${label}</div></foreignObject>
  <rect x="406" y="10" width="1172" height="740" rx="13" fill="#080809" stroke="${on("screen") ? "#f2efe9" : "#505055"}" stroke-width="${on("screen") ? 4 : 2}"/>
  ${screen ? `<image href="${screen}" x="416" y="20" width="1152" height="720"/>` : `<text x="992" y="380" fill="#b8b8bd" font-size="36" text-anchor="middle">TOUCHSCREEN</text>`}
  ${["SHIFT", "MENU", "MAIN", "UNDO", "COPY"].map((name, i) => panelKey(name.toLowerCase(), name, [0, 1, 3, 4, 5][i], 765)).join("")}
  ${["TAP", "REC", "OVER DUB", "STOP", "PLAY", "PLAY START"].map((name, i) => panelKey(["tap", "rec", "overdub", "stop", "play", "play-start"][i], name, i, 840)).join("")}
  ${panelKey("plus", "+", 6, 765)}${panelKey("minus", "−", 6, 840)}
  ${box("q-link", "Q-LINK", 1646, 44, 180, 50, 23)}
  ${Array.from({ length: 4 }, (_, i) => `<g data-control="q${i + 1}"><circle cx="1736" cy="${169 + i * 138}" r="40" fill="#28282c" stroke="${on(`q${i + 1}`) ? "#e6c779" : "#77777e"}" stroke-width="${on(`q${i + 1}`) ? 4 : 2}"/><text x="1736" y="${178 + i * 138}" text-anchor="middle" fill="${on(`q${i + 1}`) ? "#f2efe9" : "#eeeeef"}" font-size="27" font-weight="600">Q${i + 1}</text></g>`).join("")}
  <g data-control="dial"><circle cx="1736" cy="768" r="55" fill="#28282c" stroke="${on("dial") ? "#e6c779" : "#77777e"}" stroke-width="${on("dial") ? 5 : 3}"/><text x="1736" y="774" text-anchor="middle" fill="#eeeeef" font-size="18">DATA DIAL</text></g>
  </svg>`;
}
