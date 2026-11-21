@P12
Feature: Release a measured and recoverable standalone music workstation

  @planned @stage_gate @positive @os_vm @usb_lab @update_authorization
  Scenario: Qualify the musician and developer V1 journeys on one candidate release
    Given the candidate release has approved standalone and Live Mk1 qualification profiles
    When a musician installs by the approved path and makes, performs, saves and exports a song offline
    And a developer builds a new instrument, tests it and installs its package on that environment
    And the required long-session and recovery scenarios complete
    Then every stage gate and required target has passing evidence for the same release build
    And source, licences, compatibility, update and recovery instructions match the shipped artifacts

  @P12_1 @planned @positive @native @os_vm @usb_lab
  Scenario: Sustain the declared V1 workload for eight hours
    Given the qualification workload specifies eight tracks, thirty-two voices and the exact effect graph
    When it plays for eight hours with scheduled edits, saves and scene changes
    Then the engine reports zero xruns and no missing or duplicated expected events
    And measured callback deadline, memory-growth and timing budgets stay within the target profile
    And physical hardware targets also satisfy their recorded thermal limits without throttling

  @P12_1 @planned @negative @native @os_vm @usb_lab @fault_injection
  Scenario: Shed an explicitly overloaded workload without losing saved work
    Given the workload exceeds the target's measured DSP capacity
    When the engine applies its documented overload policy
    Then it reports the overload and bounds processing instead of hiding missed deadlines
    And transport stop and project save remain available

  @P12_2 @implemented @positive @os_vm @p12_vm @fault_injection
  Scenario: Recover from a VM power interruption during save
    Given a VM snapshot contains a known committed song and a pending edit
    When virtual power is interrupted during an atomic save and the image reboots
    Then a valid committed project or validated recovery snapshot is restored
    And the result includes the exact injected failure point and recovered asset hashes

  @P12_2 @implemented @negative @os_vm @p12_vm @fault_injection
  Scenario: Preserve the original data when every recovery candidate is invalid
    Given a disposable VM fixture contains corrupt project and recovery files
    When the musician requests recovery
    Then the application reports that no candidate can be validated
    And it preserves the original files for export instead of overwriting them with an empty project

  @P12_2 @planned @positive @usb_lab @hardware_only @fault_injection @update_authorization
  Scenario: Recover a Live Mk1 save after an approved physical power interruption
    Given an exact Live Mk1 has approved recovery evidence and device-specific fault-test authorization
    When an authorized operator interrupts a save using the reviewed hardware procedure
    Then the independently booted target restores a validated committed generation
    And project and asset hashes identify the recovered data without relying on VM results

  @P12_2 @planned @negative @usb_lab @hardware_only @fault_injection @update_authorization
  Scenario: Preserve invalid recovery generations on the exact Live Mk1
    Given an authorized disposable Live Mk1 data fixture has no valid committed generation
    When the deployed application requests recovery
    Then it preserves the original files and offers the reviewed recovery export path
    And no empty project replaces saved data without separate explicit approval

  @P12_3 @planned @positive @os_vm @usb_lab @update_authorization
  Scenario: Update through the verified target-specific transaction and roll back
    Given the exact target has an approved update path and a previously validated release
    When an authorized update installs the candidate and its health check fails
    Then the update mechanism restores the previous bootable application and compatible project state
    And the report records the target-specific transaction rather than assuming A/B partitions exist

  @P12_3 @planned @negative @os_vm @usb_lab @update_authorization
  Scenario: Reject a corrupted or wrong-model release before writing it
    Given a release artifact has an invalid signature, hash, model or dependency set
    When an authorized operator requests its installation
    Then preflight rejects it before any image or system-data write
    And the currently installed release remains bootable and unchanged

  @P12_4 @planned @positive @host_only
  Scenario: Publish only an evidence-backed release candidate
    Given all required scenario and target results are linked to one candidate artifact hash
    And its sources, notices, dependency rights and recovery documentation have been reviewed
    When the maintainer evaluates the release gate
    Then the release manifest names supported hardware and measured limits accurately
    And optional, unavailable or manually unverified capabilities are clearly excluded

  @P12_4 @implemented @negative @host_only
  Scenario: A green simulator cannot conceal a missing hardware qualification
    Given all simulator tests pass but the Live Mk1 hardware lane is missing or inconclusive
    When the maintainer requests a hardware-ready V1 release
    Then release qualification fails with the missing hardware evidence
    And an explicitly labeled desktop preview may be evaluated separately

  @P12_1 @implemented @positive @host_only
  Scenario: Record a bounded wall-clock sampler development soak
    Given the frozen sixty-second thirty-two-voice sampler development profile
    When the independent native engine runs with scheduled tempo edits and saved checkpoints
    Then duration, callback counters, memory and bounded capture evidence are measured
    And every observed timing violation keeps the strict performance gate failed
    And a short sampler run cannot qualify the eight-hour V1 workload or hardware

  @P12_1 @implemented @negative @host_only
  Scenario: Refuse incomplete or relabeled soak evidence
    Given a short, incomplete or deadline-violating sampler report
    When it is evaluated as long-session qualification
    Then missing durations, measurements and strict timing violations are reported
    And no fabricated eight-hour or hardware pass is issued

  @P12_1 @implemented @negative @host_only
  Scenario: Preserve virtual stop and saved state during voice overload
    Given an owned native virtual engine at its thirty-two-voice capacity
    When sixty-four additional virtual voices are requested
    Then excess demand is explicitly refused and transport stop remains available
    And the original project snapshot still saves with its known identity

  @P12_2 @implemented @positive @os_vm @p12_vm @fault_injection
  Scenario: Recover the published generation after a VM power interruption
    Given a VM snapshot contains a known committed song and a pending edit
    When virtual power is interrupted after the primary directory sync
    Then the new committed generation reopens with its recorded asset hashes
    And the result includes the exact injected failure point and recovered asset hashes

  @P12_2 @implemented @positive @os_vm @p12_vm @fault_injection
  Scenario: Open a validated previous snapshot without overwriting a corrupt primary
    Given a VM has two committed generations and a corrupt primary fixture
    When the owned VM cold boots into project recovery
    Then it opens the validated previous generation read-only
    And the corrupt primary remains available for explicit recovery export

  @P12_3 @implemented @positive @os_vm @p12_vm @fault_injection
  Scenario: Roll back an unhealthy VM candidate and promote a healthy retry
    Given signed compatible VM images and a committed project on an owned data disk
    When a candidate boots with a failed UI health check
    Then the known-good image pointer and data snapshot are unchanged
    When a VM update is interrupted after cloning and before promotion
    Then reopening the transaction preserves the known-good active snapshot
    When the signed candidate passes its fixed guest musical health checks
    Then the candidate is promoted and reopens the same project after a cold boot
    And the update receipt identifies the generic VM transaction without claiming an MPC partition layout

  @P12_3 @implemented @negative @host_only
  Scenario: Reject unsafe VM release capsules before staging writes
    Given an owned VM capsule-policy fixture and a pinned release signer
    When signatures, component bytes, target models or dependency versions are invalid
    Then capsule preflight rejects each request before creating an update store
    And known-good source bytes remain unchanged

  @P12_4 @implemented @positive @host_only
  Scenario: Generate a scoped development candidate manifest
    Given complete current-source host and generic VM development evidence
    When the maintainer evaluates development preview readiness
    Then only the supported generic VM console and recovery scope is listed
    And physical hardware, public redistribution and full V1 performance remain pending

  @P12_4 @implemented @negative @host_only
  Scenario: Reject stale and mismatched candidate evidence
    Given development evidence names another source or image build
    When the maintainer evaluates development preview readiness
    Then development readiness fails with the mismatched evidence
    And no hardware or public release is authorized
