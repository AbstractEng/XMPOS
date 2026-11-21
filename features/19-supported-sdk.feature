@sdk_supported @implemented
Feature: Develop supported machines with an independent SDK and measured native parity
  These are software development contracts, not physical or full Studio parity qualification.

  @S01 @positive @host_only
  Scenario: Install the SDK offline outside the XMP repository and inspect compatibility
    Given a new contributor installs the supported SDK tarball in an isolated directory
    When the contributor checks the SDK doctor, compatibility and TypeScript API
    Then the installed SDK works without repository sources, workspace links or registry access
    And it reports module API 2 and DSP ABI 1 with no hardware access

  @S01 @positive @host_only
  Scenario: Rebuild the supported distribution reproducibly
    Given a new contributor installs the supported SDK tarball in an isolated directory
    When the maintainer rebuilds the same SDK source in a second fresh directory
    Then the two SDK tarballs and their source identities match

  @S02 @positive @host_only
  Scenario: Use delivered SDK documentation and examples without a repository checkout
    Given a new contributor installs the supported SDK tarball in an isolated directory
    When the contributor checks the SDK doctor, compatibility and TypeScript API
    And the contributor uses only the bundled manuals and examples
    Then every installed documentation link resolves and the instrument effect and UI examples work offline

  @S02 @positive @host_only
  Scenario Outline: Complete a supported instrument or effect development loop
    Given a new contributor installs the supported SDK tarball in an isolated directory
    When the contributor scaffolds, builds, tests and previews an "<kind>"
    And the contributor compares that package with the compiled native renderer
    Then the preview has finite nonzero audio and the native package parity passes
    And existing destinations and an outside sentinel remain unchanged
    Examples:
      | kind       |
      | instrument |
      | effect     |

  @S03 @positive @host_only
  Scenario: Compare event timing, DSP, voice admission and note cleanup
    Given a new contributor installs the supported SDK tarball in an isolated directory
    When the contributor runs the five native conformance fixtures
    Then independent timing, impulse and voice-limit oracles pass with matching event acknowledgements
    And the report retains numerical errors and leaves real-time and hardware qualification false

  @S03 @negative @host_only
  Scenario: Refuse false parity despite similar audio
    Given a valid reference and compiled native conformance capture
    When one event moves by one frame, PCM is altered, or a voice remains active
    Then each mismatch fails parity without changing the fixed tolerance profile

  @S01 @S02 @negative @host_only
  Scenario: Preserve work when unsupported packages or device targets are requested
    Given a new contributor installs the supported SDK tarball in an isolated directory
    When an incompatible package or physical target flag is submitted
    Then the SDK rejects it before creating a native render or overwriting existing files
    And the Force and all physical adapters remain unopened

  @S04 @positive @os_vm @sdk_vm
  Scenario: Compare host and actual native guest execution in a booted generic VM
    Given the frozen generic VM profile excludes networking, host shares and USB passthrough
    When the five SDK fixtures run in the host and in both guest backends
    Then all fifteen comparisons pass with current source, image and native binary identities
    And malformed guest plans are rejected and physical qualification remains pending
