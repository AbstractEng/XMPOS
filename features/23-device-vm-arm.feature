@implemented @device_vm @os_vm @regression
Feature: Offline Linux Device view and ARM development pipeline
  All interaction is with owned files and emulators on the development computer.
  ARM userspace execution does not qualify an MPC kernel, bootloader or drivers.

  @device_vm_boot
  Scenario: D01 - Boot and see the real Device interface inside Linux
    Given the offline Device image is booted in its owned VM
    Then Chromium renders Device view inside Linux without a host development server
    And the screen has sixteen pads with pad one at the bottom left
    When I capture the guest Device screen over bounded serial chunks
    Then the captured PNG matches the guest hash and has the expected dimensions

  @device_vm_song
  Scenario: D02 - Build a clip song and keep it across a cold VM reboot
    Given the offline Device image is booted in its owned VM
    When I start an empty song using the guest Device controls
    And I program a four-on-the-floor drum clip in the guest
    And I add a synth clip on track two and chain two scenes
    And I play and stop the guest song using the Live front panel
    Then the guest portable project contains both machines and the song chain
    When I cleanly shut down and cold boot the same owned VM disk
    Then the guest Device project retains the clips and song chain

  @device_vm_boundary
  Scenario: D03 - Invalid commands cannot escape the virtual control boundary
    Given the offline Device image is booted in its owned VM
    When invalid Device actions and physical deployment requests are submitted
    Then those requests are rejected and the guest interface remains usable
    And no physical device API, network adapter or host share was used

  @arm_pipeline
  Scenario: D04 - Build and execute ARMv7 artifacts without an instrument
    Given the offline Device image is booted in its owned VM
    Then the ARM pipeline contains static hard-float binaries and the offline Device assets
    When the ARM sampler and engine tests execute under emulation inside Linux
    Then all native timing, queue, safe-state and callback audit tests pass on ARM
    And ARM DSP fixtures match the reference PCM and reject malformed plans
    And MPC boot, drivers and physical audio qualification remain pending
