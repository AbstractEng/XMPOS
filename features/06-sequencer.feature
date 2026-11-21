@P06 @desktop @os_vm @usb_lab
Feature: Create expressive patterns with deterministic sequencing and automation

  @implemented @stage_gate @positive
  Scenario: Record and edit a complete expressive pattern
    Given a musician has a drum kit and a polyphonic synth track
    When the musician records notes, quantizes selected notes and edits note lengths
    And adds microtiming, probability, parameter locks and recorded automation
    And duplicates the pattern and saves the project
    Then reopening preserves all note and expression data
    And live and offline event traces agree for the same seed and transport state

  @P06_1 @implemented @positive
  Scenario: Combine step entry and real-time overdubbing
    Given a sixty-four-step clip contains an existing chord
    When the musician enters pad steps and overdubs another chord in real time
    And quantizes only the newly selected notes
    Then existing notes retain their original timing and lengths
    And original take timestamps and played velocities remain available after timing correction
    And undo removes only the selected overdub transaction

  @P06_1 @implemented @negative
  Scenario: Shorten a clip while notes cross its new boundary
    Given a sixty-four-step clip has sustained notes beyond step sixteen
    When the musician shortens it to sixteen steps during playback
    Then notes outside the new loop follow the documented truncation and note-off rules
    And no stuck note or out-of-range event remains after the transition

  @P06_2 @implemented @positive
  Scenario: Repeat seeded probability and conditional triggers
    Given a clip has a recorded random seed and explicit first-cycle and fill conditions
    When the musician replays the same number of cycles with the same fill actions
    Then triggered events match the expected seeded trace exactly
    And swing and microtiming preserve the defined bar boundaries

  @P06_2 @implemented @negative
  Scenario: Bound microtiming near loop boundaries
    Given events have the minimum and maximum supported microtiming offsets
    When the clip crosses its loop boundary at the fastest supported tempo
    Then events obey the documented wrap or clamp rule exactly once
    And no event is duplicated or assigned a negative processing timestamp

  @P06_3 @implemented @positive
  Scenario: Release a parameter lock to the correct underlying value
    Given automation sets filter cutoff and one step temporarily locks that parameter
    When playback enters and then leaves the locked step
    Then the locked step uses its lock and the next step resumes the underlying automated value
    And macro and LFO offsets follow the registry precedence rules

  @P06_3 @implemented @negative
  Scenario: Remove a modulation source while it is active
    Given an LFO and a macro target the same registered parameter
    When the LFO module is removed during playback
    Then its contribution is removed without leaving a stale modulation value
    And the parameter smoothly resolves from the remaining sources

  @P06_4 @implemented @positive
  Scenario: Record touch automation without overwriting untouched sections
    Given a clip has an existing automation lane in touch mode
    When the musician moves an encoder for one bar and releases it
    Then only the touched interval is replaced and playback returns to the previous lane afterward
    And undo restores the complete previous lane

  @P06_4 @implemented @negative
  Scenario: Stop during an active automation write
    Given automation is being written while a sustained note is playing
    When the musician stops transport
    Then the recorded segment is finalized as one recoverable edit
    And note-off and parameter-reset events are applied without leaving write mode armed

  @P06_1 @implemented @positive @instrument_design
  Scenario: Shape note-repeat dynamics with pressure on clocked repeat ticks
    Given a virtual source declares pressure and holds one note at repeat velocity 0.5
    And its pressure fixture is 0.2 at tick zero, 0.8 at tick one and 0.4 at tick two
    When note repeat runs at sixteenths with pressure mapped directly to velocity
    Then the repeated notes have velocities 0.2, 0.8 and 0.4 at the engine's exact tick timestamps
    And releasing the note stops repeats and undo removes the recorded repeat pass as one edit

  @P06_1 @implemented @negative @instrument_design
  Scenario: Use a declared repeat velocity when pressure is unavailable
    Given a source declares no pressure capability and repeat velocity is explicitly set to 0.6
    When the source holds a note for three repeat ticks and then disconnects
    Then all three repeated notes use velocity 0.6 without fabricated pressure samples
    And the disconnect cancels future repeats and releases every owned note

  @P06_2 @implemented @positive @instrument_design
  Scenario: Change groove at a boundary without restarting the engine clock
    Given the native engine is playing a recorded take at straight timing with an active sustained note
    When the musician queues exact triplet swing for the next bar
    Then old events finish under the old groove and the new bar uses exact 2:1 pairs
    And the sample clock, active note and original take timestamps remain continuous
    And selecting straight timing again restores the unswung take without a new recording

  @P06_2 @implemented @negative @instrument_design
  Scenario: Reject an invalid groove update while keeping the accepted performance
    Given the engine has acknowledged a valid queued swing change
    When an update supplies a non-finite ratio or an unsupported groove version
    Then that update is rejected and the last acknowledged change remains scheduled
    And no duplicate hit, lost note-off or transport restart occurs
