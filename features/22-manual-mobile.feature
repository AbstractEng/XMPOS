@manual_e2e @browser_e2e @implemented @standalone
Feature: Read the quick start and manual on a phone
  The built manual must remain readable without opening audio or hardware.

  @MM01 @positive
  Scenario Outline: Read the quick start at <width> pixels wide
    Given I open the manual at <width> pixels wide
    When I follow the Quick start link
    Then the six-step first-loop recipe is visible below the header
    And the manual fits the screen with readable controls and contained reference tables
    Examples:
      | width |
      | 320   |
      | 390   |
      | 768   |
      | 844   |
      | 1280  |

  @MM02 @positive
  Scenario: Use chapter navigation and search on a small phone
    Given I open the manual at 320 pixels wide
    When I open Chapters and choose Buttons and navigation
    Then the chapter is readable below the sticky header and its table can scroll locally
    When I search the manual for MIDI destination
    Then matching chapters are shown without horizontal page scrolling
    When I use Chapters to return to Quick start
    Then the search is cleared and the quick start is visible

  @MM03 @positive
  Scenario: Read the quick start with enlarged text
    Given I open the manual at 390 pixels wide
    When I enlarge the manual text and follow Quick start
    Then the quick start and header remain inside the screen

  @MM04 @negative
  Scenario: Read and navigate the manual when JavaScript is unavailable
    Given I open the phone manual without JavaScript
    When I follow the Quick start link
    Then the six-step recipe and native chapter disclosure still work

  @MM05 @positive
  Scenario: Follow the hardware setup immediately after quick start
    Given I open the manual at 390 pixels wide
    When I use Chapters to open hardware setup
    Then hardware setup is the next section after quick start
    And the installer workflow explains USB preparation and the owner-confirmed rootfs write
    And the stock handover and full stock restoration routes are distinct

  @MM06 @positive
  Scenario: Watch the three short hardware setup demonstrations
    Given I open the manual at 1280 pixels wide
    When I play and seek the hardware setup videos
    Then all three hardware setup videos have captions and play for less than one minute
    And the setup media is labelled as an installer simulation
