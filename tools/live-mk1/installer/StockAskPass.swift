import AppKit
import Foundation

// OpenSSH reads stdout through its private pipe. No password is saved or logged.
let target = ProcessInfo.processInfo.environment["XMP_STOCK_TARGET"] ?? "your Live"
let alert = NSAlert()
alert.messageText = "MPC Live Mk1 Developer Mode"
alert.informativeText = "Enter the SSH password for your Live at \(target). This verifies stock 3.10.1 and rootfs capacity with read-only commands. The password goes directly to SSH and is not saved."
let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
alert.accessoryView = field
alert.addButton(withTitle: "Verify Live")
alert.addButton(withTitle: "Cancel")
NSApplication.shared.setActivationPolicy(.accessory)
NSApplication.shared.activate(ignoringOtherApps: true)
alert.window.initialFirstResponder = field
if alert.runModal() == .alertFirstButtonReturn {
    FileHandle.standardOutput.write(Data((field.stringValue + "\n").utf8))
    field.stringValue = ""
} else {
    exit(1)
}
