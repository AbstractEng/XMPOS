@P08 @desktop @os_vm @usb_lab
Feature: Mix, synchronize and exchange complete musical work

  @planned @stage_gate @positive
  Scenario: Mix a song and exchange audio and MIDI with another workstation
    Given a song uses eight tracks, two inserts per track and two shared sends
    And an explicitly approved MIDI fixture is connected
    When the musician synchronizes playback, mixes the song and exports WAV and MIDI files
    Then the WAV contains the expected routing, automation and effect tails
    And reimporting the MIDI reproduces note positions, lengths and tempo information

  @P08_1 @implemented @positive
  Scenario: Mix track levels, stereo position and shared sends
    Given test tones are assigned to distinct tracks and known pan positions
    When the musician changes volume, pan and send levels
    Then measured channel levels match the declared pan law and gain mapping
    And the master meter reflects the actual routed output

  @P08_1 @implemented @negative
  Scenario: Reject an unsupported feedback route
    Given a route would create an unqualified cycle in the audio graph
    When the musician attempts to connect it
    Then the route is rejected before replacing the active graph
    And playback continues through the previous valid routing

  @P08_2 @implemented @positive
  Scenario: Recall effect chains with automation and tail state rules
    Given a chain contains EQ, filter, delay, reverb, distortion and compressor fixtures
    When the musician saves and reloads its presets and automates bypass
    Then each effect matches its reference response within its declared tolerance
    And bypass and tail behavior match the documented transition policy

  @P08_2 @implemented @negative
  Scenario: Contain an invalid DSP parameter or oversized effect allocation
    Given an effect receives a non-finite parameter or requests a delay beyond its memory budget
    When the engine validates that change
    Then the effect change is rejected or safely bypassed without non-finite output
    And unrelated tracks continue within the callback budget

  @P08_3 @planned @positive @midi_fixture
  Scenario: Synchronize an explicitly selected external MIDI fixture
    Given the musician has selected approved input and output ports without any Force port
    When the musician starts, changes tempo and stops under the declared clock-master mode
    Then the external fixture follows transport and tempo within the profile timing limits
    And captured MIDI events include the intended notes and final note cleanup

  @P08_3 @planned @negative @midi_fixture
  Scenario: Reconnect without sending notes to an unintended device
    Given the selected MIDI fixture is playing sustained notes
    When it disconnects and another MIDI device occupies its previous port position
    Then the old route is invalidated rather than reassigned by list position
    And output remains disabled until the intended fixture is explicitly revalidated

  @P08_4 @implemented @positive
  Scenario: Export deterministic scene and song files
    Given a song has a seeded probability trace, tempo changes and a final reverb tail
    When the musician exports the selected scene and the entire song
    Then the stereo WAV headers, durations, event alignment and tails match the export contract
    And the MIDI export preserves the supported notes, velocities and tempo map

  @P08_4 @implemented @negative
  Scenario: Preserve existing exports when rendering or storage fails
    Given a valid export already exists at the selected destination
    When a new export runs out of storage or the musician declines overwrite
    Then the previous valid file remains unchanged
    And partial output is removed or clearly identified without a success message

  @P08_2 @implemented @positive @instrument_design
  Scenario: Play a rhythmic effect preset in time with the song
    Given a declared effect preset uses a sixteenth-note filter sequence and eighth-note delay
    When the musician changes tempo at an acknowledged bar boundary and records a macro gesture
    Then sequence ticks and delay divisions follow the engine's musical clock under the preset's phase policy
    And the saved preset and gesture reproduce the same offline response within the declared tolerance

  @P08_2 @implemented @negative @instrument_design
  Scenario: Keep a synchronized effect bounded when its clock source disappears
    Given an effect follows an explicitly selected clock source
    When that source disappears during a sustained note
    Then the effect follows its documented hold-last-tempo or stop policy without an implicit port switch
    And all output remains finite and panic still releases the note within the declared limit

  @implemented @software_gate @positive @virtual_fixture
  Scenario: Mix and exchange an eight-track song with virtual MIDI on the Mac
    Given a Mac song uses eight tracks, two inserts per track and two stereo send returns
    And the MIDI adapter is a named virtual fixture with no physical ports
    When the Mac renders the song and exchanges its notes and tempo map
    Then the routed stereo worklet matches offline audio and note frames exactly
    And the virtual exchange preserves supported musical data without device operations

  @P08_3 @implemented @positive @virtual_fixture
  Scenario: Synchronize the explicitly selected virtual MIDI fixture
    Given approved virtual input and output identities are selected
    When the virtual master starts, changes tempo at a bar and stops a sustained note
    Then its capture has twenty-four clocks per quarter and correctly timed transport and cleanup
    And the result declares physical MIDI timing unqualified

  @P08_3 @implemented @negative @virtual_fixture
  Scenario: Invalidate a virtual route after disconnect without index-based reassignment
    Given a selected virtual output owns a sustained note
    When it disconnects and another fixture takes its previous list position
    Then no packet reaches the replacement and the old route stays disabled
    And only explicit revalidation of the intended identities can restore output

  @P08_4 @implemented @positive @studio_ui
  Scenario: Edit a mix and stage MIDI through the Studio without opening audio
    Given the Studio is open with audio disabled
    When the musician enables stereo mixing, edits pan and an insert, and imports MIDI
    Then the clip replacement requires an explicit action and retains undo support
    And exporting MIDI or testing virtual clock never enables audio or physical MIDI
