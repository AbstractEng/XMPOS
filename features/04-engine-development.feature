@P04_dev @native
Feature: Verify the Mac native host without claiming physical or V1 qualification

  @implemented @development_gate @positive
  Scenario: Preserve a native development session across a control-client crash
    Given the P04 development workload is playing through the independent native host
    When its control client process is killed and a fresh client reconnects
    Then the native clock and captured event sequence continue without a client-driven restart
    And the capture is qualified only against the named software audio profile

  @P04_4 @implemented @positive
  Scenario: Recover the software backend only after profile renegotiation
    Given the native development backend is playing a validated project
    When its test endpoint reports a loss
    Then the engine becomes silent and retains the project identity
    And unsupported rates fail before a valid reconnect and explicit resume

  @P04_4 @implemented @positive @synthetic_measurement
  Scenario: Verify measurement tooling against a known synthetic delay
    Given a thousand generated capture trials have a known ten-millisecond delay
    When the calibrated loopback analyzer reads the capture
    Then its measured p95 is ten milliseconds with a preserved capture hash
    And the synthetic result cannot qualify a physical audio path

  @P04_4 @implemented @negative
  Scenario: Refuse incomplete physical measurement and protected audio selection
    Given no approved physical capture or valid clock calibration is supplied
    When the loopback qualification and audio selection checks run
    Then latency remains inconclusive and protected or default outputs are rejected
