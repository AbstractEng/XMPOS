@drum_kits @standalone @implemented
Feature: Play locally imported drum kits without losing the song

  @positive @cc0_assets
  Scenario Outline: Play a verified CC0 test kit using the existing song
    Given the original demo song and committed CC0 kit catalog
    When the musician loads bundled CC0 kit "<kit>"
    Then its <count> assigned pads render finite nonzero audio and its licenses are retained
    And the patterns, scenes, tempo and track machines are unchanged
    And a portable project retains the kit and one Undo restores the original pad bank
    Examples:
      | kit                 | count |
      | cc0-octal-deep      | 12    |
      | cc0-octal-punch     | 12    |
      | cc0-virtuosity      | 8     |

  @negative @cc0_assets
  Scenario: Reject a broken CC0 download and retain edits made during loading
    Given isolated Studio kit controls with browser storage and audio hardware disabled
    When CC0 integrity failures and edits during download are exercised
    Then the current project survives corrupt downloads and stale kit loads

  @positive
  Scenario: Compare a drum kit using an existing pattern and undo the replacement
    Given a saved song and five named WAV one-shots in arbitrary file order
    When the musician loads those sounds as a single drum kit
    Then kick, snare, closed hat and open hat occupy the first four pads
    And unused kit pads render silence and the kick renders nonzero finite audio
    And the patterns, scenes, tempo and track machines are unchanged
    And a portable project retains the kit and one Undo restores the original pad bank

  @negative
  Scenario Outline: Reject an invalid kit without a partial replacement
    Given a saved song and five named WAV one-shots in arbitrary file order
    When a kit with <problem> is submitted
    Then the original song and undo history remain intact
    Examples:
      | problem               |
      | a corrupt WAV         |
      | seventeen sounds      |
      | excessive sample data |

  @positive @desktop
  Scenario: Import and switch kits using the Studio controls
    Given isolated Studio kit controls with browser storage and audio hardware disabled
    When the musician imports a kit, reloads the library and switches to the original kit
    Then the UI contract verifies persistence, pad assignment and Undo without opening a device

  @negative @desktop
  Scenario: Keep edits made while a kit is still being read
    Given isolated Studio kit controls with browser storage and audio hardware disabled
    When the musician edits the song during an asynchronous kit import
    Then the stale import cannot replace the song or add a kit to the library
