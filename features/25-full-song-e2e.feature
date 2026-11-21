@browser_e2e @implemented @full_song @standalone
Feature: Build a complete song from a blank project in the browser
  The browser studio runs on XMP's C++ core in WebAssembly (docs/cpp-port.md,
  phase 9). These journeys build a song from nothing through the Device view,
  one track at a time, play it and keep it, and exercise the files the other
  journeys do not: the legacy copy and MIDI export and import.

  @F01 @positive @observe_audio
  Scenario: Build a four-track song one track at a time, play it, and keep it
    Given I start a new empty song in an isolated browser
    When I build track 1 as drums from my own WAV folder with a verse and a chorus beat
    And I build track 2 as a synth bass with a verse and a chorus line
    And I build track 3 as synth chords with a verse and a chorus part
    And I build track 4 as a synth lead with a verse and a chorus hook
    And I set the tempo and balance the four tracks in the mixer
    And I arrange verse, verse, chorus and verse as the song
    Then the saved song has all four tracks with their machines, clips and notes
    And the arrangement and the mix are saved
    When I play the song to its end
    Then the clock crosses every bar, audio is heard, and playback stops by itself
    And every track is audible on its own in the exported verse and chorus
    When I wait for autosave and reload the app
    Then the reloaded song is the same complete song
    When I download the song and open it in a second empty browser
    Then the second browser has the same complete song and it still plays

  @F02 @positive
  Scenario: Keep a legacy copy, and move a clip out and back as MIDI
    Given I start a new empty song in an isolated browser
    When I build track 1 as drums from my own WAV folder with a verse and a chorus beat
    And I build track 2 as a synth bass with a verse and a chorus line
    And I save a legacy copy
    Then the legacy copy opens to the same song
    When I open the song in Advanced Studio and export the scene as MIDI
    Then the MIDI file has the bass line's notes
    When I import that MIDI into the bass track's chorus clip
    Then the chorus clip holds the verse's bass line
