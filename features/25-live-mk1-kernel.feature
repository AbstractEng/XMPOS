@live_mk1
Feature: Official Akai kernel and MPC Live Mk1 hardware support, built and tested on the Mac
  XMP builds the official inMusic az01 kernel and the MPC Live Mk1 device trees
  from the pinned G1 source archive, boots that kernel on QEMU's generic ARM
  board, and discovers hardware read-only. Nothing is flashed, deployed or
  connected to an instrument. The owner's Force is a protected identity.

  @LK01 @implemented @host_only @positive
  Scenario: LK01 - Identify the Live Mk1 board in the official inMusic kernel source
    Given the official G1 kernel archive matches its pinned hash
    When I read the published MPC device trees from the archive
    Then ACV8 is the MPC Live with a 7-inch panel, an SBS battery and the "MPC Live Hub"
    And ACV5 is the MPC X and ADA2 is the protected Force

  @LK02 @implemented @host_only @negative
  Scenario: LK02 - Refuse a kernel archive that does not match its pin
    Given a substituted kernel archive of the pinned size
    When the kernel build verifies its source
    Then the build stops before extraction with a pin mismatch
    And no kernel artifact is produced

  @LK03 @implemented @container @native @positive
  Scenario: LK03 - Cross-build the official kernel and Live Mk1 device trees on the Mac
    Given Docker is running with the pinned builder image
    When I build the official az01 kernel with the XMP virt fragment
    Then the zImage is an ARM kernel reporting release 6.18.44-az01
    And both ACV8 device trees describe the MPC Live Mk1 target
    And the merged configuration keeps every official option and enables real-time, battery, power and USB audio support
    And the outputs contain no bootloader, flash, update or recovery image

  @LK04 @implemented @host_only @negative
  Scenario: LK04 - Refuse the Force, other MPC boards and any device access
    Given the official G1 kernel archive matches its pinned hash
    When the board check reads the compatible strings published for the Force and the MPC X
    Then both are refused as Live Mk1 targets
    And the kernel tool rejects flash, deploy and device options
    And the container policy has no network, device or privileged access

  @LK05 @implemented @container @os_vm @positive
  Scenario: LK05 - Boot the official kernel in an ARM VM and run XMP engine tests on it
    Given the official az01 kernel has been built from the pinned source
    When I boot it on the QEMU ARM virt board with XMP's ARMv7 test payload
    Then Linux reports release 6.18.44-az01 with PREEMPT_RT active
    And XMP's sampler and engine tests pass on the booted ARM kernel
    And the kernel's USB Audio Class driver binds an emulated USB audio interface
    And the G1-built ALSA tools list the USB audio card and play a test tone into it
    And the G1-built gpiodetect and listdevs see the board's GPIO controller and USB devices
    And the hardware probe classifies the VM as a development host, not a Live Mk1

  @LK10 @implemented @container @native @positive
  Scenario: LK10 - Cross-build the G1 hardware userspace from Akai's published sources
    Given the official G1 ALSA, libgpiod and libusb archives match their catalog hashes
    When I cross-build them in the locked-down container
    Then aplay, amixer, alsactl, gpiodetect, gpioinfo and listdevs are static ARMv7 hard-float programs
    And the manifest records each official archive, its hash and licence
    And the published G1 ALSA state contains no MPC mixer settings

  @LK11 @implemented @host_only @negative
  Scenario: LK11 - Refuse a substituted G1 source archive
    Given a G1 catalog entry whose hash does not match the local archive
    When the G1 userspace build verifies its sources
    Then it stops before anything is extracted or built

  @LK12 @implemented @os_vm @positive
  Scenario: LK12 - Run the XMP Device interface on the official ARM kernel
    Given the ARMv7 Device image is booted in its owned VM on the official az01 kernel
    Then the guest reports the az01 real-time kernel and a loopback-only network
    And Chromium renders Device view on ARM with sixteen pads and pad one at the bottom left
    When XMP's ARM engine tests run natively in the guest
    Then they pass without user-mode emulation
    And the hardware probe uses the G1-built tools and reports a development host with USB audio
    And the ARM VM shuts down cleanly with its data disk flushed

  @LK13 @implemented @container @os_vm @positive
  Scenario: LK13 - Stream XMP's continuous engine through the official kernel's audio stack
    Given XMP's ALSA engine is built from this source against the official G1 alsa-lib
    When the official kernel boots on the ARM board and runs the engine for 20 seconds
    Then all 20 seconds reach the USB audio device with no underruns on a real-time thread
    And the captured quarter notes land on a 0.5 second grid
    And the 32-voice stress graph completes with its emulation timing recorded, not hidden

  @LK14 @implemented @host_only @negative
  Scenario: LK14 - The ALSA engine refuses Akai and inMusic sound cards
    Given ALSA card identities for an Akai Force, an MPC Live and QEMU's USB audio device
    When the engine's card protection policy is checked natively
    Then the Akai and inMusic cards are refused and only the emulated device is accepted
    And the engine has no default-device, discovery or MIDI path

  @LK15 @implemented @container @native @owner_files @positive
  Scenario: LK15 - Build the probe image as a copy of Akai's official root filesystem
    Given Akai's signed MPC 3.10.0 updater is on this Mac
    When I build the step 4 probe image from it
    Then only the boot script, which carries the probe initramfs, and the XMP report service differ
    And every other file is byte-identical to Akai's root filesystem and the filesystem checks clean
    And the image is marked as vendor firmware that is never committed, redistributed or flashed by the tool

  @LK16 @implemented @os_vm @owner_files @positive
  Scenario: LK16 - The probe reports hardware facts and never touches another disk
    Given the step 4 probe image has been built
    When the probe boots on the ARM board with an XMPPROBE card and a protected disk
    Then it writes one complete report to the card, halts showing success and switches off at the power button
    And the protected disk is byte-identical afterwards
    And without a card it writes nothing and halts showing the failure
    And run as a service inside the stock system it records the fallback stage and exits

  @LK17 @implemented @os_vm @owner_files @positive
  Scenario: LK17 - The probe boot script starts the probe and falls back to stock
    Given the step 4 probe image has been built
    When a real U-Boot boots the image through distro boot
    Then the boot script loads Akai's kernel, the device tree and the probe ramdisk and starts the kernel
    And an az01 kernel booted through that script receives the initramfs and runs the probe
    And with the probe ramdisk missing it boots Akai's stock system instead

  @LK19 @implemented @os_vm @owner_files @positive
  Scenario: LK19 - The stick loader starts XMP from a stick or hands over to Akai's system read-only
    Given Akai's signed MPC 3.10.0 updater is on this Mac
    When I build the stick loader image from it
    Then only Akai's boot script differs, and it carries the loader
    And without a stick the loader mounts the root= partition read-only and runs its /sbin/init
    And with an XMP system image on the stick it starts that system and never mounts the root partition
    And with a stick but no XMP system it hands over to Akai's system
    And the root disk is byte-identical after every boot

  @LK20 @implemented @os_vm @owner_files @positive
  Scenario: LK20 - The XMP session on the stick plays pads and a touch sequencer through the audio card, limited to -12 dBFS
    Given Akai's signed MPC 3.10.0 updater is on this Mac
    When I build the session system image and boot it through the stick loader
    Then the loader starts the session from the stick and the session accepts only the allowed audio card
    And scripted controller bytes are parsed into pad, button, control and SysEx events and logged to the stick
    And the pads are heard in the recorded output, which never exceeds -12 dBFS, with no xruns
    And the session switches the machine off when it ends and at the power button
    And touches program a pattern that plays on exact sixteenths, records a live pad and follows a tempo change
    And the pattern is saved to the stick
    And track buttons, synth steps and the level knob build an eight-track song that plays on exact quarter notes
    And the eight-track song is saved to the stick
    And the root disk is byte-identical after every session

  @LK18 @implemented @host_only @negative
  Scenario: LK18 - The Live Mk1 flash tool writes only the rootfs, only to the confirmed Live
    Given a simulated fastboot device in update mode
    When the flash tool is asked for a dry run, a Force, extra devices or forbidden commands
    Then the dry run sends no write and every other request is refused before any write
    And a confirmed flash sends exactly the unlock, the rootfs image and a reboot

  @LK06 @implemented @host_only @positive
  Scenario: LK06 - The runtime probe recognizes Live Mk1 hardware read-only
    Given a system snapshot derived from the official ACV8 device tree
    When XMP probes the hardware read-only
    Then it reports battery, mains power, USB audio, the DSI panel and touch input
    And it marks the Live Mk1 unverified until exact-unit evidence exists

  @LK07 @implemented @host_only @negative
  Scenario: LK07 - The runtime probe stops at identity on the protected Force
    Given a system snapshot whose device tree identifies the Force
    When XMP probes the hardware read-only
    Then discovery stops after reading the identity files
    And XMP refuses to run on the protected instrument

  @LK08 @planned @host_only @manual @positive
  Scenario: LK08 - Select the device tree from the owner's recorded Live Mk1 identity
    Given the owner has recorded the Live Mk1 model, firmware and SoC revision from its stock screens
    When XMP selects the matching official device tree from that record
    Then exactly one of ACV8 or ACV8-C is chosen with the record's hash
    And the unit itself was not connected, mounted or changed

  @LK09 @planned @usb_lab @hardware_only @positive
  Scenario: LK09 - Boot the XMP kernel on the Live Mk1 under a device-specific authorization
    Given a written, owner-approved plan names this exact Live Mk1 and its recovery route
    When the XMP kernel is started without modifying internal storage
    Then the hardware probe reports battery, USB audio, panel and touch from the real unit
    And the unit returns to its stock firmware after power-off
