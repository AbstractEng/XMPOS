@P09
Feature: Develop and install community instruments through stable interfaces

  @planned @stage_gate @positive @os_vm @usb_lab
  Scenario: Build and use an original community instrument without rebuilding the OS
    Given a contributor starts from the documented instrument template
    When the contributor adds parameters, tests the instrument and creates a package
    And a musician installs it into an authorized XMP application environment
    Then it receives the same musical control contract as the built-in instruments
    And a project using it reopens with the same parameter and preset state
    And the underlying OS image hash is unchanged

  @P09_1 @planned @positive @native @os_vm @usb_lab
  Scenario: Negotiate compatible application and DSP APIs
    Given a module declares a supported API version, architecture and parameter schema
    When the host validates and loads it
    Then its parameters have stable identities, units, ranges and defaults
    And the module receives only its declared host capabilities

  @P09_1 @implemented @negative @host_only
  Scenario: Reject a module with incompatible or undeclared privileges
    Given a package requests an unknown API, wrong architecture or undeclared device access
    When a musician tries to load it
    Then validation rejects it before running module code
    And the running project and existing modules remain unchanged

  @P09_2 @implemented @positive @host_only
  Scenario: Complete the documented developer quickstart
    Given a clean supported development environment
    When a contributor follows the quickstart to create an instrument and an effect
    Then both examples build, run their behavioral tests and preview without an Akai connected
    And the generated packages include manifests, licences and parameter documentation

  @P09_2 @implemented @negative @host_only
  Scenario: Report a missing dependency during packaging
    Given an example references a DSP library absent from its declared dependencies
    When the contributor builds the installable package
    Then packaging fails with the unresolved dependency and its required version
    And it does not silently use a globally installed copy

  @P09_3 @planned @positive @os_vm @usb_lab
  Scenario: Upgrade and roll back a package used in a project
    Given a saved project uses a package with a known state version
    When the musician installs a compatible upgrade and later rolls it back
    Then parameter and preset state is migrated or restored by the package contract
    And package and project changes commit transactionally

  @P09_3 @planned @negative @native @os_vm @usb_lab
  Scenario: Reject a corrupted or path-traversing package
    Given a package has a mismatched hash, missing licence or an escaping asset path
    When the musician requests installation into the test package store
    Then validation rejects the package before executing code or committing files
    And files outside the package store and all device firmware remain untouched

  @P09_4 @planned @positive @desktop @os_vm @usb_lab @fault_injection
  Scenario: Recover an application UI crash independently of audio
    Given an instrument UI runs in an isolated process
    When its UI crashes while the engine is playing
    Then the engine follows the documented continuing-audio policy
    And the musician can reopen the UI with its last acknowledged state

  @P09_4 @planned @negative @native @os_vm @usb_lab @fault_injection
  Scenario: Treat a native DSP crash as an explicit host fault
    Given a trusted native DSP module executes inside the audio host process
    When it crashes in an isolated test host
    Then the supervisor records the host fault and enters the documented safe recovery state
    And the report does not claim that a manifest sandbox contained the native crash

  @P09_1 @implemented @positive @standalone @instrument_design
  Scenario: Route supported expression to one stable note identity
    Given a virtual input and an instrument both declare per-note pressure, pitch and timbre
    And two overlapping voices have distinct stable note identities
    When the input changes only the first note's expression and the project records the take
    Then only that voice changes and the second voice retains its expression values
    And save and reopen preserve note ownership, timestamps and supported expression dimensions

  @P09_1 @implemented @negative @host_only @instrument_design
  Scenario: Reject expression capabilities that the source or instrument does not provide
    Given a module accepts velocity but does not declare per-note pitch or pressure
    When an input requests those unsupported dimensions
    Then capability negotiation reports them unavailable before delivery
    And existing notes keep their values without channel-wide expression leaking across voices

  @implemented @software_gate @positive @host_only
  Scenario: Build, install and reopen a community instrument in the Mac SDK workbench
    Given the Mac contributor creates an original declarative instrument package
    When the workbench installs it, binds an XMP track and renders its recorded note take
    Then reopening preserves the package hash, parameter values and note identities
    And the host source baseline and all hardware remain unchanged

  @P09_1 @implemented @positive @host_only
  Scenario: Share musical contracts between the Mac SDK and a compiled native ABI fixture
    Given a supported portable manifest declares its parameter units and optional expression
    When the SDK negotiates it and the locally compiled native ABI probe runs
    Then both contracts retain stable note ownership and reject incompatible versions
    And native, VST, CV and physical-input package adapters remain unavailable

  @P09_3 @implemented @positive @host_only
  Scenario: Upgrade and roll back a community package transaction on the Mac
    Given a Mac package store contains a bound project with a known parameter state
    When a compatible package renames that parameter and the musician rolls back
    Then the upgrade migrates state and automation and rollback restores the exact previous snapshot
    And a stale writer or staged storage failure preserves the committed project

  @P09_3 @implemented @negative @host_only
  Scenario: Reject unsafe package data before changing the Mac package store
    Given an owned Mac store and an outside sentinel file exist
    When corrupt, unlicensed, incompatible and path-traversing packages request installation
    Then every invalid package is rejected before committing files or executing code
    And the outside sentinel, committed store and protected devices remain unchanged

  @P09_4 @implemented @positive @host_only @fault_injection
  Scenario: Restart a real UI child while the independent virtual engine continues
    Given the community UI is a separate child and the native virtual engine is playing
    When the UI acknowledges a parameter and then crashes
    Then the same engine process and musical clock continue with finite captured audio
    And a new UI child restores its last acknowledged state with denied writes and child creation

  @P09_4 @implemented @negative @host_only @fault_injection
  Scenario: Report a fatal callback injection as a native host fault
    Given a locally compiled trusted native DSP fixture runs in an isolated test host
    When its DSP callback terminates that host
    Then the supervisor reports a host fault with no output and no automatic note restart
    And it explicitly reports that a manifest sandbox did not contain the crash
