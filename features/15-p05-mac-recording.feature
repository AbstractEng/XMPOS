@implemented @native @manual @p05_mac_recording
Feature: Record through the explicitly selected built-in MacBook microphone
  @positive
  Scenario: Keep a real two-bar input take without opening any output or Akai device
    Given the local Studio recording service reports the built-in MacBook microphone
    When the musician explicitly starts a two-bar recording at 120 BPM
    Then a complete four-second microphone WAV is returned with stopped input and no output stream
    And that take can be kept and reopened in an isolated XMP project
    And formal loopback, OS and USB qualification remain pending
