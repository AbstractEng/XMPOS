@device_workflow @implemented @standalone
Feature: Build a clip-based song with shared actions and the Live Mk1 panel
  Browser controls and native controls run in software-only hosts. No hardware adapter is used.
  Pads are numbered 1–4 across the bottom and 13–16 across the top.
  Software transport steps and clip offsets in the regression scenarios are zero-based.

  Background:
    Given a fresh Device song with a software-only sequencing transport

  @D01 @positive
  Scenario: Navigate with the Live Mk1 controls without starting audio
    When I press MAIN
    Then the Clips home is displayed
    When I press SHIFT and MENU
    Then the Sample library is displayed without changing the song
    When I press SHIFT and MAIN
    Then the Play machine page is displayed
    When I press MENU and turn the data dial to Song and press it
    Then the Song page is displayed without opening audio

  @D02 @positive
  Scenario: Get a drum track going using the whole indexed sample library
    When I press SHIFT and MAIN and choose the Pad sampler machine for track 1
    And I press SHIFT and MENU and choose a Mac folder containing 40 WAV sounds
    Then all 40 folder sounds are searchable without reading their audio
    When I search for "Library Hit 39" and load it to pad 1
    Then only the selected WAV is read and pad 1 uses that sound
    When I press MAIN and select the first track in the fifth scene
    And I press the data dial to create a clip
    And I choose pad 1 and enable steps 1, 5, 9 and 13
    And I press PLAY START
    Then that track plays a one-bar clip containing four hits
    When I press STOP
    Then playback stops and the queued launches are cleared

  @D03 @positive
  Scenario: Layer a second machine and copy a variation without replacing its machine
    When I choose a synth machine on track 2 and program a pitched loop
    And I press COPY and choose the second scene for that track
    Then the copy is applied immediately as one undoable edit
    Then the copied notes retain their pitch and the destination machine remains the synth
    When I press UNDO
    Then the destination scene is restored

  @D04 @positive
  Scenario: Launch clips independently at the next bar and stop an empty track slot
    When I press PLAY START and advance the software clock to step 3
    And I launch the first track's clip in scene 2
    Then the old clip plays until the next bar
    And the new clip begins at the bar without restarting track 2
    When I launch an empty slot for track 2
    Then track 2 stops at the next bar while track 1 continues

  @D05 @positive
  Scenario: Turn scenes into a portable song and render it offline
    When I add scene 1, scene 2 and scene 1 again to the Song chain
    And I press PLAY START on the Song page
    Then the occurrences play in that order and stop at the end
    And a portable save and reopen retains the clips, machines and song order
    And the song renders finite nonzero stereo audio without opening hardware

  @D06 @positive
  Scenario: Verify the visible default panel and bottom-left pad numbering
    When the browser panel and default-entry contracts are exercised
    Then Device view opens by default with 22 front buttons and pad 1 at the bottom left

  @D07 @negative
  Scenario: Reject stale loads and delayed audio starts after cancellation
    When the asynchronous loading and transport cancellation contracts are exercised
    Then canceled work cannot alter the project or start late audio

  @D08 @positive
  Scenario: Keep machine controls extensible and record an undoable pitched take
    When machine metadata, clip copying and recording contracts are exercised
    Then per-track machine state, notes and Undo remain consistent

  @D09 @control_regression @positive
  Scenario: Open Steps with 16 LEVEL without editing the song or enabling audio
    When I press the 16 LEVEL button
    Then the selected clip is open in Steps with the project unchanged and audio unopened

  @D10 @control_regression @positive
  Scenario Outline: Overdub the audible clip while another clip is only queued
    Given an existing drum pattern and a different variation
    When I start the pattern and queue the variation before its launch bar
    And I engage live OVER DUB
    And I play pad 8 at software transport step 5
    And I finish the pass with "<button>"
    Then only the audible pattern contains the new pad 8 hit at clip offset 5
    And the transport has not stopped or restarted
    And one UNDO restores the previous project and REDO restores the change

    Examples:
      | button   |
      | OVER DUB |
      | REC      |

  @D11 @control_regression @positive
  Scenario: Record relative to a clip launched after the transport began
    Given an existing drum pattern and a different variation
    And the variation is 32 steps long
    When I launch the variation at software transport step 16
    And I engage live OVER DUB
    And I play pad 7 at software transport step 18
    And I finish the pass with "REC"
    Then the variation contains the pad 7 hit at clip offset 2 and not offset 18
    And the transport has not stopped or restarted

  @D12 @control_regression @positive
  Scenario: Reset the recording origin when restarting a previously launched clip
    Given an existing drum pattern and a different variation
    And the variation is 32 steps long
    When I launch the variation at software transport step 16
    And I stop and arm REC and restart from the beginning
    And I play pad 7 at software transport step 2
    And I press STOP
    Then the variation contains the pad 7 hit at clip offset 2 and not offset 18

  @D13 @control_regression @positive
  Scenario: Preserve a take containing repeated hits on an occupied drum cell
    Given an existing drum pattern and a different variation
    When I play the pattern and record its occupied kick twice and a new pad hit
    Then the kick cell still contains exactly one hit and the new hit is retained
    And one UNDO restores the previous project and REDO restores the change

  @D14 @control_regression @negative
  Scenario: End a pass when its audible clip changes without writing into the next clip
    Given an existing drum pattern and a different variation
    When I overdub a hit and the queued variation launches during the pass
    Then the old pattern keeps its captured hit and the new clip remains unchanged
    And the recording pass is finished while playback continues

  @D15 @control_regression @positive
  Scenario: Copy into a slot whose old clip is reused by another scene
    Given an existing drum pattern and a different variation
    And two scenes reference the same variation clip
    When I copy the pattern into the first variation slot and confirm
    Then the destination has an independent copy and the other scene keeps its original variation
    And the source clip and destination instrument are unchanged
    And one UNDO restores the previous project and REDO restores the change

  @D16 @control_regression @negative
  Scenario: Refuse copying into a full track without changing any clip or undo history
    Given an existing drum pattern and a different variation
    And the drum track already contains sixteen clips
    When I try to copy the pattern into the variation slot
    Then the copy is refused with the project and undo history unchanged

  @D17 @control_regression @native_controls @host_only @positive
  Scenario Outline: Copy a native clip without launching it or changing reused clips
    Given the native Live controls are running in a memory-only host
    And two native scenes reference the same variation clip
    When I copy the focused native clip using "<gesture>"
    Then the native destination is independent and the reused clip and instrument stay unchanged
    And native copying has not requested transport playback
    And native UNDO and REDO restore the complete projects before and after the copy

    Examples:
      | gesture             |
      | COPY then target    |
      | hold COPY and pads  |

  @D18 @control_regression @native_controls @host_only @negative
  Scenario: Refuse a native copy into a full track atomically
    Given the native Live controls are running in a memory-only host
    And the native track already contains sixteen clips
    When I copy the focused native clip using "COPY then target"
    Then native copying is refused with the project and undo history unchanged

  @D19 @control_regression @native_controls @host_only @positive
  Scenario: Delete a native slot without deleting its reusable clip data
    Given the native Live controls are running in a memory-only host
    When I unlink the native variation slot with SHIFT and COPY
    Then only that scene slot is removed and the reusable clip data is retained
    And native UNDO restores the complete original project

  @D20 @control_regression @native_controls @host_only @positive
  Scenario: Browse project sounds even if SHIFT is released before MENU
    Given the native Live controls are running in a memory-only host
    And the native kit track shares its pads with another track
    And the second native project sound has four frames at 24 kHz
    When I open native Steps then press SHIFT and MENU and release SHIFT first
    Then native Browse is displayed with its own sample and target-pad knob labels
    When I select the second project sound and pad 4 and press SHIFT and PLAY
    Then the selected sound is previewed without changing the project or requesting transport playback
    When I press the native data wheel to load the sound
    Then only the target track gets its own kit with that sound on pad 4
    And native UNDO and REDO restore the complete projects before and after the sound load
    When I close native Browse with SHIFT and MENU
    Then native Steps is displayed again

  @D21 @control_regression @native_controls @host_only @negative
  Scenario: Refuse loading a project sample into a native synth track
    Given the native Live controls are running in a memory-only host
    When I browse a sound and try to load it onto the native synth track
    Then native sample loading is refused with the project and undo history unchanged
