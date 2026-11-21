@P10 @os_vm
Feature: Boot and use an independent XMP operating system without a computer service

  @implemented @stage_gate @positive
  Scenario: Make and reopen a song entirely inside a booted offline OS image
    Given the candidate XMP image is booted on the generic supported VM board
    And the development server, network and host application services are unavailable
    When a musician creates a beat, adds a synth, arranges scenes and saves the song
    And cleanly shuts down and reboots the VM
    Then the song reopens and exports valid non-silent audio from inside the image
    And the booted build hash and virtual-device profile are recorded

  @P10_1 @implemented @positive
  Scenario: Rebuild a standalone image from declared inputs
    Given the distribution recipes, toolchain, sources and asset hashes are pinned
    When two clean qualified builders produce the same target image
    Then the reproducible artifact hashes match under the documented reproducibility scope
    And the source manifest, SBOM and development notice ledger accompany the artifact

  @P10_1 @implemented @negative
  Scenario: Stop a build with an unresolved vendor redistribution dependency
    Given an image requires a vendor component without reviewed redistribution terms
    When a public distributable image is requested
    Then the public-image gate fails with the component and provenance gap
    And no proprietary application or firmware payload is silently added to the release

  @P10_2 @implemented @positive
  Scenario: Start and stop services in a reliable order
    Given the OS has separate engine, UI and persistent-data services
    When it boots and later receives a clean shutdown request
    Then the engine is ready before the UI reports playable status
    And saves are flushed before the persistent-data volume is closed

  @P10_2 @implemented @negative @fault_injection
  Scenario: Recover a failed UI service without a boot loop
    Given the UI repeatedly fails during startup on a disposable VM data volume
    When its restart budget is exhausted
    Then the supervisor exposes a bounded diagnostic recovery state
    And the project volume remains recoverable without an endless restart loop

  @P10_3 @implemented @positive
  Scenario: Run shared musical contracts inside the booted root filesystem
    Given QEMU boots the candidate image with virtual audio and controls
    When the OS acceptance adapter runs the shared project and render fixtures
    Then the assertions execute inside the booted image rather than on the host simulator
    And captures identify the emulated board and virtual devices

  @P10_3 @implemented @negative
  Scenario: Do not qualify MPC drivers from a generic VM result
    Given the generic VM passes every virtual-audio and control scenario
    When a qualification report is generated
    Then Live Mk1 pads, internal codec, battery, USB mode and boot recovery remain unqualified
    And the report lists the required physical-device evidence separately

  @P10_4 @implemented @positive
  Scenario: Operate offline with the lab service disabled
    Given the standalone development image contains its own sounds and required runtime packages
    And its optional lab agent is disabled by default
    When the OS starts without network or USB connections
    Then a musician can create, save and export a song using local resources
    And no lab control listener is started

  @P10_4 @implemented @negative
  Scenario: Export useful diagnostics without leaking personal projects
    Given the image has a crash log and a project containing personal audio and identifiers
    When the musician exports a diagnostic bundle
    Then it contains build, service and error evidence with documented redaction
    And personal audio, credentials and raw device identifiers are excluded by default

  @P10_2 @implemented @positive @instrument_design
  Scenario: Reach a first beat without a setup wizard or development tools
    Given the offline OS boots with its original default kit and a qualified virtual audio path
    When the engine reports ready and the musician taps a pad and starts a recording pass
    Then audible pad feedback and the recording metronome require no sound assignment or editor navigation
    And no network login, development server or module installation is required
    And boot-to-ready time and the first-beat action trace are recorded against the frozen target profile

  @P10_1 @planned @positive @public_distribution
  Scenario: Qualify public image redistribution and independent source builds
    Given every redistributed component has reviewed terms, complete notices and matching corresponding source
    And two independent builder environments have pinned and qualified compiler toolchains
    When both environments build the public candidate from those sources
    Then the candidate hashes match within the declared cross-builder scope
    And the public image gate accepts the reviewed source and notice bundle
