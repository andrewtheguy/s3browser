import Cocoa
import Foundation
import WebKit

class AppDelegate: NSObject, NSApplicationDelegate {
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
        openWindow()
    }

    private func setupMainMenu() {
        let mainMenu = NSMenu()

        // App menu (Quit shortcut)
        let appMenu = NSMenu()
        appMenu.addItem(NSMenuItem(title: "Quit S3 Browser", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        let appMenuItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        // Edit menu (clipboard shortcuts for WebView)
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

    private func openWindow() {
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
        w.makeKeyAndOrderFront(nil)

        NSApp.activate(ignoringOtherApps: true)

        self.window = w
        self.webView = wv
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        if serverProcess.isRunning {
            serverProcess.terminate()
        }
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
let execBin = URL(fileURLWithPath: CommandLine.arguments[0])
let serverBin = execBin.deletingLastPathComponent().appendingPathComponent("s3browser")

guard FileManager.default.isExecutableFile(atPath: serverBin.path) else {
    fputs("Server binary not found at: \(serverBin.path)\n", stderr)
    exit(1)
}

// Build server arguments: bind to localhost only for security
let serverArgs = ["-b", "127.0.0.1:\(port)"]

let serverProcess = Process()
serverProcess.executableURL = serverBin
serverProcess.arguments = serverArgs
serverProcess.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser

// When the server dies, exit the app too
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
app.setActivationPolicy(.regular)
let delegate = AppDelegate(serverProcess: serverProcess, url: url)
app.delegate = delegate
app.run()
