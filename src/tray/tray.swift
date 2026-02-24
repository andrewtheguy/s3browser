import Cocoa
import Foundation
import WebKit

class TrayDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private let serverProcess: Process
    private let url: URL
    private var window: NSWindow?
    private var webView: WKWebView?

    init(serverProcess: Process, url: URL) {
        self.serverProcess = serverProcess
        self.url = url
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupMainMenu()

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        if let button = statusItem.button {
            let trayBin = URL(fileURLWithPath: CommandLine.arguments[0])
            let resourcesDir = trayBin.deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent("Resources")
            let svgPath = resourcesDir.appendingPathComponent("tray-icon.svg").path
            if FileManager.default.fileExists(atPath: svgPath),
               let svgData = FileManager.default.contents(atPath: svgPath),
               let image = NSImage(data: svgData) {
                image.isTemplate = true
                image.size = NSSize(width: 18, height: 18)
                button.image = image
            } else if let image = NSImage(systemSymbolName: "externaldrive", accessibilityDescription: "S3 Browser") {
                image.isTemplate = true
                button.image = image
            } else {
                button.title = "S3"
            }
        }

        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Open S3 Browser", action: #selector(openWebView), keyEquivalent: "o"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(quitApp), keyEquivalent: "q"))
        statusItem.menu = menu
    }

    private func setupMainMenu() {
        let mainMenu = NSMenu()

        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        editMenu.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        editMenu.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        editMenu.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))

        let editMenuItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)

        NSApp.mainMenu = mainMenu
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    func applicationWillTerminate(_ notification: Notification) {
        if serverProcess.isRunning {
            serverProcess.terminate()
        }
    }

    @objc func openWebView() {
        // Show dock icon while the window is visible.
        NSApp.setActivationPolicy(.regular)

        if let existingWindow = window {
            existingWindow.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "javaScriptCanAccessClipboard")
        config.preferences.setValue(true, forKey: "DOMPasteAllowed")
        let wv = WKWebView(frame: .zero, configuration: config)
        wv.load(URLRequest(url: url))

        let w = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1024, height: 768),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        w.title = "S3 Browser"
        w.contentView = wv
        w.isReleasedWhenClosed = false
        w.center()
        w.delegate = self
        w.makeKeyAndOrderFront(nil)

        NSApp.activate(ignoringOtherApps: true)

        self.window = w
        self.webView = wv
    }

    @objc func quitApp() {
        if serverProcess.isRunning {
            serverProcess.terminate()
        }
        NSApplication.shared.terminate(nil)
    }
}

extension TrayDelegate: NSWindowDelegate {
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        // Hide dock icon when the window is closed, keep the tray app running.
        NSApp.setActivationPolicy(.accessory)
        return false
    }
}

// --- Main ---

let args = CommandLine.arguments

// Parse --port / -p from CLI args (default 8170)
var port = 8170
if let idx = args.firstIndex(of: "--port") ?? args.firstIndex(of: "-p"), idx + 1 < args.count {
    let raw = args[idx + 1]
    if let p = Int(raw), p >= 1, p <= 65535 {
        port = p
    } else {
        fputs("Warning: invalid port '\(raw)', using default \(port)\n", stderr)
    }
}

let urlString = "http://127.0.0.1:\(port)"
guard let url = URL(string: urlString) else {
    fputs("Invalid URL: \(urlString)\n", stderr)
    exit(1)
}

// Find the server binary next to this executable in the app bundle
let trayBin = URL(fileURLWithPath: CommandLine.arguments[0])
let serverBin = trayBin.deletingLastPathComponent().appendingPathComponent("s3browser")

guard FileManager.default.isExecutableFile(atPath: serverBin.path) else {
    fputs("Server binary not found at: \(serverBin.path)\n", stderr)
    exit(1)
}

// Build server arguments: bind to localhost only for security
var serverArgs = ["-b", "127.0.0.1:\(port)"]

let serverProcess = Process()
serverProcess.executableURL = serverBin
serverProcess.arguments = serverArgs
serverProcess.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser

// When the server dies, exit the tray app too
serverProcess.terminationHandler = { _ in
    DispatchQueue.main.async {
        NSApplication.shared.terminate(nil)
    }
}

do {
    try serverProcess.run()
} catch {
    fputs("Failed to start server: \(error)\n", stderr)
    exit(1)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // No dock icon initially
let delegate = TrayDelegate(serverProcess: serverProcess, url: url)
app.delegate = delegate
app.run()
