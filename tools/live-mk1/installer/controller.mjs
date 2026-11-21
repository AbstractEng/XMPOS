import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";

// Host-only flow. All device access is delegated to the existing flash module.
export function createController({
  execute,
  pick,
  simulation = false,
  now = Date.now,
  initialSelection = null,
  rememberSelection = async () => {},
  requireUsbStage = true,
}) {
  const selectedPath = (p) =>
    typeof p === "string" && isAbsolute(p) && p.length <= 4096 && !p.includes("\0") ? p : null;
  const state = {
    simulation,
    busy: false,
    phase: null,
    progress: null,
    volumes: [],
    usbVolume: initialSelection?.usbVolume ?? null,
    usbReady: null,
    ownerImage: initialSelection?.ownerImage ?? null,
    preparationError: null,
    stockVerification: null,
    updater: selectedPath(initialSelection?.updater),
    loader: selectedPath(initialSelection?.loader),
    mode: "install",
    preview: null,
    message: "Choose your official MPC Gen 1 3.10.1 updater.",
    log: [],
  };
  if (state.loader) state.message = "Your prepared loader is selected. Check the Live and image.";
  let preview = null;
  const invalidate = () => {
    preview = null;
    state.preview = null;
  };
  const record = (line) => {
    if (line && typeof line === "object") {
      if (typeof line.phase === "string" && state.phase !== line.phase) {
        state.phase = line.phase.slice(0, 180);
        state.progress = null;
      }
      if (
        Number.isSafeInteger(line.current) &&
        Number.isSafeInteger(line.total) &&
        line.total > 0 &&
        line.current >= 0 &&
        line.current <= line.total
      )
        state.progress = { current: line.current, total: line.total };
      return;
    }
    const message = String(line);
    if (state.busy && message.startsWith("$ fastboot flash rootfs"))
      state.phase = "Writing the MPC root filesystem — keep power and USB connected";
    else if (state.busy && message.startsWith("$ fastboot reboot"))
      state.phase = "Restarting the MPC";
    state.log.push(message);
    if (state.log.length > 600) state.log.shift();
  };
  const view = () => structuredClone(state);
  async function action(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Action required");
    if (state.busy) throw new Error("Wait for the current operation to finish");
    if (typeof input.action !== "string") throw new Error("Action required");
    state.busy = true;
    state.phase =
      {
        prepare: "Preparing files on the computer",
        tools: "Setting up the computer connection",
        inspect: "Checking the MPC and image",
        "verify-stock": "Verifying stock MPC OS identity and measuring this unit's rootfs",
        write: "Preparing to write the MPC loader",
      }[input.action] ?? "Working";
    try {
      if (input.action === "updater") {
        invalidate();
        const path = await pick("updater");
        if (path) {
          state.updater = path;
          state.loader = null;
          state.ownerImage = null;
          state.preparationError = null;
          state.usbReady = null;
          state.message = "Updater selected. Prepare installation files locally.";
        }
      } else if (input.action === "prepare") {
        invalidate();
        state.preparationError = null;
        if (!state.updater) throw new Error("Choose the official 3.10.1 updater first");
        state.message = "Preparing and auditing local loader and recovery image…";
        const result = await execute({ task: "prepare", source: state.updater }, record);
        state.loader = result.directory;
        if (state.ownerImage?.sha256 !== result.ownerImage?.sha256) state.usbReady = null;
        state.ownerImage = result.ownerImage ?? null;
        state.message = "Loader and stock recovery verified. Prepare your USB key in step 2.";
      } else if (input.action === "verify-stock") {
        invalidate();
        if (input.stockConfirmed !== true)
          throw new Error(
            "Confirm this is your stock Live Mk1 and authorize the fixed read-only verification",
          );
        if (typeof input.address !== "string" || input.address.length > 15)
          throw new Error("Enter the Live's local IPv4 address");
        state.stockVerification = await execute(
          { task: "verify-stock", address: input.address, ownerReadOnlyConfirmed: true },
          record,
        );
        state.usbReady = null;
        state.message =
          "Stock 3.10.1 and this Live's rootfs measurement verified. Prepare the USB key next; fastboot must match this same unit.";
      } else if (input.action === "tools") {
        invalidate();
        if (input.acceptTerms !== true)
          throw new Error("Accept Google's Platform-Tools terms first");
        await execute({ task: "tools" }, record);
        state.message = "USB support is ready.";
      } else if (input.action === "loader") {
        invalidate();
        const path = await pick("loader");
        if (path) {
          await execute({ task: "verify-loader", source: path }, record);
          state.loader = path;
          state.message = "Existing loader verified. Connect the Live Mk1 in update mode.";
        }
      } else if (input.action === "list-usb") {
        state.volumes = await execute({ task: "list-usb" }, record);
        state.message = state.volumes.length
          ? "Choose the removable FAT32 USB key."
          : "Connect a removable FAT32 USB key, then refresh.";
      } else if (input.action === "select-usb") {
        invalidate();
        const selected = state.volumes.find((v) => v.deviceKey === input.deviceKey);
        if (!selected) throw new Error("Choose a USB key from the refreshed list");
        const result = await execute({ task: "select-usb", volume: selected }, record);
        if (state.usbVolume?.deviceKey !== result.volume.deviceKey) state.usbReady = null;
        state.usbVolume = result.volume;
        state.message = "USB key selected. Its existing projects and samples will be preserved.";
      } else if (input.action === "prepare-usb") {
        invalidate();
        if (!state.ownerImage || !state.usbVolume)
          throw new Error("Prepare the installation files and select a USB key first");
        if (input.usbConfirmed !== true)
          throw new Error("Confirm the selected USB key and your backup before copying");
        state.message = "Preparing the selected USB key…";
        const result = await execute(
          { task: "prepare-usb", source: state.ownerImage.image, volume: state.usbVolume },
          record,
        );
        state.usbVolume = result.volume;
        state.usbReady = result;
        state.message = "USB key copied and verified. Safely eject it before moving it to the MPC.";
      } else if (input.action === "eject-usb") {
        if (!state.usbVolume || !state.usbReady) throw new Error("Prepare the USB key first");
        const result = await execute({ task: "eject-usb", volume: state.usbVolume }, record);
        state.message = result.ejected
          ? "USB key safely ejected. Keep it ready for the MPC after loader installation."
          : result.instruction;
      } else if (input.action === "mode") {
        if (!["install", "restore"].includes(input.mode)) throw new Error("Unknown operation");
        invalidate();
        state.mode = input.mode;
        state.message =
          input.mode === "install"
            ? "Install XMP's USB loader."
            : "Restore the official 3.10.1 root filesystem.";
      } else if (input.action === "inspect") {
        invalidate();
        const source = state.mode === "install" ? state.loader : state.updater;
        if (!source)
          throw new Error(
            state.mode === "install"
              ? "Prepare or choose a verified loader first"
              : "Choose the official 3.10.1 updater first",
          );
        const operation = state.mode === "install" ? "flash-rootfs" : "restore-stock";
        const result = await execute({ task: "inspect", operation, source }, record);
        const token = randomBytes(24).toString("hex");
        preview = {
          token,
          expires: now() + 5 * 60_000,
          operation,
          source,
          identity: result.identity,
          sha256: result.image.sha256,
          unitPinned: result.unitPinned,
          hardwareObservationSha256: result.hardwareObservationSha256 ?? null,
        };
        state.preview = {
          token,
          firstUse: !result.unitPinned,
          sha256: result.image.sha256,
          operation: state.mode,
          product: result.identity.product,
        };
        state.message = "Checks passed. Review the operation and confirm below.";
      } else if (input.action === "write") {
        if (requireUsbStage && state.mode === "install" && !state.usbReady)
          throw new Error("Prepare the USB key in step 2 before installing the MPC loader");
        const chosen = preview;
        if (!chosen || chosen.token !== input.token || now() > chosen.expires) {
          invalidate();
          throw new Error("Preview expired or missing. Check the Live again.");
        }
        if (input.confirmation !== "XMPOS") throw new Error("Type XMPOS exactly to confirm");
        if (input.savedWork !== true || input.baseline !== true)
          throw new Error("Confirm saved work and the stock 3.10.1 baseline");
        invalidate(); // Single use, including failure. Never retry a flash automatically.
        state.message = "Writing the verified root filesystem. Keep USB and power connected…";
        await execute(
          {
            task: "write",
            operation: chosen.operation,
            source: chosen.source,
            expectedIdentity: chosen.identity,
            expectedImageSha256: chosen.sha256,
            expectedHardwareObservationSha256: chosen.hardwareObservationSha256,
            answers: { flash: input.confirmation },
          },
          record,
        );
        state.message = simulation
          ? "Simulation finished. No hardware was contacted."
          : "Finished. The Live is rebooting. Keep your recovery updater available.";
      } else throw new Error("Unknown installer action");
      if (["updater", "prepare", "loader", "select-usb", "prepare-usb"].includes(input.action))
        await rememberSelection({
          updater: state.updater,
          loader: state.loader,
          ownerImage: state.ownerImage,
          usbVolume: state.usbVolume,
          usbReady: state.usbReady,
        });
      return view();
    } catch (error) {
      if (input.action === "prepare") state.preparationError = error.message;
      state.message = error.message;
      record(`Stopped: ${error.message}`);
      throw error;
    } finally {
      state.busy = false;
      state.phase = null;
      state.progress = null;
    }
  }
  return { action, view };
}
