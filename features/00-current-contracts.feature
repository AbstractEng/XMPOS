@regression @standalone @implemented
Feature: Verify the implemented desktop-independent musical and access contracts
  These executable contracts prove only the behavior they assert.
  They do not mark any complete V1 stage or hardware adapter as implemented.

  @P03_1 @positive
  Scenario: Round-trip a project with its embedded samples
    Given a current demo project
    When I serialize and reopen the project
    Then all project values and embedded sample values match

  @P03_1 @negative
  Scenario Outline: Reject unsupported project versions
    Given a current demo project
    When I open it with project version <version>
    Then project validation fails
    And the original project remains unchanged
    Examples:
      | version |
      | 0       |
      | 999     |

  @P03_3 @negative
  Scenario: Reject an unresolved sample reference
    Given a current demo project
    When I open a copy referencing an absent sample
    Then project validation fails
    And the original project remains unchanged

  @P06_1 @positive
  Scenario: Edit a step without mutating the previous project
    Given a current demo project
    When I enable pad 6 on step 4 of the first clip
    Then that event exists only in the edited project

  @P06_2 @positive
  Scenario: Compute swing without accumulating bar drift
    Given a current demo project
    When I calculate 16 steps at 120 BPM with swing 0.5
    Then the next bar starts at exactly 2 seconds
    And the second step starts at exactly 0.1875 seconds

  @P06_2 @negative
  Scenario: Probability zero never emits an event
    Given a current demo project
    When all events in the first clip have probability zero
    Then the first scene emits no events across 64 steps

  @P07_3 @positive
  Scenario: Muting a track suppresses its sequenced events
    Given a current demo project
    When I mute the drum track
    Then the first scene emits no events across 64 steps

  @P08_4 @positive
  Scenario: Encode bounded stereo PCM audio
    Given left audio samples -2 and 0.5 and right audio samples 2 and -0.5
    When I encode a stereo WAV at 48000 Hz
    Then the WAV has two channels and two frames at 48000 Hz
    And the first stereo frame is clamped to -32768 and 32767

  @P09_1 @negative
  Scenario Outline: Reject physical-device permissions in a preview module
    Given a valid preview instrument manifest
    When I add the permission "<permission>"
    Then module validation fails before any module execution
    Examples:
      | permission |
      | usb-write  |
      | midi-send  |
      | shell      |

  @P02_2 @positive
  Scenario: Standalone preflight never constructs a physical transport
    Given a target request for the standalone profile
    When target preflight and opening are attempted with a counted transport factory
    Then standalone preflight succeeds
    And the transport factory has been called zero times

  @P11_3 @negative
  Scenario: A generic allow flag cannot authorize the protected Force
    Given a USB lab request naming an Akai Force with a generic allow flag
    When target preflight and opening are attempted with a counted transport factory
    Then preflight rejects the protected Force
    And the transport factory has been called zero times

  @P11_3 @negative
  Scenario: A Live Mk1 request cannot enable a nonexistent USB adapter
    Given a USB lab request naming an Akai MPC Live Mk1
    When target preflight and opening are attempted with a counted transport factory
    Then preflight reports that the USB lab adapter is not implemented
    And the transport factory has been called zero times

  @P02_2 @negative
  Scenario: Standalone mode rejects a physical target selector
    Given a standalone request also naming an Akai MPC Live Mk1
    When target preflight and opening are attempted with a counted transport factory
    Then preflight rejects the mixed standalone and physical request
    And the transport factory has been called zero times
