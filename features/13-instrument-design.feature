@instrument_design @standalone @implemented
Feature: Make musical intent clear without changing a musician's work

  @positive @groove_display
  Scenario Outline: Set musical swing and hear the expected pair ratio
    Given a single odd-sixteenth impulse at 120 BPM
    When the musician selects musical swing <percent> percent
    Then its exported onset is frame <frame> at 48000 Hz
    And the next bar remains at frame 96000 without changing velocities
    Examples:
      | percent | frame |
      | 50      | 6000  |
      | 62      | 7440  |
      | 75      | 9000  |

  @positive @groove_display
  Scenario: Select an exact triplet rather than a rounded percentage
    Given a single odd-sixteenth impulse at 120 BPM
    When the musician selects the exact triplet swing preset
    Then its exported onset is frame 8000 at 48000 Hz
    And the next bar remains at frame 96000 without changing velocities
    And the swing label is "66.7% · Triplet"

  @positive @groove_display
  Scenario: Reopen an older project without reinterpreting its swing
    Given a version-1 project with stored swing delay 0.5
    When the musician reopens it with the musical swing display
    Then the stored swing remains 0.5 and its label is "75%"
    And its odd sixteenth still starts at 0.1875 seconds at 120 BPM

  @negative @groove_display
  Scenario: Refuse invalid musical swing values without an edit
    Given a single odd-sixteenth impulse at 120 BPM
    When musical swing values below 50, above 75 or non-finite are submitted
    Then all changes are rejected and the original project is intact

  @positive @help_flow
  Scenario: Read contextual help without interrupting music
    Given the Studio runs in an isolated DOM with mocked audio and storage
    When the musician edits a pattern, queues a scene and requests swing help with F1
    Then Escape restores focus and music, undo, scene and transport state are unchanged
    And no audio device or physical transport was opened

  @negative @help_flow
  Scenario: Return safely when a control is replaced while help is open
    Given the Studio runs in an isolated DOM with mocked audio and storage
    When the musician opens help on a button and that control is replaced by a redraw
    Then help uses the focused topic and returns to a valid focus target
    And no audio device or physical transport was opened

  @positive @groove_display @help_flow
  Scenario: Change swing through the real Studio controls and undo it
    Given the Studio runs in an isolated DOM with mocked audio and storage
    When the musician selects Triplet, undoes it and sets 62 percent on the slider
    Then the labels and stored delays agree while all existing notes remain unchanged
    And no audio device or physical transport was opened
