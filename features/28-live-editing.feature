@implemented @standalone @live_editing
Feature: Hear edits immediately and work across the whole clip
  All scenarios run the production C++ Workbench, player and DSP in memory.
  PCM is rendered silently; no audio, MIDI or physical device is opened.

  Scenario Outline: Continue making music while changing the instrument
    When the live editing case "<case>" is exercised in the shared Device host
    Then the host verifies "<behavior>" without restarting playback

    Examples:
      | case       | behavior                                      |
      | machine    | a newly chosen synth plays distinct pitches    |
      | continuity | an unrelated sounding drum remains unchanged   |
      | effect     | an inserted effect processes a sounding voice  |
      | bars       | bar navigation and audible playhead follow     |
      | length     | custom lengths and the last partial bar        |
      | tempo      | live tempo preview and Cancel restoration      |
      | tap        | quarter-note taps set the displayed tempo      |
      | fader      | halfway travel gives useful audio attenuation  |
      | lights     | transport, bank, velocity and pad playhead LEDs |
      | summaries | note counts update after edits, erase, undo and redo |
      | song-play | Play enters the selected song block during playback |
      | playing-range | returning tracks restore their own octave and musical key |
      | effect-controls | effect Q-Links use milliseconds and tempo-synced divisions |
      | keyboard-naming | keyboard text shares Apply and Cancel with the native naming sheet |
      | take-editor | a new take opens on a bar and pitch containing recorded notes |
