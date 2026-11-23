import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@playwright/test";
import { newContext } from "./production.steps.mjs";

const ready = async (page) => {
  await page.goto(`${process.env.XMP_E2E_ORIGIN}/manual/`);
  await expect(
    page.getByRole("heading", { name: /Make a loop\.\s*Make it yours\./ }),
  ).toBeVisible();
};
async function noPageOverflow(page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
}
async function visibleBelowHeader(page, selector) {
  await expect
    .poll(() =>
      page.evaluate((target) => {
        const box = document.querySelector(target).getBoundingClientRect();
        const header = document.querySelector(".toolbar").getBoundingClientRect();
        return box.top >= header.bottom - 1 && box.top < innerHeight;
      }, selector),
    )
    .toBe(true);
}
Given("I open the manual at {int} pixels wide", async function (width) {
  this.manualWidth = width;
  await this.page.setViewportSize({ width, height: width === 844 ? 390 : 900 });
  await this.page.emulateMedia({ reducedMotion: "reduce" });
  await ready(this.page);
});
When("I follow the Quick start link", async function () {
  await this.page
    .locator(".hero-links")
    .getByRole("link", { name: /Quick start/ })
    .click();
});
Then("the six-step first-loop recipe is visible below the header", async function () {
  await expect(this.page.locator("#quick-start")).toBeVisible();
  await expect(this.page.locator(".quick-recipe > li")).toHaveCount(6);
  await expect(this.page.locator("#quick-start")).toContainText("Download saved project");
  await expect(this.page.locator("#quick-start")).toContainText("PLAY START");
  await visibleBelowHeader(this.page, "#quick-start-title");
});
Then(
  "the manual fits the screen with readable controls and contained reference tables",
  async function () {
    await noPageOverflow(this.page);
    if (this.manualWidth <= 960) {
      const sizing = await this.page.locator("#manual-search").evaluate((input) => ({
        size: Number.parseFloat(getComputedStyle(input).fontSize),
        height: input.getBoundingClientRect().height,
      }));
      assert.ok(sizing.size >= 16 && sizing.height >= 44);
      await this.page.getByRole("link", { name: "Chapters", exact: true }).click();
      for (const link of await this.page.locator(".mobile-contents nav a").all())
        assert.ok((await link.boundingBox()).height >= 44);
      await this.page
        .locator(".mobile-contents")
        .getByRole("link", { name: /Quick start/ })
        .click();
      await visibleBelowHeader(this.page, "#quick-start-title");
    }
    for (const table of await this.page.locator(".table-scroll").all()) {
      assert.ok(
        await table.evaluate((element) => element.getBoundingClientRect().width <= innerWidth),
      );
    }
    await this.page.screenshot({ path: `${this.directory}/manual-${this.manualWidth}.png` });
  },
);
When("I open Chapters and choose Buttons and navigation", async function () {
  await this.page.getByRole("link", { name: "Chapters", exact: true }).click();
  await expect(this.page.locator("#manual-contents")).toHaveAttribute("open", "");
  await this.page
    .locator(".mobile-contents")
    .getByRole("link", { name: /Buttons & navigation/ })
    .click();
});
Then(
  "the chapter is readable below the sticky header and its table can scroll locally",
  async function () {
    await visibleBelowHeader(this.page, "#workspace h2");
    await expect(this.page.locator("#manual-contents")).not.toHaveAttribute("open", "");
    const table = this.page.locator("#workspace .table-scroll");
    await expect(table).toHaveAttribute("tabindex", "0");
    const scroll = await table.evaluate((region) => {
      region.scrollLeft = region.scrollWidth;
      return region.scrollLeft;
    });
    assert.ok(scroll > 0);
    await noPageOverflow(this.page);
  },
);
When("I search the manual for MIDI destination", async function () {
  await this.page
    .getByRole("searchbox", { name: "Search manual chapters" })
    .fill("MIDI destination");
});
Then("matching chapters are shown without horizontal page scrolling", async function () {
  await expect(this.page.locator("#sounds")).toBeVisible();
  await expect(this.page.locator("#workspace")).toBeHidden();
  await expect(this.page.locator("#search-status")).toContainText("chapters match");
  await noPageOverflow(this.page);
});
When("I use Chapters to return to Quick start", async function () {
  await this.page.getByRole("link", { name: "Chapters", exact: true }).click();
  // Chapter navigation can return to a nonmatching chapter and clear search.
  await this.page
    .locator(".mobile-contents")
    .getByRole("link", { name: /Quick start/ })
    .click();
});
Then("the search is cleared and the quick start is visible", async function () {
  await expect(this.page.locator("#manual-search")).toHaveValue("");
  await visibleBelowHeader(this.page, "#quick-start-title");
  await expect(this.page.locator("#workspace")).toBeVisible();
});
When("I enlarge the manual text and follow Quick start", async function () {
  await this.page.evaluate(() => {
    // Capture original sizes first so nested links are enlarged once, not repeatedly.
    const sizes = [...document.querySelectorAll("p,a,button,input,summary,h2,h3,code")].map(
      (element) => [element, Number.parseFloat(getComputedStyle(element).fontSize)],
    );
    for (const [element, size] of sizes) element.style.fontSize = `${size * 2}px`;
  });
  await this.page
    .locator(".hero-links")
    .getByRole("link", { name: /Quick start/ })
    .click();
});
Then("the quick start and header remain inside the screen", async function () {
  await noPageOverflow(this.page);
  await visibleBelowHeader(this.page, "#quick-start-title");
  await this.page.screenshot({ path: `${this.directory}/manual-large-text.png` });
});
Given("I open the phone manual without JavaScript", async function () {
  this.page = await newContext(this, {
    javaScriptEnabled: false,
    viewport: { width: 320, height: 900 },
  });
  await this.page.emulateMedia({ reducedMotion: "reduce" });
  await ready(this.page);
});
Then("the six-step recipe and native chapter disclosure still work", async function () {
  await expect(this.page.locator(".quick-recipe > li")).toHaveCount(6);
  await this.page.locator("#manual-contents summary").click();
  await this.page
    .locator(".mobile-contents")
    .getByRole("link", { name: /Start a track/ })
    .click();
  await expect(this.page).toHaveURL(/#first-beat$/);
  await noPageOverflow(this.page);
});

When("I use Chapters to open hardware setup", async function () {
  await this.page.getByRole("link", { name: "Chapters", exact: true }).click();
  await this.page
    .locator(".mobile-contents")
    .getByRole("link", { name: /Set up your MPC Live/ })
    .click();
  await visibleBelowHeader(this.page, "#hardware-setup-title");
});
Then("hardware setup is the next section after quick start", async function () {
  assert.equal(
    await this.page.locator("#quick-start").evaluate((element) => element.nextElementSibling.id),
    "hardware-setup",
  );
  await noPageOverflow(this.page);
});
Then(
  "the installer workflow explains USB preparation and the owner-confirmed rootfs write",
  async function () {
    const section = this.page.locator("#hardware-setup");
    for (const text of [
      "3.10.1 exactly",
      "Verify stock Live",
      "Prepare USB key",
      "does not format",
      "Check Live and image",
      "XMPOS",
      "root filesystem",
      "bootloader",
      "partition table",
      "Saved on stick",
    ])
      await expect(section).toContainText(text);
    await expect(this.page.locator(".hardware-path a")).toHaveCount(4);
    await expect(this.page.locator(".hardware-download-card")).toHaveCount(3);
    for (const id of ["macos", "macos-arm64", "windows"]) {
      await expect(this.page.locator(`[data-installer="${id}"]`)).toHaveAttribute(
        "href",
        /^https:\/\/github\.com\/AbstractEng\/XMPOS\/releases\/download\//,
      );
    }
  },
);
Then("the stock handover and full stock restoration routes are distinct", async function () {
  const choices = this.page.locator(".hardware-return-options");
  await expect(choices).toContainText("The loader stays installed");
  await expect(choices).toContainText("Remove the loader completely");
  await expect(choices).toContainText("Restore stock 3.10.1");
});
When("I play and seek the hardware setup videos", async function () {
  this.hardwareVideoPlayback = [];
  for (const video of await this.page.locator("#hardware-setup video").all()) {
    const playback = await video.evaluate(async (element) => {
      element.muted = true;
      await element.play();
      await new Promise((done, fail) => {
        element.addEventListener("seeked", done, { once: true });
        element.addEventListener("error", fail, { once: true });
        element.currentTime = 1;
      });
      element.pause();
      return {
        duration: element.duration,
        width: element.videoWidth,
        height: element.videoHeight,
        error: element.error?.message,
      };
    });
    this.hardwareVideoPlayback.push(playback);
  }
});
Then(
  "all three hardware setup videos have captions and play for less than one minute",
  async function () {
    const videos = this.page.locator("#hardware-setup video");
    await expect(videos).toHaveCount(3);
    assert.equal(this.hardwareVideoPlayback.length, 3);
    for (const video of await videos.all()) {
      await expect(video.locator('track[kind="captions"]')).toHaveCount(1);
      await expect(video).toHaveAttribute("controls", "");
    }
    for (const result of this.hardwareVideoPlayback) {
      assert.ok(result.duration > 15 && result.duration < 60);
      assert.equal(result.width, 1920);
      assert.equal(result.height, 1080);
      assert.equal(result.error, undefined);
    }
  },
);
Then("the setup media is labelled as an installer simulation", async function () {
  await expect(this.page.locator("#hardware-video-note")).toContainText("simulated responses");
  await expect(this.page.locator("#hardware-video-note")).toContainText("no hardware was flashed");
});
