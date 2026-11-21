@machine_pages @browser_e2e @implemented @standalone
Feature: Machines with their own pages, the Sampler, the data dial and clip length
  The built Device view in a real browser, driven only by its screen, panel and
  file inputs. No audio output, microphone or hardware is used.
  Pads are numbered 1–4 across the bottom and 13–16 across the top.

  Background:
    Given I start a new empty song in an isolated browser

  @MP01 @positive
  Scenario: A new track asks which machine it should be
    When I open the Sound page of track 2
    Then it asks me to choose its machine from Kit, Sampler, Synth and MIDI
    And pads 1 to 4 are labelled Kit, Sampler, Synth and MIDI
    When I press pad 3
    Then track 2 becomes a Subtractive synth
    And its Sound page has Presets and Controls tabs

  @MP02 @positive
  Scenario: A synth's Sound page shows its presets or every control
    Given track 2 is a Subtractive synth
    When I open the Sound page of track 2
    Then the preset pads are shown
    When I choose the Controls tab
    Then the oscillator, tone, resonance, filter envelope, attack, detune and glide controls are shown
    And the top pads play notes instead of choosing presets

  @MP03 @negative
  Scenario: The Sample page is only for Kit and Sampler tracks
    Given track 2 is a Subtractive synth
    When I open MENU with track 2 selected
    Then the Sample page is unavailable and says it is for Kit and Sampler tracks
    When I open MENU with track 1 selected
    Then the Sample page opens for track 1

  @MP04 @positive
  Scenario Outline: Chop a take on a Sampler track by <method>
    Given track 3 is a Sampler with a WAV take of four hits
    When I chop the take by <method>
    And I keep the slices
    Then track 3 plays <slices> slices of one sample on pads 1 to <slices>, in order
    And its Sound page offers to chop or edit the sample again

    Examples:
      | method     | slices |
      | Transients | 5      |
      | Even       | 8      |
      | By hand    | 5      |

  @MP05 @positive
  Scenario: Lazy chop marks a slice at each pad tap while the take plays
    Given track 3 is a Sampler with a WAV take of four hits
    When I start lazy chop and tap a pad twice as the take plays
    And I stop lazy chop and keep the slices
    Then track 3 plays 3 slices of one sample on pads 1 to 3, in order

  @MP06 @positive
  Scenario: Keep a take as keys
    Given track 3 is a Sampler with a WAV take of four hits
    When I choose Keys and keep the take
    Then every pad of track 3 plays the whole sample as notes

  @MP07 @positive
  Scenario: The data dial moves through the page's items and acts on the highlighted one
    Given track 2 is a Subtractive synth
    When I open the Mixer and turn the data dial once to the right
    Then track 2 is selected
    When I open the synth's Controls, turn the data dial twice and press it
    Then the Resonance editor opens
    When I cancel it, choose the Presets tab, turn the data dial nine times and press it
    Then the tenth preset is chosen on preset page 2

  @MP08 @positive
  Scenario: Clips fills the page with clips and scrolls through scenes
    When I press MAIN
    Then no text line sits above the track names
    And the four rows of clips fill the page down to the status line
    When I press the down arrow in the grid's corner
    Then scenes 5 to 8 are shown

  @MP09 @positive @negative
  Scenario Outline: Change clip length on a <machine> track and shorten it safely
    Given track <track> is a <machine>
    When I open its first clip, set Length to 32 steps and add a note on step 17
    And I set Length to 16 steps but cancel the question
    Then the clip is still 32 steps long with its note on step 17
    When I set Length to 16 steps and confirm the question
    Then the clip is 16 steps long and the note on step 17 is gone
    When I press UNDO
    Then the clip is still 32 steps long with its note on step 17

    Examples:
      | machine | track |
      | Kit     | 1     |
      | Synth   | 2     |
      | Sampler | 3     |
      | MIDI    | 4     |

  @MP10 @positive
  Scenario: Pick any root note and scale for a melodic track
    Given track 2 is a Subtractive synth
    When I open the Play page of track 2 and choose root D and scale Dorian
    Then pads 1 to 8 play D3 E3 F3 G3 A3 B3 C4 D4

  @MP11 @positive
  Scenario Outline: Switch a Sampler from <layout> to Kit and replace its sounds from Sound
    Given track 3 is a Sampler with a WAV take of four hits
    When I keep the Sampler take as <layout> and change the machine to Kit from Sound
    Then track 3 has the project's 16 distinct pad sounds and Sound offers Load kit alongside its machine control
    When I load XMP 808 from the Kit Sound page
    Then track 3 shows the XMP 808 pad sounds and the other tracks and clips keep their settings
    When I press UNDO
    Then track 3 has its previous kit again

    Examples:
      | layout |
      | Keys   |
      | Slices |
