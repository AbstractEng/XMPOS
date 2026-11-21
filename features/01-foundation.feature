@P01 @host_only
Feature: Reproduce the development baseline without changing an instrument

  @implemented @stage_gate @positive
  Scenario: A new contributor starts the protected desktop workflow
    Given a clean checkout at a recorded XMP commit
    And no physical instrument is a development target
    When the contributor bootstraps the pinned tools and starts the simulator
    And creates, saves and reopens a sixteen-step drum pattern
    Then the reopened pattern and embedded samples match the saved project
    And the native and acceptance checks produce reports for that commit
    And the device-I/O audit records zero device operations

  @P01_1 @implemented @positive
  Scenario: Baseline every V1 requirement with explicit provenance
    Given the versioned project requirements and any external specification are recorded with hashes
    When the product baseline is approved
    Then every V1 requirement has an ID, owner, acceptance scenario and source
    And unresolved implementation choices have explicit decision records

  @P01_1 @implemented @negative
  Scenario: An unavailable external specification is not treated as reviewed
    Given the external specification input has not supplied a document
    When a contributor generates the requirements baseline
    Then the external specification review is recorded as pending
    And no requirement is attributed to unseen external specification content

  @P01_2 @implemented @positive
  Scenario: Bootstrap a clean Mac or Linux developer host
    Given a supported host with Node 24, Python 3 and a C++17 compiler
    When the contributor runs the documented bootstrap and checks
    Then the lockfile dependencies and isolated native tools are installed
    And the simulator build, unit tests and native tests exit successfully

  @P01_2 @implemented @negative
  Scenario: Report an unsupported toolchain before starting a build
    Given a developer host with Node 20 and no C++ compiler
    When the contributor runs the toolchain doctor
    Then it exits unsuccessfully with the missing prerequisites
    And it does not download drivers or change global system settings

  @P01_3 @implemented @positive
  Scenario: Review a new upstream source revision
    Given pinned upstream commits and official source archive hashes
    When the update monitor detects a new relevant source revision
    Then it reports the source URL, changed commit and hardware or licence implications
    And the application build continues to use the previously reviewed dependencies

  @P01_3 @implemented @negative
  Scenario: Preserve the reference baseline during an upstream failure
    Given a previously successful upstream reference observation
    When that upstream becomes unavailable or an archive hash is incorrect
    Then the last successful baseline is retained
    And unavailable or unverified material is excluded from qualified build inputs

  @P01_4 @implemented @positive
  Scenario: Inspect cached host metadata without contacting the Force
    Given a fixture containing cached Akai Force USB metadata and a serial number
    When the contributor selects passive inventory
    Then only product, manufacturer, vendor ID and product ID are reported
    And the device-I/O audit records zero opened device handles and zero transfers

  @P01_4 @implemented @negative
  Scenario: A USB cable does not authorize a Force modification
    Given an Akai Force is present in the target inventory
    When a workflow requests deployment, reboot, MIDI output or a device command
    Then target policy rejects the request before opening a device connection
    And no mode, setting, storage or firmware change is attempted
