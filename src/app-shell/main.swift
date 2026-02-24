import Cocoa
import Foundation
import WebKit
import UniformTypeIdentifiers
import UserNotifications

class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate, UNUserNotificationCenterDelegate {
    private let serverProcess: Process
    private let url: URL
    private var window: NSWindow?
    private var webView: WKWebView?
    private var loadRetryCount = 0
    private let maxLoadRetries = 10

    init(serverProcess: Process, url: URL) {
        self.serverProcess = serverProcess
        self.url = url
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
        setupMainMenu()
        openWindow()
    }

    // Show notifications even when app is in foreground
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
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
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")

        let wv = WKWebView(frame: .zero, configuration: config)
        wv.uiDelegate = self
        wv.navigationDelegate = self
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

        if #available(macOS 14.0, *) {
            NSApp.activate()
        } else {
            NSApp.activate(ignoringOtherApps: true)
        }

        self.window = w
        self.webView = wv
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        let pid = serverProcess.processIdentifier
        if pid > 0 {
            kill(pid, SIGTERM)
        }
    }

    // MARK: - WKUIDelegate

    // Handle <input type="file"> — opens a native file picker panel
    func webView(_ webView: WKWebView,
                 runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.begin { result in
            completionHandler(result == .OK ? panel.urls : nil)
        }
    }

    // Handle window.open() / target="_blank" links — open in the same WebView
    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil {
            webView.load(navigationAction.request)
        }
        return nil
    }

    // MARK: - WKNavigationDelegate

    // Handle blob: and data: URL downloads, and links with download attribute
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 preferences: WKWebpagePreferences,
                 decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void) {
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download, preferences)
        } else {
            decisionHandler(.allow, preferences)
        }
    }

    // If a navigation response cannot be shown, convert to download
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if navigationResponse.canShowMIMEType {
            decisionHandler(.allow)
        } else {
            decisionHandler(.download)
        }
    }

    // Navigation-initiated download
    func webView(_ webView: WKWebView,
                 navigationAction: WKNavigationAction,
                 didBecome download: WKDownload) {
        download.delegate = self
    }

    // Response-initiated download
    func webView(_ webView: WKWebView,
                 navigationResponse: WKNavigationResponse,
                 didBecome download: WKDownload) {
        download.delegate = self
    }

    // Retry loading if the server isn't ready yet
    func webView(_ webView: WKWebView,
                 didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        guard loadRetryCount < maxLoadRetries else { return }
        loadRetryCount += 1
        let delay = min(0.5 * pow(1.5, Double(loadRetryCount - 1)), 5.0)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self = self else { return }
            webView.load(URLRequest(url: self.url))
        }
    }

    // Reset retry counter on successful load
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loadRetryCount = 0
    }
}

// MARK: - WKDownloadDelegate

extension AppDelegate: WKDownloadDelegate {
    func download(_ download: WKDownload,
                  decideDestinationUsing response: URLResponse,
                  suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.begin { result in
            guard result == .OK, let dest = panel.url else {
                completionHandler(nil)
                return
            }
            // WKDownload fails if the file already exists; remove it first
            // (NSSavePanel already confirmed overwrite with the user)
            try? FileManager.default.removeItem(at: dest)
            completionHandler(dest)
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        let filename = download.originalRequest?.url?.lastPathComponent ?? "File"
        let content = UNMutableNotificationContent()
        content.title = "Download Complete"
        content.body = filename
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        DispatchQueue.main.async {
            let alert = NSAlert()
            alert.messageText = "Download Failed"
            alert.informativeText = error.localizedDescription
            alert.alertStyle = .warning
            alert.runModal()
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
