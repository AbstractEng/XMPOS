@P03 @shared_contract @native @os_vm @usb_lab
Feature: Preserve complete musical projects and stable parameter identities

  @implemented @stage_gate @positive
  Scenario: Reopen an eight-track song on an independent target
    Given a musician has eight tracks, sixteen scenes, samples and parameter assignments
    When the musician exports a portable project and opens it on another supported target
    Then track, clip, scene, asset and parameter identities are preserved
    And rendering the same seeded song produces the expected event trace and audio within the render tolerance
    And the project does not depend on a developer workstation path

  @P03_1 @implemented @positive
  Scenario: Migrate an older valid project without losing music
    Given a version-1 project with known notes, scenes and samples
    When the musician opens it in the next supported project-format version
    Then a validated migration preserves the musical event trace
    And the original file remains available for recovery

  @P03_1 @implemented @negative
  Scenario: Reject an incompatible or broken project before replacing current state
    Given the musician has unsaved changes in a valid project
    When the musician opens a future-version project or one with a missing clip reference
    Then an actionable validation error is shown
    And the current project and its unsaved changes remain intact

  @P03_2 @implemented @positive
  Scenario: Resolve all parameter sources in a documented order
    Given a normalized parameter has base 0.2, automation 0.4 and a step lock of 0.7
    And its macro adds 0.1 and its LFO adds -0.2
    When the engine resolves the parameter for the locked step
    Then the effective value is 0.6 within 0.000001
    And the UI, offline render and native engine report the same effective value

  @P03_2 @implemented @negative
  Scenario: Reject unknown parameters and non-finite values
    Given a running project has registered parameter identities and ranges
    When a command addresses an unknown parameter or supplies a non-finite value
    Then the command is rejected before reaching DSP processing
    And existing parameter values and audio playback remain valid

  @P03_3 @implemented @positive
  Scenario: Move a project containing a shared sample between targets
    Given two pads reference one content-addressed sample
    When the musician packages and reopens the project in an empty workspace
    Then both pads resolve the same verified sample content
    And duplicate sample data is not required in the package

  @P03_3 @implemented @negative
  Scenario: Bound damaged or hostile asset imports
    Given an import exceeds the profile size limit or contains a corrupt sample hash
    When the musician attempts to import it
    Then the import fails before committing project or asset changes
    And memory use remains inside the declared import budget

  @P03_4 @implemented @positive
  Scenario: Recover the last committed state after an interrupted save
    Given a musician edits a pattern, a sample slice and an effect parameter
    When the save process is interrupted before its atomic commit
    And the application restarts
    Then the previous committed project or a validated recovery snapshot is offered
    And no partially written project is silently treated as valid

  @P03_4 @implemented @negative
  Scenario: Preserve edits when storage is full
    Given the musician has unsaved project changes
    And the project storage fixture reports no free space
    When the musician saves the project
    Then save status remains unsaved and the storage failure is explained
    And undo history and the previous committed project remain available
