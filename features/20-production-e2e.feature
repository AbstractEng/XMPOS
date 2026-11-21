@production_e2e @browser_e2e @implemented @standalone
Feature: Everyday music production through the built Device view
  These journeys use visible browser controls, real IndexedDB, the real Web Audio
  implementation with hardware output disabled, and downloaded projects and WAVs.
  They do not qualify physical audio, MIDI devices or MPC hardware.

  Background:
    Given I start a new empty song in an isolated browser

  @E01 @positive
  Scenario: Make a drum loop from my sample library and export audio
    When I index an original three-sound WAV folder and load kick, snare and hat to pads
    And I program a one-bar drum beat at 120 BPM
    And I play the loop and stop it using the front panel
    Then the portable song contains the programmed hits and imported samples
    And the current scene downloads as a non-silent 48 kHz stereo WAV

  @E02 @positive
  Scenario: Layer a synth bass and create a chorus variation
    When I build a drum beat and add a pitched synth loop on track 2
    And I copy that loop to scene 2 and add a higher note
    Then the verse and chorus retain different notes and the same synth machine
    When I undo and redo the chorus edit
    Then the chorus variation is restored without changing the drum beat

  @E03 @positive
  Scenario: Arrange verse and chorus clips into a complete song
    When I build a drum beat and add a pitched synth loop on track 2
    And I copy that loop to scene 2 and add a higher note
    And I arrange scene 1, scene 2 and scene 1 as three song occurrences
    And I play the Song chain to its end
    Then the clock crosses all three bars and playback stops automatically
    And the saved arrangement retains the three occurrences in order

  @E04 @positive
  Scenario: Balance a track and export a muted alternative
    When I index an original three-sound WAV folder and load kick, snare and hat to pads
    And I program a one-bar drum beat at 120 BPM
    And I export the scene at full and half drum-track level
    Then the half-level bounce has half the amplitude and the same duration
    When I mute the drum track and export the scene again
    Then the muted bounce is silent and unmuting restores the previous mix

  @E05 @positive
  Scenario: Resume an autosaved idea and transfer it to a fresh browser
    When I build a drum beat and add a pitched synth loop on track 2
    And I wait for autosave and reload the app
    Then the restored song retains its samples, machines and notes
    When I download the song and open it in a second empty browser
    Then the second browser has the same playable song without the source folder

  @E06 @negative
  Scenario: Undo a destructive edit and reject a damaged project without losing work
    When I index an original three-sound WAV folder and load kick, snare and hat to pads
    And I program a one-bar drum beat at 120 BPM
    And I remove the drum clip and immediately undo it
    Then the complete song is unchanged
    When I try to open a portable project with a damaged sample hash
    Then an import error is visible and my current song is unchanged
    When I remove the drum clip again and undo it
    Then the complete song is restored

  @E07 @positive
  Scenario: Finger-drum a take and undo the whole take
    When I arm recording and play two different pads during playback
    And I stop to commit the take
    Then both recorded sounds are saved in the focused clip
    When I undo the recording and redo it
    Then the whole take is removed and restored as one edit

  @E08 @positive
  Scenario: Keep the screen and transport visible and follow a queued scene
    When I open Device's screen view at 1280 by 800
    And I launch Intro and queue Verse using the four-bar launch grid
    Then the queued marker becomes the playing marker without redrawing the grid

  @E09 @positive
  Scenario Outline: Show the custom boot artwork before <workspace> is ready
    When I load the <workspace> browser workspace with startup scripts paused
    Then the approved startup artwork is visible until the workspace is ready
    Examples:
      | workspace |
      | Device    |
      | Studio    |

  @E10 @positive
  Scenario: Match the Live Mk1 controls around the same touchscreen workspace
    When I open Device with the Live Mk1 layout
    Then its shortcuts and transport match the Mk1 stacks in both browser layouts
