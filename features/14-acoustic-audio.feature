@acoustic_audio
Feature: Check XMP playback through only a MacBook's built-in speakers and microphone

  @implemented @host_only @positive @acoustic_contract
  Scenario Outline: Recognize the expected acoustic pattern at the actual built-in sample rate
    Given a synthetic six-second acoustic capture at <rate> Hz with the complete eight-note pattern
    When the acoustic detector analyzes the capture
    Then all eight tones and their relative timing pass the acoustic profile
    And no formal latency or hardware qualification is claimed
    Examples:
      | rate  |
      | 44100 |
      | 48000 |

  @implemented @host_only @negative @acoustic_contract
  Scenario Outline: Refuse to verify incorrect or unusable recordings
    Given a synthetic acoustic capture with "<fault>"
    When the acoustic detector analyzes the capture
    Then the acoustic outcome is "<outcome>"
    And no formal latency or hardware qualification is claimed
    Examples:
      | fault       | outcome      |
      | silence     | inconclusive |
      | missing hit | failed       |
      | late hit    | failed       |
      | wrong order | failed       |
      | noise       | failed       |
      | clipping    | inconclusive |
      | truncated   | inconclusive |
      | non-finite  | inconclusive |

  @implemented @host_only @positive @acoustic_contract
  Scenario: Prepare an original bounded pattern through the actual XMP sampler
    Given the original acoustic-check project is loaded on the host
    When the XMP offline renderer prepares and renders it
    Then the reference contains exactly eight events at the expected musical positions
    And it lasts four seconds and stays below the acoustic output level limit

  @implemented @host_only @negative @acoustic_contract
  Scenario: Reject external or ambiguous audio selections before opening streams
    Given acoustic preflight receives protected, external, headphone, missing or mismatched device metadata
    When each selection is attempted through a counted stream factory
    Then every selection is refused and no stream factory is called
    And the compiled native policy independently rejects unsafe selections

  @implemented @host_only @negative @acoustic_contract
  Scenario: Keep CI and denied microphone access from opening audio streams
    Given acoustic preflight receives a CI request or a denied microphone request
    When each selection is attempted through a counted stream factory
    Then every selection is refused and no stream factory is called

  @implemented @host_only @negative @acoustic_contract
  Scenario: Reject malformed microphone WAV data rather than reporting a pass
    Given valid synthetic microphone PCM and malformed WAV variants
    When the acoustic WAV decoder reads every malformed variant
    Then every malformed capture is rejected before analysis

  @implemented @native @manual @physical_measurement @acoustic_mac
  Scenario: Hear and capture the XMP pattern through the actual MacBook built-ins
    Given this MacBook's exact built-in speaker and microphone identities pass acoustic preflight
    When the XMP acoustic tool plays its original eight-note pattern and records six seconds locally
    Then all eight recorded tones match the expected order and relative timing
    And only the built-in pair was opened and every audio stream has stopped
    And the acoustic report leaves calibrated loopback and P04 physical qualification pending

  @implemented @host_only @negative @acoustic_contract
  Scenario Outline: Reject incomplete native capture evidence before analyzing audio
    Given a synthetic native capture report with "<fault>"
    When the acoustic evidence validator checks the report and WAV
    Then the acoustic outcome is "inconclusive"
    And no formal latency or hardware qualification is claimed
    Examples:
      | fault              |
      | permission denied  |
      | changed device     |
      | callback error     |
      | timestamp gap      |
      | stream not stopped |
      | missing WAV        |
      | wrong frame count  |
