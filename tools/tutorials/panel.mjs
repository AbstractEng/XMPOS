// Original vector teaching diagram; labels locate controls, not an electrical model.
export function panel(active = [], screen = "") {
  const on = (id) => active.includes(id);
  const box = (id, label, x, y, w = 75, h = 34, sub = "") =>
    `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" fill="${on(id) ? "#d8b450" : "#23392f"}" stroke="${on(id) ? "#fff0b6" : "#597364"}" stroke-width="${on(id) ? 4 : 1}"/><text x="${x + w / 2}" y="${y + h / 2 + 4}" text-anchor="middle" fill="${on(id) ? "#091710" : "#f4ecd6"}" font-size="${label.length > 10 ? 9 : 11}" font-weight="700">${label}</text>${sub ? `<text x="${x + w / 2}" y="${y + h + 13}" text-anchor="middle" fill="#b4c5ba" font-size="8">${sub}</text>` : ""}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 550" role="img" aria-label="MPC Live Mk1 teaching diagram: pads left, touchscreen centre, four Q-Link knobs right, navigation and transport below" font-family="Arial, sans-serif"><rect x="5" y="5" width="890" height="540" rx="28" fill="#18281f" stroke="#9b8448" stroke-width="4"/><text x="34" y="40" fill="#f2d685" font-size="20" font-weight="700">MPC LIVE Mk1</text><text x="670" y="40" fill="#b4c5ba" font-size="11">XMP • CONTROL MAP</text>${["A", "B", "C", "D"].map((n, i) => box(`bank-${n.toLowerCase()}`, n, 30 + i * 78, 66, 65, 29)).join("")}${["NOTE REPEAT", "FULL LEVEL", "16 LEVEL", "ERASE"].map((n, i) => box(["note-repeat", "full-level", "16-level", "erase"][i], n, 30 + i * 78, 110, 65, 30)).join("")}${Array.from(
    { length: 16 },
    (_, i) => {
      const p = (3 - Math.floor(i / 4)) * 4 + (i % 4);
      return box(
        `pad-${p + 1}`,
        `${p + 1}`,
        30 + (i % 4) * 78,
        164 + Math.floor(i / 4) * 78,
        65,
        65,
      );
    },
  ).join(
    "",
  )}<rect x="358" y="66" width="420" height="298" rx="12" fill="#050d09" stroke="${on("screen") ? "#fff0b6" : "#476251"}" stroke-width="${on("screen") ? 5 : 2}"/>${screen ? `<image href="${screen}" x="368" y="80" width="400" height="250" preserveAspectRatio="xMidYMid meet"/>` : '<text x="568" y="216" text-anchor="middle" fill="#b4c5ba" font-size="18">TOUCHSCREEN</text>'}${["SHIFT", "MENU", "MAIN", "UNDO", "COPY"].map((n, i) => box(n.toLowerCase(), n, 358 + i * 77, 393, 67, 34, ["", "BROWSE", "TRACK", "REDO", "DELETE"][i])).join("")}${["REC", "OVER DUB", "STOP", "PLAY", "PLAY START"].map((n, i) => box(["rec", "overdub", "stop", "play", "play-start"][i], n, 358 + i * 77, 463, 67, 36)).join("")}${box("tap", "TAP", 270, 488, 65, 30)}${box("q-link", "Q-LINK", 807, 66, 60, 30)}${Array.from({ length: 4 }, (_, i) => `<circle cx="837" cy="${132 + i * 59}" r="23" fill="${on(`q${i + 1}`) ? "#d8b450" : "#23392f"}" stroke="${on(`q${i + 1}`) ? "#fff0b6" : "#819886"}" stroke-width="3"/><text x="837" y="${137 + i * 59}" text-anchor="middle" fill="${on(`q${i + 1}`) ? "#091710" : "#f4ecd6"}" font-size="13">Q${i + 1}</text>`).join("")}<circle cx="823" cy="400" r="36" fill="${on("dial") ? "#d8b450" : "#23392f"}" stroke="${on("dial") ? "#fff0b6" : "#819886"}" stroke-width="4"/><text x="823" y="404" text-anchor="middle" fill="${on("dial") ? "#091710" : "#f4ecd6"}" font-size="10">DATA DIAL</text>${box("minus", "−", 780, 465, 38, 34)}${box("plus", "+", 831, 465, 38, 34)}<text x="30" y="526" fill="#b4c5ba" font-size="10">Original simplified drawing • gold + outline = the control being explained</text></svg>`;
}
