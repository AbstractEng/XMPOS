# Testing deployed XMP over USB

The goal is to test a specifically authorized MPC Live Mk1 after XMP has been deployed, while keeping XMP fully usable without the attached computer. The USB test connection is optional to normal operation. The [P11 host lab foundation](hardware-lab.md) now implements typed fixtures, a mutually authenticated local simulator process and native playback-disconnect contracts. The physical USB transport, deployed agent and device-specific deployment path remain unimplemented and unverified. The interfaces below remain the requirements for those future physical components.

The owner's Akai Force remains passive host inventory only. No part of this plan authorizes a Force handshake, shell, MIDI output, mode change, software installation or firmware operation. Current authorization for future Live Mk1 experiments must be obtained for a concrete device-specific proposal, as required by `AGENTS.md`.

## Deployment and test control are separate

First prove the exact board, firmware, available interfaces and recovery path. Review a device-specific deployment proposal before changing the Live Mk1. Installing a lab agent is itself a device change and is not inferred from USB discovery. A successful application launch on stock Akai Linux is recorded as `stock-linux-xmp-app`; it does not qualify an `independent-xmp-image` OS release.

Never assume a stock USB cable exports a shell, network interface, internal disk or controllable debug endpoint. Verify the device-side USB port/controller role and the Mac/Linux host driver requirements. Do not connect two host-only ports or switch instrument modes to make a test work automatically.

If the reviewed XMP Linux image supports it, an isolated USB Ethernet gadget interface is a candidate transport. The agent must bind only to that interface, not the studio LAN. A bounded framed USB serial/vendor transport is an alternative only after its actual kernel and host support is established. The transport decision is a P11 prerequisite and must be recorded. No auto-fallback may enable SSH, gadget mode, rooting, mass storage or firmware update mode.

## Future adapter contract

The host harness exposes typed operations equivalent to opening an authorized session, obtaining capabilities/status, staging a bounded fixture, triggering a named test action, subscribing to a bounded event/log stream, fetching results and closing the session. Targets implement that contract through distinct host/native/VM/USB adapters. Step definitions cannot obtain an arbitrary shell, filesystem path or raw USB endpoint.

Physical actions and simulated musical commands remain distinct. Injecting a virtual pad event tests sequencer behavior; it does not test a pad sensor. Hardware scenarios need a physical actuator or a recorded human procedure and evidence. Likewise, fetching a rendered WAV from the device tests the rendering code; it does not measure the internal codec or analog audio path.

## Preflight and session lifecycle

1. Select the USB-lab profile and exact authorized device from the private lab ledger. A generic allow flag, USB vendor ID or port index is insufficient. Reject protected Force records, unknown targets, missing authorization and expired sessions before opening a link.
2. Require the device to already be running the reviewed XMP lab build and a deliberately enabled agent. Device-side setup is performed only through the separately approved deployment procedure.
3. Open only the verified transport. Mutually authenticate host and device using credentials provisioned during that approved setup. Verify a fresh challenge, device key fingerprint, model, running XMP build hash, boot tier and protocol version. Validate the actual peer rather than trusting cached product strings.
4. Negotiate capabilities and compare them with the scenario's fixture and measurement requirements. Stop on mismatch. Do not downgrade the test to a simulator or bypass a missing hardware feature.
5. Create a per-run disposable lab namespace. Bound fixture count, size, duration, path depth and command rate. Names are opaque IDs, never paths supplied by a test. Uploads are hash verified and cannot target user projects or system partitions.
6. Run only named allowlisted test actions such as loading the fixture, transport actions and registered parameter changes. The API has no shell, flash, reboot, driver, arbitrary-file-write or OS installation endpoint. Package-management scenarios use only preapproved hashed test packages in the disposable application store, through the application's normal workflow; the agent cannot install arbitrary uploaded code. Update/recovery work uses a separate explicitly authorized workflow.
7. Fetch reports, actual capture references and logs. Record acknowledged command revisions, device monotonic timestamps, host timestamps and the calibration that relates them. Stop any test-owned recording and clean only its disposable namespace according to the test contract.
8. On USB loss, invalidate the session and discard pending host commands. The standalone engine continues its normal playback policy without needing a host heartbeat. Reconnection requires fresh attestation; commands are never replayed onto a replacement device at the same port.

## What USB can and cannot measure by itself

The USB link can control a qualified test agent and retrieve digital traces, counters, internally rendered audio, logs and state snapshots. It can verify save/load, deterministic scheduling, parameter behavior, package compatibility and service status on the actual device.

To qualify actual analog audio, route device outputs through an approved calibrated capture or loopback fixture. To measure pad-to-sound timing, capture a physical trigger reference and the resulting audio with a shared or calibrated clock. To measure MIDI, use explicitly selected approved loopback/measurement ports and exclude every Force port. Document fixture wiring, clock drift, capture rate, trial count and noise floor. USB control round-trip time cannot substitute for audio latency.

Battery and power tests require real device observations. Destructive power interruption and firmware recovery are first exercised in VM snapshots; they are not implicitly allowed on the Live Mk1. Required manual observations remain unqualified until recorded and reviewed.

## User flow once implemented

After the separate deployment is approved and complete, the operator starts the reviewed lab image, deliberately enables its lab session, connects the verified USB port, and selects the exact device in the host runner. The host shows model, build, boot tier, capabilities and permitted test operations. The operator runs a named suite and gets per-scenario results and evidence. Unplugging USB leaves XMP usable as a standalone instrument. Reconnecting retrieves results only after the same device authenticates again.

The current `npm run bdd:usb` command intentionally refuses to connect because this adapter does not exist yet. The executable policy regression verifies that neither Force nor Live Mk1 metadata can cause a physical transport factory to run today. Those pure host checks are not evidence that a real USB link or deployed agent works.
