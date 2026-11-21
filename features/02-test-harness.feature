@P02 @host_only
Feature: Execute acceptance tests against explicit targets with truthful evidence

  @implemented @stage_gate @positive
  Scenario: Qualify the same musical behavior independently on supported targets
    Given a versioned musical fixture and its expected audio and project results
    And test doubles for desktop, native, OS VM and USB lab adapters advertise distinct capabilities
    When the adapter-contract matrix runs with an explicit fixture target per run
    Then each fixture target produces separate assertions, captures and build identity marked as synthetic evidence
    And a desktop result is never substituted for an OS boot or hardware result
    And any missing required target prevents qualification

  @P02_1 @implemented @positive
  Scenario: Run two scenarios with isolated musical state
    Given two scenarios start from the same immutable project fixture
    When the first scenario changes a pattern and the second loads its fixture
    Then the second scenario receives the original pattern
    And both scenarios clean up their own processes and temporary files

  @P02_1 @implemented @negative
  Scenario: Propagate a real assertion failure to CI
    Given an expected audio capture contains a kick at sample 24000
    When the target produces the kick at sample 25000
    Then the timing assertion fails and the test process exits unsuccessfully
    And the actual capture and timing difference remain attached to the failed report

  @P02_2 @implemented @positive
  Scenario: Select an adapter with a complete capability match
    Given the requested target is the native standalone adapter
    And the selected scenario requires offline render and project persistence
    When preflight validates the scenario requirements
    Then the native adapter is selected without any USB discovery
    And only its declared operations are available to step definitions

  @P02_2 @implemented @negative
  Scenario: Refuse an unsupported capability instead of falling back
    Given a hardware-only scenario requires physical pad sensor input
    And the selected target is a desktop simulator
    When preflight validates the scenario requirements
    Then the scenario is reported as unsupported and not passed
    And the runner does not replace physical input with a simulated pad event

  @P02_3 @implemented @positive
  Scenario: Preserve sufficient evidence to reproduce a failure
    Given an authorized test session with a build, fixture and target identity
    When an acceptance scenario completes
    Then the report records its scenario ID, target profile, build hash, fixture hash and outcome
    And relevant logs, screenshots, event traces and audio capture hashes are attached
    And public reports redact device identifiers and personal project data

  @P02_3 @implemented @negative
  Scenario: A missing measurement cannot satisfy a threshold
    Given a scenario requires an analog round-trip latency measurement
    When the loopback capture is absent or its clock calibration is invalid
    Then the scenario is reported as inconclusive and qualification fails
    And no zero latency or default passing value is recorded

  @P02_4 @implemented @positive
  Scenario: Complete a stage using all of its required evidence
    Given every substep has passing scenarios for its required target profiles
    And the stage journey has passed on the same candidate build
    When the stage gate evaluates the evidence manifest
    Then the stage can be marked complete with links to its reports
    And downstream stages receive the accepted build and interface versions

  @P02_4 @implemented @negative
  Scenario: Planned or skipped work cannot make a release green
    Given a stage has an undefined, pending, skipped or unsupported required scenario
    When a contributor requests stage completion or release qualification
    Then the request fails with the missing scenario and target IDs
    And syntax-only validation is not reported as implemented behavior
