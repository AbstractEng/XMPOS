import Foundation
import AppKit

// This launcher starts a loopback UI. Every device command remains in flash.mjs.
do {
    guard let resources = Bundle.main.resourceURL else {
        throw NSError(domain: "XMPInstaller", code: 1, userInfo: [NSLocalizedDescriptionKey: "Installer resources are missing."])
    }
    let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("XMP OS Installer", isDirectory: true)
    try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let logURL = support.appendingPathComponent("launch.log")
    if !FileManager.default.fileExists(atPath: logURL.path) {
        FileManager.default.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
    }
    let log = try FileHandle(forWritingTo: logURL)
    log.seekToEndOfFile()
    let child = Process()
    child.executableURL = resources.appendingPathComponent("node")
    child.arguments = [resources.appendingPathComponent("server.mjs").path, "--open"]
    child.standardInput = FileHandle.nullDevice
    child.standardOutput = log
    child.standardError = log
    try child.run()
} catch {
    let alert = NSAlert()
    alert.messageText = "XMP OS Installer could not start"
    alert.informativeText = error.localizedDescription
    alert.runModal()
}
