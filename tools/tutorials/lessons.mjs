// One source for burned-in instructions, speech, captions and written lessons.
const step = (title, caption, controls, speech = caption, tip = "") => [
  title,
  caption,
  tip,
  controls,
  speech,
];
const common =
  "MAIN: Clips; SHIFT + MAIN: Play; 16 LEVEL: Steps. A–D selects tracks 1–4. Hold SHIFT on the Live; in the browser click SHIFT, then the next control. Captured from the current browser Device interface; physical input and file providers differ.";
const lesson = (id, title, goal, setup, steps, live = common) => ({
  id,
  title,
  goal,
  setup,
  steps,
  live,
});
export const lessons = [
  lesson(
    "01-navigation",
    "Find your way around",
    "Move between Clips, Play, Steps and Sound.",
    "Navigation keeps the notes in your existing song.",
    [
      step(
        "Start in Clips",
        "Tracks run across; scenes run down. Select a clip to work on it.",
        ["main"],
        "Start with Clips. Tracks run across, and scenes run down. A clip holds one track’s notes.",
      ),
      step(
        "Open MENU",
        "Track pages above; project pages below. Choose Play machine.",
        ["menu", "screen"],
        "Press Menu. Track pages are above, and project pages below. Choose Play machine.",
      ),
      step(
        "Play your instrument",
        "The pads play the selected track. A–D changes tracks.",
        ["bank-a", "screen"],
        "In Play, pads play your instrument. A through D selects tracks one through four.",
      ),
      step(
        "Open Steps",
        "16 LEVEL opens the pattern. Select inspects; Draw adds or removes hits.",
        ["16-level", "screen"],
        "Press sixteen Level for Steps. Select inspects a hit. Draw adds or removes hits.",
      ),
      step(
        "Read the Q-Links",
        "The four values at the right label Q1–Q4. Tap a value to edit it.",
        ["q1", "q2", "q3", "q4"],
        "Read the four cue link values at the right. Tap a value for direct editing.",
      ),
      step(
        "Go home",
        "MAIN returns to Clips. MENU → Sound shapes the instrument.",
        ["main"],
        "Press Main to return to Clips. Menu, then Sound, shapes the instrument. Next, make a beat.",
      ),
    ],
  ),
  lesson(
    "02-first-beat",
    "Make a kick and snare loop",
    "Program a one-bar drum loop.",
    "Save your current project before starting a disposable practice song.",
    [
      step(
        "Start a clean song",
        "MENU → Project & files → New empty song. Save existing work first.",
        ["menu", "screen"],
        "Save your current song first. In Menu, open Project and files, then choose New empty song.",
      ),
      step(
        "Open the first clip",
        "MAIN → touch track 1, scene 1, then touch it again to open it. Choose Draw.",
        ["main", "screen"],
        "Press Main. Touch the top left clip, then touch it again to open it. Choose Draw to add hits.",
      ),
      step(
        "Place four kicks",
        "Choose Kick. Turn on steps 1, 5, 9 and 13.",
        ["screen"],
        "Choose Kick. Add hits on one, five, nine, and thirteen. Four steady beats.",
      ),
      step(
        "Add the backbeat",
        "Choose Snare. Turn on steps 5 and 13. Keep Length at 16.",
        ["screen"],
        "Choose Snare. Add hits on five and thirteen for the backbeat. Keep the length at sixteen.",
      ),
      step(
        "Listen",
        "PLAY START repeats the bar. Hear four kicks and two snares.",
        ["play-start"],
        "Press Play Start. Listen to your first loop: four kicks and two snares.",
      ),
      step(
        "Stop and check",
        "STOP ends playback. UNDO takes back one edit.",
        ["stop", "undo"],
        "Press Stop. Undo takes back one edit. Try a different kick pattern when you are ready.",
      ),
    ],
  ),
  lesson(
    "03-hats-groove",
    "Give your hats some movement",
    "Add hats and shape their velocity.",
    "Continue the kick and snare loop.",
    [
      step(
        "Choose the closed hat",
        "In Steps, choose Closed hat and select Draw.",
        ["screen"],
        "In Steps, choose Closed hat and Draw. Keep the kick and snare in place.",
      ),
      step(
        "Add eighth notes",
        "Add steps 1, 3, 5, 7, 9, 11, 13 and 15.",
        ["screen"],
        "Add hats on one, three, five, seven, nine, eleven, thirteen, and fifteen.",
      ),
      step(
        "Inspect a hit",
        "Choose Select, then step 3. It stays on while you inspect it.",
        ["screen"],
        "Choose Select, then tap step three. The hit stays on while you inspect it.",
      ),
      step(
        "Soften the offbeat",
        "Tap Velocity, enter 45, then Apply. Values can be typed directly.",
        ["screen", "q1"],
        "Tap Velocity. Enter forty five, then Apply. A softer offbeat gives the groove movement.",
      ),
      step(
        "Hear the change",
        "PLAY START. Listen to the softer hat between the strong beats.",
        ["play-start"],
        "Press Play Start. Listen to that softer hat between the strong beats.",
      ),
      step(
        "Keep experimenting",
        "STOP. Try softer hits on steps 7, 11 and 15; UNDO restores an edit.",
        ["stop", "undo"],
        "Press Stop. Try softer hits on seven, eleven, and fifteen. Undo lets you compare.",
      ),
    ],
  ),
  lesson(
    "04-synth",
    "Add a pitched synth part",
    "Use a second instrument and the piano roll.",
    "Continue the drum loop. Melodic playing pads now default to C major.",
    [
      step(
        "Choose track 2",
        "Press B, then MENU → Sound. A track with no machine yet asks for one.",
        ["bank-b", "menu", "screen"],
        "Press B for track two. Open Menu, then Sound. A new track asks which machine it should be.",
      ),
      step(
        "Choose a synth",
        "Choose Subtractive synth. C major is the default playing scale.",
        ["screen"],
        "Choose Subtractive synth. The playing pads default to C major; saved notes keep their pitches.",
      ),
      step(
        "Open its clip",
        "MAIN → touch track 2, scene 1, then touch it again to open it. Choose Draw.",
        ["main", "screen"],
        "Press Main. Touch track two in scene one, then touch it again to open it. Choose Draw.",
      ),
      step(
        "Place C notes",
        "Choose C3 in the note ribbon. Draw at steps 1 and 9.",
        ["screen"],
        "Choose C three in the note ribbon. Draw notes on steps one and nine.",
      ),
      step(
        "Answer with G",
        "Choose G3 in the note ribbon. Draw at steps 7 and 15.",
        ["screen"],
        "Choose G three. Draw notes on seven and fifteen for an answering phrase.",
      ),
      step(
        "Hear both tracks",
        "PLAY START plays the drums and synth together.",
        ["play-start"],
        "Press Play Start. Hear the drums and synth together. Select lets you inspect notes without removing them.",
      ),
    ],
  ),
  lesson(
    "05-variation",
    "Make a second version",
    "Copy a clip independently and edit its ending.",
    "Continue the two-track groove.",
    [
      step(
        "Return to Clips",
        "MAIN shows the scene matrix. Select the original drum clip.",
        ["main", "screen"],
        "Press Main and select the original drum clip in the first scene.",
      ),
      step(
        "Copy the source",
        "Press COPY. XMP now waits for a destination slot.",
        ["copy"],
        "Press Copy. XMP waits for a destination slot.",
      ),
      step(
        "Choose the destination",
        "Press pad 9: track 1, scene 2. The independent copy is immediate.",
        ["pad-9"],
        "Press pad nine for track one in scene two. The independent copy is immediate.",
      ),
      step(
        "Change the ending",
        "Touch the new clip again to open it → Draw → Kick. Turn off step 13.",
        ["screen"],
        "Touch the new clip again to open it, choose Draw and Kick, then turn off step thirteen.",
      ),
      step(
        "Undo and redo",
        "UNDO restores the kick. SHIFT + UNDO repeats your change.",
        ["undo", "shift"],
        "Undo restores the hit. Shift and Undo repeats your change.",
      ),
      step(
        "Compare the clips",
        "MAIN. Scene 1 keeps the original; scene 2 holds your variation.",
        ["main", "screen"],
        "Return to Clips. Scene one keeps the original, and scene two holds the variation.",
      ),
    ],
  ),
  lesson(
    "06-scenes",
    "Perform with scenes",
    "Launch a breakdown and return on bar boundaries.",
    "Scene 1 contains drums and synth. Scene 2 contains the drum variation only.",
    [
      step(
        "Set launch timing",
        "MENU → Preferences: set Launch timing to Bar. Back in Clips, scene launch buttons sit on the left.",
        ["menu", "screen"],
        "Open Menu, then Preferences, and set Launch timing to Bar. Back in Clips, use the scene launch buttons on the left.",
      ),
      step(
        "Launch the first scene",
        "Choose Intro ▷. The drums and synth play together.",
        ["screen"],
        "Launch Intro. Your drums and synth play together.",
      ),
      step(
        "Queue a breakdown",
        "Choose Verse ▷ while playing. The launch waits for the bar.",
        ["screen"],
        "Launch Verse while playing. The change waits for the next bar.",
      ),
      step(
        "Leave some space",
        "An empty synth slot stops that track; the drum variation continues.",
        ["screen"],
        "Verse has an empty synth slot, so that track stops. The drum variation keeps playing.",
      ),
      step(
        "Bring the theme back",
        "Launch Intro again. Both original parts return at the next bar.",
        ["screen"],
        "Launch Intro again. Both original parts return at the next bar.",
      ),
      step(
        "Stop the performance",
        "STOP ends playback. Your clips remain ready for another pass.",
        ["stop"],
        "Press Stop. You have made a breakdown and return. Next, put them in a song chain.",
      ),
    ],
  ),
  lesson(
    "07-song",
    "Arrange a short song",
    "Order scenes into Intro → Verse → Intro.",
    "Continue the two-scene project.",
    [
      step(
        "Open Song chain",
        "MENU → Song chain shows the arrangement.",
        ["menu", "screen"],
        "Open Menu, then Song chain. This list sets the order of your scenes.",
      ),
      step(
        "Add the opening",
        "Choose Intro, then Append scene. Each block shows its bar range.",
        ["screen"],
        "Choose Intro and Append scene. The block shows its bar range.",
      ),
      step(
        "Add the breakdown",
        "Choose Verse, then Append scene.",
        ["screen"],
        "Choose Verse, then Append scene. This is your drum only section.",
      ),
      step(
        "Bring Intro back",
        "Append Intro again. Tap Repeats to extend a block.",
        ["screen"],
        "Append Intro again. Tap Repeats when you want to extend a block.",
      ),
      step(
        "Play the arrangement",
        "PLAY START follows the blocks in order.",
        ["play-start"],
        "Press Play Start. XMP follows the blocks in order.",
      ),
      step(
        "Shape the order",
        "STOP. Use arrows to reorder; Remove shortens the chain. UNDO restores.",
        ["stop", "undo", "screen"],
        "Press Stop. Use arrows to reorder, or Remove to shorten the chain. Undo restores an edit.",
      ),
    ],
  ),
  lesson(
    "08-mix",
    "Make room in the mix",
    "Balance levels and compare a muted part.",
    "Continue your song; choose the synth track.",
    [
      step(
        "Open the mixer",
        "MENU → Mixer. Select track 2, the synth.",
        ["menu", "screen"],
        "Open Menu, then Mixer. Select track two, your synth.",
      ),
      step(
        "Use direct values",
        "Tap the synth Level to open its numeric editor.",
        ["screen"],
        "Tap the synth Level. Displayed values open a numeric editor.",
      ),
      step(
        "Lower the synth",
        "Enter 55 and Apply. The fader follows the stored level.",
        ["screen", "q1"],
        "Enter fifty five, then Apply. The fader follows the stored level.",
      ),
      step(
        "Listen together",
        "PLAY START. Keep the drums clear without hiding the melody.",
        ["play-start"],
        "Press Play Start. Keep the drums clear without hiding the melody.",
      ),
      step(
        "Compare with mute",
        "Tap M on the synth, then tap it again to bring the part back.",
        ["screen"],
        "Tap M on the synth to mute it. Tap again to bring the part back.",
      ),
      step(
        "Keep the balance",
        "STOP with the synth unmuted. Effects & returns opens the next layer.",
        ["stop", "screen"],
        "Press Stop with the synth unmuted. Effects and returns opens the next layer of sound shaping.",
      ),
    ],
  ),
  lesson(
    "09-record",
    "Play notes into a loop",
    "Record pad hits as one undoable pass.",
    "Select the drum clip in Intro. This records notes, not audio inputs.",
    [
      step(
        "Choose your clip",
        "MAIN → drum clip in Intro → SHIFT + MAIN for Play.",
        ["main", "shift"],
        "Select the drum clip in Intro. Shift and Main opens Play. This records notes, not audio input.",
      ),
      step(
        "Arm recording",
        "With playback stopped, press REC.",
        ["rec"],
        "With playback stopped, press Record to arm a pass.",
      ),
      step(
        "Start the loop",
        "PLAY START begins playback and records new pad hits.",
        ["play-start"],
        "Press Play Start. New pad hits are added to the selected clip.",
      ),
      step(
        "Add a few hits",
        "Play pad 4 twice. The existing kick, snare and hats stay in place.",
        ["pad-4"],
        "Play pad four a couple of times. The existing kick, snare, and hats stay in place.",
      ),
      step(
        "Finish the pass",
        "STOP commits the captured notes as one edit.",
        ["stop"],
        "Press Stop to commit the captured notes as one edit.",
      ),
      step(
        "Try another take",
        "UNDO removes the pass. OVER DUB adds to a clip that is already playing.",
        ["undo", "overdub"],
        "Undo removes the pass. Overdub adds to a clip that is already playing.",
      ),
    ],
  ),
  lesson(
    "10-library",
    "Change the whole drum kit",
    "Replace a track’s kit while keeping its pattern.",
    "Continue with the drum track; the lesson uses original XMP sounds.",
    [
      step(
        "Choose the drum track",
        "Press A. SHIFT + MENU opens Browse with a visible load target.",
        ["bank-a", "shift", "menu"],
        "Press A for the drum track. Shift and Menu opens Browse. Check the load target.",
      ),
      step(
        "Open Kits",
        "Choose the Kits tab. Loading creates this track’s own kit.",
        ["screen"],
        "Choose Kits. Loading creates this track’s own kit, protecting the other tracks.",
      ),
      step(
        "Choose XMP 808",
        "Load the original XMP 808 kit onto the drum track.",
        ["screen"],
        "Load the original XMP eight oh eight kit onto the drum track.",
      ),
      step(
        "Check the result",
        "Return to Sound. The pad names change; clip notes stay in place.",
        ["screen"],
        "Return to Sound. Pad names change, while the clip notes stay in place.",
      ),
      step(
        "Hear the new kit",
        "SHIFT + MAIN opens Play. Tap a pad to audition it.",
        ["shift", "main", "pad-1"],
        "Shift and Main opens Play. Tap a pad to audition the new kit.",
      ),
      step(
        "Compare and keep",
        "UNDO restores the old kit. Package samples when saving your choice.",
        ["undo"],
        "Undo restores the old kit. Package samples when saving the version you want to keep.",
      ),
    ],
  ),
  lesson(
    "11-sampling",
    "Trim and shape a sample",
    "Edit a pad’s audio and keep it as one undoable change.",
    "Use the drum track. This lesson edits an existing original sound, with no microphone or hardware recording.",
    [
      step(
        "Choose the sound",
        "MENU → Sound. Choose pad 2, then Edit sample.",
        ["menu", "screen"],
        "Open Menu, then Sound. Choose pad two and Edit sample. This edits existing audio.",
      ),
      step(
        "Read the waveform",
        "Start and End define the audio you keep. Changes are still a draft.",
        ["screen"],
        "Start and End define the audio you keep. Your changes are still a draft.",
      ),
      step(
        "Shorten the tail",
        "Tap End, enter a smaller frame count, then Apply.",
        ["screen"],
        "Tap End. Enter a smaller frame count, then Apply to shorten the tail.",
      ),
      step(
        "Shape the edge",
        "Tap Fade / reverse, then set Fade out to 10 ms. Tune, reverse and slices are also available.",
        ["screen"],
        "Tap Fade and reverse, then set Fade out to ten milliseconds. Tune, reverse, and slices are also available.",
      ),
      step(
        "Listen before keeping",
        "Audition previews the draft. Keep to pad assigns it to the selected pad.",
        ["screen"],
        "Audition previews your draft. Keep to pad assigns the result to the selected pad.",
      ),
      step(
        "Keep or undo",
        "Keep to pad commits one change. UNDO restores the original sound.",
        ["screen", "undo"],
        "Keep to pad commits one change. Undo restores the original. On the Live, input recording is a separate workflow.",
      ),
    ],
    common +
      " Sample uses the shared native touchscreen in the browser, emulator and Live. During playback, Record captures a four-bar input loop from the next bar. The video edits existing audio and does not demonstrate a live input take.",
  ),
  lesson(
    "12-save-export",
    "Save the song and its sound",
    "Reopen a portable project and export scene audio.",
    "Stop playback before saving. Keep an editable project as well as a listening file.",
    [
      step(
        "Open Project & files",
        "MENU → Project & files. Save the song as well as its audio.",
        ["menu", "screen"],
        "Press Stop and open Project and files. Save the editable song as well as its audio.",
      ),
      step(
        "Include the samples",
        "Keep Package samples with song checked for a self-contained project.",
        ["screen"],
        "Keep Package samples with song checked. Your project will include the sounds it needs.",
      ),
      step(
        "Save the project",
        "Save portable project downloads a .xmpsong backup.",
        ["screen"],
        "Save portable project downloads your song backup.",
      ),
      step(
        "Open the saved copy",
        "Open project → choose that .xmpsong file. Notes and sounds return together.",
        ["screen"],
        "Open the saved project. Check that the notes and sounds return together.",
      ),
      step(
        "Export scene audio",
        "Export current scene WAV renders the focused scene, not the full chain.",
        ["screen"],
        "Export current scene wave makes a listening file for the focused scene, not the full song chain.",
      ),
      step(
        "Keep both files",
        "The project stays editable; the WAV is ready to listen to or share.",
        ["screen"],
        "Keep both files: the editable project and the listening wave. Now make your own version.",
      ),
    ],
    common +
      " Browser saves download a portable project. Native project files and autosave use the owner’s stick. WAV export shown here is the browser’s current-scene export.",
  ),
  lesson(
    "13-drum-sounds",
    "Swap one drum sound",
    "Replace the snare with a handclap without changing the rhythm.",
    "Download the guide’s original Handclap WAV into a small folder.",
    [
      step(
        "Choose the target",
        "A → MENU → Sound → pad 2, Snare. Check the selected pad.",
        ["bank-a", "menu", "screen"],
        "Choose the drum track. In Sound, choose pad two, Snare. Check the selected pad.",
      ),
      step(
        "Replace this sample",
        "Replace sample opens Browse, retaining track 1 and pad 2 as the target.",
        ["screen"],
        "Replace sample opens Browse and keeps track one, pad two as the target.",
      ),
      step(
        "Find the handclap",
        "Choose folder → the Handclap.wav folder. Search Handclap, then select it.",
        ["screen"],
        "Choose the folder containing Handclap wave. Search for Handclap, then select it. Selecting alone does not load it.",
      ),
      step(
        "Load to pad 2",
        "Load to pad 2. The track gets its own kit; other tracks stay unchanged.",
        ["screen"],
        "Load to pad two. The track gets its own kit, and the other tracks stay unchanged.",
      ),
      step(
        "Compare the sound",
        "Listen: original snare first, then handclap. The notes are identical.",
        ["play-start"],
        "Listen to the original snare first, then the handclap. Both play exactly the same notes.",
      ),
      step(
        "Undo and redo",
        "UNDO restores the snare; SHIFT + UNDO brings back the clap. Save with samples.",
        ["undo", "shift"],
        "Undo restores the snare. Shift and Undo brings back the clap. Save with samples packaged.",
      ),
    ],
  ),
  lesson(
    "14-synth-sounds",
    "Choose a synth sound",
    "Use the current Device Sound page to change presets.",
    "Choose the synth track from your groove. No separate Studio editor is needed.",
    [
      step(
        "Choose the synth track",
        "B → MENU → Sound. Check that the instrument is Subtractive synth.",
        ["bank-b", "menu", "screen"],
        "Choose track two and open Sound. Check that its instrument is Subtractive synth.",
      ),
      step(
        "Explore Sound",
        "A synth's Sound page has two tabs: Presets shows the preset pads; Controls shows oscillator, filter and envelope.",
        ["screen"],
        "A synth's Sound page has two tabs. Presets shows the preset pads; Controls shows the oscillator, filter, and envelope.",
      ),
      step(
        "Try Warm bass",
        "Choose Warm bass. The preset changes the sound, leaving clip notes untouched.",
        ["screen"],
        "Choose Warm bass. The sound changes while the clip notes stay untouched.",
      ),
      step(
        "Try Bright lead",
        "Choose Bright lead. Its filter and envelope give the same melody a new character.",
        ["screen"],
        "Choose Bright lead. The filter and envelope give the same melody a different character.",
      ),
      step(
        "Hear the difference",
        "Listen: Warm bass first, then Bright lead, playing the same isolated melody.",
        ["play-start"],
        "Listen to Warm bass first, then Bright lead. Both play the same isolated melody.",
      ),
      step(
        "Make it yours",
        "Choose Controls, then tap Tone for a direct value edit. Save the project to keep notes and sound.",
        ["screen"],
        "Choose Controls, then tap Tone to type a value. Save the project to keep your notes and sound together.",
      ),
    ],
  ),
];
lessons[12].listeningSeconds = 4.65;
lessons[13].listeningSeconds = 4.65;

lessons[8].live =
  common +
  " Browser REC → PLAY START → pads → STOP adds one undoable pass. Native empty-slot REC includes a one-bar count-in; for an existing playing clip use OVER DUB, then finish with REC or OVER DUB.";
lessons[9].live =
  common +
  " The browser supplies bundled original kits. Native Browse scans bounded WAV/kit/project metadata under the configured USB-stick library root; available kit files depend on that library.";
lessons[12].live =
  common +
  " The browser chooses a local WAV folder. Native Browse uses project samples and its configured stick library. Loading isolates the target track’s kit; auditioning alone never replaces the sound.";
