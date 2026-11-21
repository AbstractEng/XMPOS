@implemented @standalone @song_portability
Feature: Transfer songs between XMP OS installations
  A song carries musical state independently of host paths and library names.
  Packaged files are self-contained; referenced files require verified local audio.

  @browser_e2e
  Scenario: FP01 - Transfer a packaged song between Device view and Advanced Studio
    Given a song with clips, MIDI routing and an unavailable custom machine is open in Device view
    When I save the song with Package samples checked
    And I open that file in Advanced Studio in a clean browser profile
    Then the notes, scenes, machine state, sample aliases and rendered audio are unchanged
    When I save it in Advanced Studio and reopen it in another Device profile
    Then the same complete song and audio are restored without the original library

  @browser_e2e
  Scenario: FP02 - Relocate the audio for a song saved without samples
    Given a song with clips, MIDI routing and an unavailable custom machine is open in Device view
    When I save the song without packaging samples
    And I open the referenced song in a clean Device profile
    Then the missing sounds are listed and the current song is retained
    When I choose a different sound with the expected file name
    Then that sound is rejected and the current song is retained
    When I locate the matching WAV under a different file name
    Then the complete transferred song is restored with the correct audio

  @browser_e2e
  Scenario: FP03 - Reuse an installation's local sample library
    Given a song with clips, MIDI routing and an unavailable custom machine is open in Device view
    When I save the song without packaging samples
    And I reload that browser and open the referenced song
    Then the local sample library resolves the song without choosing files

  @browser_e2e
  Scenario: FP04 - Keep the active song when a transfer is corrupt
    Given a song with clips, MIDI routing and an unavailable custom machine is open in Device view
    When I open a song whose metadata checksum is invalid
    Then the corrupt transfer is rejected without changing the active song
    And a legacy project copy remains readable

  @os_vm @song_vm
  Scenario: FP05 - Transfer a browser song into Linux and bring a VM edit back
    Given a packaged song has been saved by the desktop Device browser
    And the offline Linux Device image is booted with no hardware access
    When I open the browser song through the VM's normal project file input
    Then the VM can export the same complete song and sample audio
    When I edit the drum clip using the VM's virtual controls
    And I transfer the edited song back to a clean desktop browser
    Then the desktop retains the VM edit and the remaining song state
    And invalid transfer chunks are rejected without opening a device or changing the song
