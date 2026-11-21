@P07 @desktop @os_vm @usb_lab
Feature: Arrange and perform a song using one coherent scene and clip model

  @implemented @stage_gate @positive
  Scenario: Perform and reopen an eight-track sixteen-scene song
    Given a musician has eight tracks and sixteen scenes
    When the musician creates a scene chain with repeats, performs mutes and records macros
    And saves, closes and reopens the song
    Then the scene chain, clip selections and performance automation are preserved
    And replaying the song produces the expected transitions and event trace

  @P07_1 @implemented @positive
  Scenario: Launch a long clip from its first step on a new scene
    Given a sixteen-step clip is playing and the next scene selects a sixty-four-step clip
    When the musician queues that scene for the next bar
    Then the new clip starts from step zero at that boundary
    And independent clips on other tracks obey the declared restart or continue policy

  @P07_1 @implemented @negative
  Scenario: Cancel a queued launch and honor empty scene slots
    Given a scene launch is queued and another scene has an empty track slot
    When the musician cancels the queued launch and later launches the other scene
    Then the canceled launch never occurs
    And the empty slot follows the documented stop, continue or silence rule

  @P07_2 @implemented @positive
  Scenario: Replay a scene chain with mixed clip lengths
    Given a song contains sixteen-step and sixty-four-step clips and explicit scene repeat counts
    When the musician plays the song from its beginning
    Then scene changes occur at the expected absolute musical positions
    And the final scene follows the configured end or loop behavior

  @P07_2 @implemented @negative
  Scenario: Edit a song chain while its current scene is playing
    Given the current scene appears twice in the song chain
    When the musician removes the later occurrence and reorders a future scene
    Then the active scene completes under the documented edit-boundary policy
    And song position resolves to a valid next occurrence without a transport crash

  @P07_3 @implemented @positive
  Scenario: Perform track mutes and macros with predictable tails
    Given drum and synth tracks are playing through a shared delay send
    When the musician mutes the drum track, solos the synth and moves a macro
    Then newly triggered events and effect tails follow the documented mute and solo rules
    And the macro controls only its assigned parameter identities

  @P07_3 @implemented @negative
  Scenario: Remove a track referenced by a performance macro
    Given a performance macro controls parameters on a selected track
    When the musician deletes that track and later moves the macro
    Then stale assignments are removed or clearly marked unavailable
    And no other track receives the deleted track's control events

  @P07_4 @planned @positive
  Scenario: Complete the main music flow on a seven-inch layout
    Given the interface is displayed at the target device's verified resolution
    When a musician browses a sound, edits a pattern, launches a scene and opens the mixer
    Then every primary control remains visible, focusable and reachable without overlapping targets
    And pad, encoder and transport actions retain consistent meanings across views

  @P07_4 @planned @negative
  Scenario: Recover from an error dialog during performance
    Given a musician is performing with a hardware control focused on a track parameter
    When a sample import fails and its error dialog is dismissed
    Then focus returns to a valid control with an explicit parameter assignment
    And the next encoder action cannot accidentally alter a different track

  @P07_4 @planned @positive @instrument_design
  Scenario: Read help during performance and return to the same musical control
    Given a musician is playing a scene with a sound parameter focused
    When the musician requests contextual help using the target's documented Help action
    And closes help after a view redraw
    Then the engine clock, queued scene, project revision and undo history are unchanged
    And focus returns to the original control identity or an explicit safe fallback
    And the next encoder movement cannot change a different track's parameter

  @P07_4 @implemented @positive @preview_profile
  Scenario: Navigate the declared Mac preview views with virtual controls
    Given Studio runs in an isolated DOM under the declared Mac preview profile
    When the musician browses a sound, edits notes, selects a scene and opens Mix in the preview
    Then the primary preview controls retain their view and parameter identities
    And no hardware display or input capability is inferred from the DOM check

  @P07_4 @implemented @negative @preview_profile
  Scenario: Restore or safely clear a virtual encoder assignment after an import error
    Given Studio runs in an isolated DOM under the declared Mac preview profile
    When a sample import fails while a virtual track encoder is assigned and views redraw
    Then dismissal restores the same parameter or explicitly clears the unavailable assignment
    And the next virtual encoder movement cannot alter another track

  @P07_4 @implemented @positive @preview_profile
  Scenario: Read help after a redraw without changing preview performance state
    Given Studio runs in an isolated DOM under the declared Mac preview profile
    When the musician requests Help on a focused sound parameter and closes it after a redraw
    Then the clock anchor, queued launch, project revision and undo depths are preserved
    And focus and the next virtual encoder action retain their original parameter identity

  @P07_4 @implemented @positive @manual_layout @preview_profile
  Scenario: Audit primary targets in the actual 1280 by 800 Mac browser viewport
    Given a current-source browser audit of the declared Mac performance layout
    When the primary target rectangles are checked across Play, Sounds, Pattern, Perform and Mix
    Then measured targets are reachable without overlap and have visible focusable controls
    And the audit keeps physical display and hardware control qualification pending
