// Keep the primary guide on the production C++ Device interface. The separate
// Advanced Studio reference describes its own detailed editors explicitly.
const chapter = (id, label, title, body) =>
  `<section id="${id}" data-chapter><div class="chapter-label">${label}</div><h2>${title}</h2>${body}</section>`;
const recipe = (rows) =>
  `<ol class="recipe">${rows.map(([title, text]) => `<li><h3>${title}</h3><p>${text}</p></li>`).join("")}</ol>`;
const replace = (html, id, content) => {
  const pattern = new RegExp(`<section id="${id}"[\\s\\S]*?</section>`);
  if (!pattern.test(html)) throw new Error(`Missing manual section: ${id}`);
  return html.replace(pattern, content);
};
export function updateNativeReference(html) {
  html = replace(
    html,
    "quick-start",
    chapter(
      "quick-start",
      "QUICK START / YOUR FIRST LOOP",
      "Make your first loop",
      `
<div class="quick-launch"><a class="primary" href="%BASE_URL%" target="_blank" rel="noopener">Open XMP &amp; make a beat ↗</a><span>Have music open? Save it before starting a new project.</span></div>
${recipe([
  [
    "Start fresh",
    "Hold <strong>MENU + PAD 5</strong> for Project. <strong>PAD 13</strong> opens New; follow the confirmation. Your original drum kit is ready.",
  ],
  [
    "Make a clip",
    "Press <strong>A → 16 LEVEL → DATA DIAL</strong>. You now have a 16-step clip on track 1.",
  ],
  [
    "Put down the kick",
    "Hold <strong>SHIFT + PAD 1</strong> to select Kick, then release SHIFT. Press <strong>PAD 13, 9, 5, 1</strong>: those are steps <strong>1, 5, 9, 13</strong>.",
  ],
  [
    "Add the backbeat",
    "Hold <strong>SHIFT + PAD 2</strong> to select Snare. Release SHIFT, then press <strong>PAD 9 and 1</strong> for steps <strong>5 and 13</strong>.",
  ],
  [
    "Hear it",
    'Press <strong>PLAY START</strong>. There’s your loop. <strong>STOP</strong> ends playback. <a href="#02-first-beat">Watch the exact pad presses</a>.',
  ],
  [
    "Keep it",
    "Press <strong>STOP</strong> and wait for <strong>Saved</strong>; on hardware, <strong>Saved on stick</strong>. To name a copy, hold <strong>MENU + PAD 5</strong>, then <strong>PAD 16</strong> for Save as. In the browser, <strong>Download saved project</strong> keeps a portable file backup.",
  ],
])}
<p class="quick-next"><strong>Add a bass:</strong> <strong>B → MENU + PAD 16 → PAD 15</strong> chooses Synth on a new track. <a href="#04-synth">Try the bass lesson</a>, or <a href="#06-scenes">launch your clips from the pads</a>.</p>
<p class="small">On the Live, hold MENU or SHIFT with the next control. In the browser, click MENU or SHIFT, then the control. Pad 1 is bottom left; pad 13 is top left.</p>`,
    ),
  );
  html = replace(
    html,
    "first-beat",
    chapter(
      "first-beat",
      "02 / START A TRACK",
      "Build a loop, then a song",
      recipe([
        [
          "Choose an instrument",
          "A–D selects tracks 1–4; SHIFT + A–D selects 5–8. Hold <strong>MENU + PAD 16</strong> for Sound. A new track asks what it becomes: <strong>PAD 13 Kit · 14 Sampler · 15 Synth · 16 MIDI</strong>. For an existing track, hold <strong>SHIFT + MENU + PAD 15</strong> on Sound to open Choose machine.",
        ],
        [
          "Use the pads to enter notes",
          "<strong>16 LEVEL</strong> opens Steps; press the dial to create a clip in an empty slot. <strong>SHIFT + a pad</strong> selects the drum sound or melodic note. Release SHIFT, then press pads to toggle steps. Read time left to right from the top row, so pads 13, 9, 5, 1 mark the four beats. Turn the dial for later sixteen-step pages.",
        ],
        [
          "Give the part some movement",
          "The last entered hit is selected. Read the four Q-Link labels; on the Step page, Q1 changes its velocity. Q-LINK changes the group of four controls. UNDO takes back a change; SHIFT + UNDO redoes it.",
        ],
        [
          "Make a variation",
          'MAIN returns to Clips. Hold SHIFT and select the source pad without launching it. Press COPY, then the destination pad. It is an independent clip: edit its ending without changing the original. <a href="#05-variation">Follow the variation lesson</a>.',
        ],
        [
          "Play clips and scenes",
          "In Clips, tracks run across and scenes down. PAD 13 is the first visible track/scene slot; PAD 9 is that track’s next scene. Press a clip’s pad to launch it, and again to stop that track. Turn the dial to choose a scene; press it to launch the whole row. Empty slots stop their tracks. + / − changes the visible scene window.",
        ],
        [
          "Arrange a song",
          'Hold <strong>MENU + PAD 10</strong> for Song. The pads add scenes: top-left PAD 13 is scene 1, PAD 14 is scene 2. Use the Q-Link labels to set the selected block’s repeats. PLAY START plays the chain; STOP finishes. <a href="#07-song">Build a short arrangement</a>.',
        ],
        [
          "Change sounds and chop a loop",
          'SHIFT + MENU opens Browse. SHIFT + PAD 11 shows Kits. For one sound, show Samples, press an ordinary pad to choose the load target, use SHIFT + PAD 13 to select the first listed sample, and press the dial to load. On a Kit track, open a pad’s Sample page, use + / − for equal slices, and press the dial to keep them across successive pads. <a href="#16-slice-kit">Make a four-pad kit from a loop</a>.',
        ],
        [
          "Balance and save",
          "Hold <strong>MENU + PAD 11</strong> for Mix. The top two pad rows select tracks; the bottom two mute them, with SHIFT for solo. Q1 sets the selected track’s level. STOP, then wait for Saved before leaving. Project is <strong>MENU + PAD 5</strong>: PAD 15 saves, PAD 16 saves a named copy.",
        ],
      ]) +
        '<p><a href="#learn">Follow the sixteen short lessons</a> to build one project through the whole workflow.</p>',
    ),
  );
  html = replace(
    html,
    "workspace",
    chapter(
      "workspace",
      "03 / LIVE MK1 BUTTON MAP",
      "Buttons &amp; navigation",
      `
<p>The browser Device view runs the same C++ touchscreen as the Live and emulator. The surrounding hardware panel delivers your input; file access and audio connect through the platform adapter. The videos record this browser build.</p>
<pre class="pad-map"><code>13  14  15  16   ← top row
 9  10  11  12
 5   6   7   8
 1   2   3   4   ← bottom row</code></pre>
<p><strong>Pad numbers stay fixed; their jobs change with the page.</strong> Play uses sounds or notes. Steps uses time positions, with SHIFT + pad selecting the sound or note. Clips uses track/scene slots.</p>
<div class="table-scroll"><table><caption>Your XMP hardware shortcuts</caption><thead><tr><th>Control</th><th>Action</th></tr></thead><tbody>${[
        ["MAIN / SHIFT + MAIN", "Clips / Play"],
        [
          "16 LEVEL",
          "Steps for the selected clip; press the dial to create a clip in an empty slot",
        ],
        ["Hold MENU + pads 13–16", "Play, Steps, Sample, Sound"],
        ["Hold MENU + pads 9–12", "Clips, Song, Mix, Browse"],
        ["Hold MENU + PAD 5", "Project: PAD 13 New, 14 Open, 15 Save, 16 Save as"],
        ["SHIFT + MENU", "Browse"],
        ["A–D / SHIFT + A–D", "Tracks 1–4 / 5–8"],
        [
          "Data dial",
          "Turn to browse or move focus; press to act. Clips: choose/launch a scene. Steps: move through sixteen-step pages. Browse: choose/load an entry.",
        ],
        ["SHIFT + dial press", "Back or cancel"],
        [
          "Q-LINK / four knobs",
          "Change the knob group / adjust the four parameters labelled on screen",
        ],
        [
          "REC",
          "On Play, start a note take with a count-in; press again to finish. On Sample, recording follows the Sample workflow.",
        ],
        ["OVER DUB", "Add notes to the playing clip; press again to finish"],
        ["PLAY / PLAY START / STOP", "Play or continue / play from the beginning / stop"],
        [
          "COPY, then destination pad",
          "Copy a focused clip independently; SHIFT + COPY removes its scene assignment",
        ],
        ["UNDO / SHIFT + UNDO", "Undo / redo"],
        ["ERASE", "Remove the selected sound’s notes from the focused clip"],
        ["FULL LEVEL", "Toggle fixed full velocity for pad playing"],
        [
          "+ / −",
          "Clips: scene windows. Play: octaves. Sound: preset banks. Kit Sample: slice count.",
        ],
        ["Mix pads", "Top rows select tracks; bottom rows mute, SHIFT + bottom pad solos"],
      ]
        .map(([a, b]) => `<tr><th>${a}</th><td>${b}</td></tr>`)
        .join("")}</tbody></table></div>
<p>On hardware, hold MENU while pressing the destination pad, or hold MENU for three seconds to leave the launcher open. Hold SHIFT with the next control. In the browser, click the modifier and then the control; keyboard Shift also works. For SHIFT + MENU with the mouse, click MENU again to release it and enter Browse. Gold highlights in each video show the exact physical controls used, including combinations.</p>
<h3>Advanced Studio detail editors</h3><p><a href="%BASE_URL%?view=studio">Advanced Studio</a> has a separate editor layout for detailed automation, effects and file exchange. The following reference chapters label those editor instructions explicitly. Follow the pad lessons for the common Device workflow.</p>`,
    ),
  );
  const notes = {
    patterns:
      '<strong>Device:</strong> Press 16 LEVEL. Hold SHIFT + a pad to select a sound or note, then release SHIFT and use the grid to toggle steps. Time starts on top-left PAD 13. Read the Q-Link labels to edit the selected hit. <a href="#03-hats-groove">Try the velocity lesson</a>.',
    perform:
      '<strong>Device:</strong> MAIN opens Clips. Pads launch the visible slots; press a playing clip again to stop its track. Turn and press the dial to launch a whole scene. MENU + PAD 10 opens Song, where pads add scenes to the chain. <a href="#06-scenes">Try pad launching</a>.',
    mix: '<strong>Device:</strong> MENU + PAD 11 opens Mix. Top pad rows select tracks, bottom rows mute, and SHIFT + a bottom pad solos. Q1 adjusts the selected track’s level. Read the four knob labels before turning. <a href="#08-mix">Try the mix lesson</a>.',
  };
  for (const [id, text] of Object.entries(notes)) {
    const start = html.indexOf(`<section id="${id}"`);
    const end = html.indexOf("</section>", start);
    const section = html
      .slice(start, end)
      .replace(
        /<p class="note"><strong>Device:<\/strong>[\s\S]*?<\/p>/,
        `<p class="note">${text}</p>`,
      );
    html = html.slice(0, start) + section + html.slice(end);
  }
  html = html.replace(
    "its Machine button changes the machine.",
    "hold SHIFT + MENU + PAD 15 on Sound to open Choose machine.",
  );
  html = html.replace(
    "Once chosen, the Machine button there changes it.",
    "Hold SHIFT + MENU + PAD 15 on Sound to change it.",
  );
  html = html.replace(
    "on the Device Sound page, − and + turn the page and the top pads choose.",
    "on the Device Sound page, − and + turn the preset bank and the pads choose.",
  );
  // Advanced Studio still exposes the detailed packaging controls. Device
  // provides Save/Save as and a host download instead.
  const projects = html.indexOf('<section id="projects"');
  const projectEnd = html.indexOf("</section>", projects);
  let text = html.slice(projects, projectEnd);
  text = text.replace(
    "<h3>Autosave and portable copies</h3>",
    '<h3>Device: save, name and reopen</h3><p>STOP and wait for Saved, or Saved on stick on the Live. Hold MENU + PAD 5 for Project. PAD 15 saves the current project; PAD 16 opens Save as. Enter a name on the screen and PAD 14 confirms it. PAD 14 on Project opens the saved-project browser. Select your entry and press the dial to reopen it.</p><p>In the browser, use Download saved project in the host bar after saving. Keep that .xmpsong outside the browser as a backup. To import a file, Add library files puts it in Browse; open Projects and load it there. On hardware, saved files are on your XMP USB stick. <a href="#12-save-export">Watch Save and Reopen</a>.</p><h3>Advanced Studio: autosave and portable copies</h3>',
  );
  text = text.replace(
    "<strong>Save portable project</strong> in Device view (or <strong>Save project</strong> in Advanced Studio)",
    "<strong>Save project</strong> in Advanced Studio",
  );
  text = text.replace("When I open MENU → Project", "When I open Advanced Studio’s Project editor");
  html = html.slice(0, projects) + text + html.slice(projectEnd);
  html = html.replace(
    /<p[^>]*>[^<]*(?:MPC Live Mk1|Live Mk1)[^<]*(?:arriv(?:ed|ing)|arrives)[\s\S]*?<\/p>/g,
    "",
  );
  html = html.replace(
    "schema version 6; supported versions 1–5",
    "schema version 8; supported versions 1–7",
  );
  html = html.replace(
    "It runs a browser audio engine and keeps projects locally. The native Live session shares the project model and C++ music core. Its screen controls still differ from browser Device view; the lessons list the matching actions for each interface.",
    "It plays through your browser’s audio output and keeps projects locally. Device view, the Live and the emulator use the same C++ touchscreen, with the same screens, pad actions and project workflow. The surrounding panel, audio connection and file access adapt to where you run it.",
  );
  html = html.replace(
    /<p><strong>Device preview limits:<\/strong>[\s\S]*?<\/p>/,
    "<p><strong>Shared Device workflow:</strong> eight tracks, sixteen scenes and up to sixteen clips per track. Browser Add library files accepts WAV, kit and project files, with at most 256 library entries in the session. WAVs are limited to 4 MiB; project files to 24 MiB. On the Live, the library reads the configured USB-stick root. Browser pads use fixed velocity; Live pad input supplies its velocity. REC creates a take in an empty slot; OVER DUB adds notes to a playing clip. Additional instrument pad banks, Half Level and 16 Levels parameter spreads are pending; 16 LEVEL opens Steps. The hosted browser does not open physical MIDI, USB, HID or Akai devices.</p>",
  );
  html = html.replace("1,000,000 total frames</td>", "2,000,000 total frames</td>");
  html = html.replace(
    "Return to the Studio tab, click Enable audio, select a sampler or synth track and audition a pad.",
    "In Device view, select a Kit or Synth track, press SHIFT + MAIN for Play and try a pad. A click or pad press starts browser audio. In Advanced Studio, choose Enable audio first.",
  );
  html = html.replace(
    "Click a non-control area first. Pad shortcuts are ignored while an input, menu or button has focus. Check that audio is enabled.",
    "Finish any value or name entry first. The Device keyboard pads follow 1234, QWER, ASDF, ZXCV from top to bottom; physical pad 1 is Z. In Advanced Studio, click a non-control area before playing with keys.",
  );
  html = html.replace('<ol class="recipe">', '<ol class="recipe quick-recipe">');
  html = html.replace(
    "The 32 presets sit on four pages (Classic, Pop &amp; rock, Electronic &amp; dance, House &amp; acid);",
    "The 32 presets cover Classic, Pop &amp; rock, Electronic &amp; dance, and House &amp; acid;",
  );
  return html;
}
