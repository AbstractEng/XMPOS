@P04
Feature: Process audio independently with deterministic timing and bounded resources

  @planned @stage_gate @positive @native @os_vm @usb_lab
  Scenario: Keep a song playing while the user interface restarts
    Given the declared V1 workload is playing through the native audio host
    When the UI process crashes and is restarted
    Then the audio event clock continues without a missing or duplicated event
    And the UI reconnects to the current project and transport position
    And the measured audio remains within the active qualification profile

  @P04_1 @implemented @positive @native @os_vm @usb_lab
  Scenario: Render a prepared voice graph without real-time allocation
    Given sample buffers and thirty-two voices are prepared before playback
    When the engine renders a one-minute multitrack fixture
    Then callback instrumentation observes zero allocations, locks and file or network operations
    And every output sample is finite and inside the declared output range

  @P04_1 @implemented @negative @native @os_vm @usb_lab
  Scenario: Handle voice exhaustion predictably
    Given all voices in the active profile are in use
    When another note arrives
    Then the documented voice-stealing or refusal rule is applied deterministically
    And no buffer overrun, unbounded allocation or engine crash occurs

  @P04_2 @implemented @positive @native @os_vm @usb_lab
  Scenario: Apply a tempo change at a scheduled musical boundary
    Given a song plays at 120 BPM with notes that span the next bar
    When the musician queues 90 BPM for the next bar
    Then event times follow the old tempo before the boundary and the new tempo afterward
    And active notes receive exactly one note-off without a transport restart

  @P04_2 @implemented @negative @native @os_vm @usb_lab
  Scenario: Reject a malformed timestamped command
    Given the engine has a validated finite event queue
    When a command has an invalid timestamp, unsupported version or oversized payload
    Then that command is rejected with a bounded error response
    And previously queued musical events keep their order

  @P04_3 @implemented @positive @native @os_vm @usb_lab
  Scenario: Reconnect a client to authoritative engine state
    Given an engine is running a project while no UI client is connected
    When a compatible UI client completes the version handshake
    Then it receives an atomic project and transport snapshot
    And subsequent commands acknowledge the applied state revision

  @P04_3 @implemented @negative @native @os_vm @usb_lab
  Scenario: Prevent UI traffic from blocking the audio thread
    Given a client floods the control channel beyond its declared queue capacity
    When the engine applies backpressure
    Then excess commands are rejected or coalesced by the documented policy
    And callback deadlines and transport note-off processing remain within budget

  @P04_4 @planned @positive @native @usb_lab @physical_measurement
  Scenario: Measure an actual audio path rather than a software timestamp
    Given an approved audio loopback fixture and a calibrated capture clock
    And the target uses the sample rate and buffer size declared by its profile
    When a known impulse is emitted and captured through that physical path
    Then the report contains the measured latency distribution and capture hash
    And the p95 analog round-trip latency is at most the profile limit

  @P04_4 @planned @negative @native @usb_lab @fault_injection @physical_measurement
  Scenario: Recover from loss of an optional audio interface
    Given playback is using a removable test audio interface
    When that interface is disconnected
    Then the engine enters its documented safe audio state without corrupting the project
    And reconnecting requires validated device and sample-rate negotiation
