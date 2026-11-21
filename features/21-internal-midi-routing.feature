@midi_routing @browser_e2e @implemented @standalone
Feature: Hear MIDI clips through internal synth and sampler tracks
  Internal routing is a single hop to a built-in audio instrument.
  Physical MIDI, USB and audio output remain disabled in this browser suite.

  Background:
    Given I start a new empty song in an isolated browser

  @MR01 @positive
  Scenario: Compose a MIDI bass line using the built-in synth
    When I create a MIDI clip routed to a built-in synth track
    Then the routed clip produces real worklet audio and a non-silent scene WAV
    And its portable project retains the MIDI notes and destination
    When I clear the MIDI destination
    Then the same clip produces paired MIDI events and silent audio

  @MR02 @positive
  Scenario: Play an imported drum kit from a MIDI clip through the sampler
    When I load original drum samples and route a MIDI drum clip to the sampler
    Then the selected clip pads sound through the real worklet and exported WAV
    When I mute the sampler destination
    Then the MIDI clip is silent until I unmute that destination

  @MR03 @positive
  Scenario: Retain MIDI routing across reload and portable transfer
    When I create a MIDI clip routed to a built-in synth track
    And I autosave the routed project and reopen it in another empty browser
    Then the same destination, notes and sound are restored
    When I change the MIDI destination and undo that edit
    Then the original routed synth sound is restored

  @MR04 @negative
  Scenario: Keep unavailable and cyclic MIDI destinations silent without losing their state
    When I create a MIDI clip routed to a built-in synth track
    Then MIDI destinations offer only other built-in audio instrument tracks
    When I open a project whose saved MIDI destination is unavailable
    Then the route is shown as unavailable and the clip is silent
    When I open a project with a self-referencing MIDI destination
    Then the route is shown as unavailable and the clip is silent
    When I select a valid synth destination again
    Then the routed clip produces real worklet audio and a non-silent scene WAV
