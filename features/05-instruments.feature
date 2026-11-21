@P05 @desktop @os_vm @usb_lab
Feature: Build and play an original kit and synthesizer inside XMP

  @implemented @stage_gate @positive
  Scenario: Capture a sound and turn it into a playable song part
    Given a musician starts with an empty project and an approved test input
    When the musician records a sample, trims it and assigns slices to pads
    And adds a bass patch from the subtractive synthesizer
    And resamples the combined performance and saves the project
    Then reopening restores the samples, slice assignments and synth preset
    And the rendered performance contains the expected sample and synth events

  @P05_1 @implemented @positive
  Scenario: Play velocity-sensitive samples with explicit playback modes
    Given a kit contains one-shot, gated, looping and chromatic pad assignments
    When the musician plays the documented note-on and note-off fixture
    Then each assignment follows its playback and choke-group rules
    And captured amplitude and pitch match the velocity and note expectations

  @P05_1 @implemented @negative
  Scenario: Stop looping and gated voices when their owner disappears
    Given a looping pad and a gated pad have active voices
    When the track is removed or the transport receives panic
    Then all owned voices release within the documented release interval
    And no unowned or permanently sustained voice remains

  @P05_2 @implemented @positive
  Scenario: Edit slices without destroying the original recording
    Given a recorded waveform contains four transients at known sample offsets
    When the musician trims, reverses, normalizes and manually slices the recording
    And undoes and redoes those operations
    Then slice boundaries and playback agree with the selected sample offsets
    And the original asset hash remains unchanged

  @P05_2 @implemented @negative
  Scenario: Reject invalid slice boundaries and silent normalization
    Given a waveform contains a silent region
    When an edit requests an end before its start or normalizes that silent region
    Then invalid boundaries are rejected and silence remains finite silence
    And no edit introduces NaN, infinity or out-of-range sample reads

  @P05_3 @implemented @positive
  Scenario: Recall an expressive polyphonic synth patch
    Given a synth patch has oscillator, ADSR and filter settings
    When the musician plays overlapping notes at different velocities and saves the patch
    And reloads it in a new project
    Then the same seeded note fixture produces audio within the synth render tolerance
    And note releases respect the saved envelope settings

  @P05_3 @implemented @negative
  Scenario: Bound synthesis overload without losing transport control
    Given a synth receives more notes than its qualified voice budget
    When the voice policy and overload handling are applied
    Then processing remains bounded and all samples are finite
    And transport stop still releases all synth voices

  @P05_4 @implemented @positive
  Scenario: Record an explicitly armed input and resample the internal mix
    Given the musician has selected a test input and enabled monitoring
    When the musician arms recording and captures exactly two bars
    And separately resamples the internal master bus
    Then the input take and resampled take have the expected lengths and routing
    And recording does not start before the explicit arm and start actions

  @P05_4 @implemented @negative @fault_injection
  Scenario: Recover a take after input loss or a recording-space limit
    Given recording is active against a bounded temporary take
    When the input disappears or the recording storage budget is exhausted
    Then the recording stops with an actionable status and a recoverable valid take
    And existing project assets are neither overwritten nor deleted

  @P05_1 @implemented @positive @instrument_design
  Scenario: Play immediately with a declared input capability profile
    Given the default kit is loaded and the source declares note and velocity input only
    When the musician plays the supplied velocity fixture without opening an editor
    Then each hit uses the captured velocity and the declared velocity curve
    And pressure, pitch-slide and timbre-slide controls are unavailable rather than simulated

  @P05_1 @implemented @positive @machine_extension
  Scenario: Add a trusted custom track machine through the public registry
    Given a developer defines an original audio machine with a versioned state and parameter schema
    When the developer registers it and a musician selects it on one track
    Then its custom processor produces the expected audio and its state survives project save and reopen
    And other tracks keep their own machine identities

  @P05_1 @implemented @negative @machine_extension
  Scenario: Preserve an unavailable machine without running project-supplied code
    Given a project contains an unknown machine and a future machine-state version
    When a musician reopens the project without that machine installed
    Then its state is preserved and its track stays silent without substituting another machine
    And invalid built-in state and duplicate machine registration are rejected

  @P05_1 @implemented @positive @machine_extension
  Scenario: Keep MIDI tracks silent while emitting only virtual routed note events
    Given a MIDI machine has an explicitly configured virtual output fixture
    When notes are played and then the transport receives panic
    Then the virtual trace contains matching note-ons and note-offs on the selected channel
    And no physical MIDI or device adapter is opened
