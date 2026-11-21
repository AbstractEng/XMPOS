@P11
Feature: Qualify explicitly authorized deployed XMP hardware over a verified USB link

  @planned @stage_gate @positive @usb_lab @hardware_only
  Scenario: Test a deployed Live Mk1 over USB and continue playing after disconnect
    Given a specifically authorized Live Mk1 is running the reviewed XMP lab build
    And a documented USB transport and authenticated lab session identify that exact target
    When the host loads the bounded eight-track test fixture and runs its song journey
    And captures actual internal audio through an approved physical loopback fixture
    And the USB cable is disconnected while playback continues
    Then the device keeps its local transport and project state without the host computer
    And reconnecting retrieves results for the same build and device only
    And the Force has received no device connection or command

  @P11_1 @planned @positive @host_only
  Scenario: Review device-specific deployment and recovery evidence before lab work
    Given stock observations identify the Live Mk1 model and its installed firmware
    And the device-specific boot, recovery and USB capabilities have supporting evidence
    When the proposed deployment is reviewed against that exact device
    Then its reversible or recoverable steps and remaining risks are explicit
    And lab authorization names the device, operations, build and session lifetime

  @P11_1 @implemented @negative @host_only
  Scenario: Refuse hardware work when the USB or recovery path is unproven
    Given a stock device has no verified XMP boot or USB test transport
    When the host requests a hardware qualification session
    Then it reports the missing capability and does not open a command session
    And it does not enable SSH, USB gadget mode, rooting or a firmware update as a fallback

  @P11_2 @planned @positive @usb_lab @hardware_only @manual
  Scenario: Verify real controls and device services against measured fixtures
    Given the lab build reports the exact Live Mk1 board and adapter versions
    When a physical actuator or recorded human procedure presses every pad at known force levels
    And operates touch, encoders, transport, MIDI and battery-powered playback
    Then sensor events, velocity curves and physical audio match the hardware acceptance profile
    And pressure and continuous gesture dimensions are enabled only when the exact sensors have measured support
    And human observations remain pending until their signed evidence is attached

  @P11_2 @planned @negative @usb_lab @hardware_only @fault_injection
  Scenario: Handle an unavailable hardware service without fabricating support
    Given an isolated hardware test fixture withholds a required codec or battery reading
    When the device starts its adapters
    Then it reports the missing service and enters the documented safe operating state
    And the hardware qualification result cannot pass using simulator values

  @P11_3 @planned @positive @usb_lab @hardware_only
  Scenario: Authenticate a bounded lab session over the verified USB transport
    Given an authorized XMP lab image already exposes a verified isolated USB link
    When the host verifies device identity, build hash, protocol version and session challenge
    Then only typed status, fixture and test operations declared for that session are enabled
    And fixture writes are confined to the disposable lab namespace with explicit size limits
    And no arbitrary shell, firmware-write, global filesystem or deployment operation is exposed

  @P11_3 @implemented @negative @host_only
  Scenario: Block the protected Force and stale or mismatched lab authorization
    Given preflight receives a Force identity or an expired or mismatched target authorization
    When a USB lab session is requested
    Then policy rejects it before attempting a USB handshake or opening device handles
    And neither a generic allow flag nor a matching vendor ID can bypass the rejection

  @P11_4 @planned @positive @usb_lab @hardware_only @physical_measurement
  Scenario: Collect genuine hardware timing and audio evidence
    Given the qualified Live Mk1 workload is running with calibrated audio and MIDI capture fixtures
    When the host runs the shared musical contracts and physical timing measurements
    Then results include the hardware build, workload, capture calibration and actual measurement distributions
    And each required analog, control and MIDI limit in the selected profile is evaluated independently

  @P11_4 @planned @negative @usb_lab @hardware_only @fault_injection
  Scenario: Prevent reconnect and target-swap errors during a test
    Given a lab session is active on an authorized Live Mk1
    When its USB cable disconnects and a different device reconnects at the same host port
    Then the host invalidates the old session and sends no replayed or queued commands
    And only reauthorization of the original target can resume control
    And the original device's local playback is independent of host connectivity

  @implemented @positive @host_only @host_development_gate
  Scenario: Exercise the P11 lab foundation without an instrument
    Given an isolated host lab bench with a real native virtual-audio engine
    When the host authenticates the simulator and stages the approved eight-track fixture
    And starts playback and disconnects the lab control session
    Then native playback and its project identity continue independently
    And a fresh authenticated session retrieves the same fixture results
    And every report leaves physical hardware qualification pending

  @P11_1 @implemented @positive @host_only
  Scenario: Prepare a blocked exact-unit dossier from pinned reference research
    Given the pinned official and community hardware research catalog
    When a new Live Mk1 bring-up dossier is reviewed without stock observations
    Then firmware, board, boot, recovery, USB and owner evidence remain explicit prerequisites
    And neither upstream board defaults nor source archives authorize device access

  @P11_1 @implemented @negative @host_only
  Scenario: Reject evidence borrowed from another firmware or device
    Given a complete synthetic exact-unit review dossier
    When a boot receipt is rebound to another firmware and alias
    Then that receipt cannot satisfy the target prerequisites
    And even a complete dossier cannot enable a physical adapter

  @P11_2 @implemented @positive @host_only
  Scenario: Normalize declared control events in the host adapter model
    Given versioned host fixtures for pads, touch, encoders, transport and battery
    When every pad velocity and the touch surface corners are normalized
    Then the normalized values follow the declared bounds and preserve event timestamps
    And control events retain simulator provenance without inferred sensor dimensions

  @P11_2 @implemented @negative @host_only
  Scenario: Keep missing codec and battery services unavailable
    Given host adapter reports omit internal audio and battery
    When adapter readiness is evaluated
    Then the model enters safe recovery and names both missing services
    And simulator readings and unsupported pressure cannot qualify hardware

  @P11_3 @implemented @positive @host_only
  Scenario: Mutually authenticate the opt-in host lab prototype
    Given an isolated host lab bench with a real native virtual-audio engine
    When a fresh TLS session binds the host, simulator, build and approved fixture
    Then its identity proof is bound to the fresh channel and session lifetime
    And only granted typed operations and disposable fixture identifiers are accepted

  @P11_3 @implemented @negative @host_only
  Scenario: Reject tampered fixtures and replayed control frames
    Given an authenticated host lab session with an approved fixture
    When a fixture hash, destination identifier or command shape is tampered with
    Then the agent rejects each request without staging or dispatching it
    When an accepted control frame is replayed
    Then the session closes and its pending commands cannot cross a reconnect

  @P11_4 @implemented @positive @host_only
  Scenario: Keep native playback alive when the lab process exits
    Given an authenticated host lab session playing the approved fixture
    When the host lab agent process exits
    Then the independent native engine keeps advancing with the same project
    And its virtual capture contains audio without claiming physical output

  @P11_4 @implemented @negative @host_only
  Scenario: Refuse a replacement peer at the same local lab address
    Given an authenticated host lab session playing the approved fixture
    When a different simulator certificate replaces the original at the same socket address
    Then the pinned host rejects the new peer before test commands are enabled
    And old commands are neither replayed nor redirected to the replacement

  @P11_4 @implemented @negative @host_only
  Scenario: Keep calibration gaps and simulator measurements out of hardware qualification
    Given independent metric fixtures include passing, failing and missing captures
    When analog, control and MIDI distributions are evaluated separately
    Then missing or control-round-trip evidence remains inconclusive rather than zero
    And passing simulator distributions leave formal physical qualification pending

  @P11_3 @implemented @negative @host_only
  Scenario: Refuse an unapproved host certificate and mismatched session identity
    Given an isolated host lab bench with a real native virtual-audio engine
    When another trusted-CA client certificate attempts to authenticate
    Then the agent refuses the unapproved host identity without engine actions
    And expired grants and mismatched build identities cannot open a lab command session
