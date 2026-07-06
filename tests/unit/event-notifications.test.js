import fs from "fs";
import path from "path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const EVENT_JS_PATH = path.join(
  process.cwd(),
  "src-tauri/src/inject/event.js",
);

/**
 * Minimal Event polyfill for the sandbox so Notification onclick callbacks
 * and firePendingClickCallbacks can dispatch click events.
 */
class SandboxEvent {
  constructor(type, opts) {
    this.type = type;
    this.bubbles = opts?.bubbles ?? false;
  }
}

function createElement(tagName = "div") {
  return {
    tagName: tagName.toUpperCase(),
    style: {},
    children: [],
    isContentEditable: false,
    addEventListener: vi.fn(),
    appendChild(child) {
      this.children.push(child);
      if (child.id) elementsById.set(child.id, child);
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((item) => item !== child);
      if (child.id) elementsById.delete(child.id);
    },
    click: vi.fn(),
    set id(value) {
      this._id = value;
      if (value) elementsById.set(value, this);
    },
    get id() {
      return this._id;
    },
  };
}

// Shared across loadNotificationHelpers calls so the createElement closure
// can reference it; re-initialized inside the function.
let elementsById;

/**
 * Load event.js in a sandboxed VM context configured for notification tests.
 *
 * @param {object} overrides
 * @param {boolean}  overrides.withTauri        - mount __TAURI__ (default: true)
 * @param {boolean}  overrides.withSW           - provide ServiceWorkerRegistration (default: false)
 * @param {boolean}  overrides.pageHidden       - initial document.hidden value (default: false)
 * @param {string}   overrides.initialTitle     - document.title (default: "My App")
 * @param {boolean}  overrides.withTitleElement - document.querySelector("title") returns an element (default: true)
 * @param {boolean}  overrides.withOrigSW       - provide a real orig showNotification on SW prototype (default: true)
 */
function loadNotificationHelpers({
  withTauri = true,
  withSW = false,
  pageHidden = false,
  initialTitle = "My App",
  withTitleElement = true,
  withOrigSW = true,
} = {}) {
  const source = fs.readFileSync(EVENT_JS_PATH, "utf-8");

  // Re-initialize the shared element tracker
  elementsById = new Map();

  const invokeCalls = [];
  const invoke = vi.fn((command, payload) => {
    invokeCalls.push([command, payload]);
    return Promise.resolve();
  });

  const eventListeners = {};
  const registerListener = vi.fn((type, handler, options) => {
    eventListeners[type] = eventListeners[type] || [];
    eventListeners[type].push({ handler, options });
  });

  // --- MutationObserver stub ---
  const mutationObserverInstances = [];
  let _mutationCallback = null;

  function MockMutationObserver(callback) {
    _mutationCallback = callback;
    const instance = {
      observe: vi.fn(),
      disconnect: vi.fn(),
    };
    mutationObserverInstances.push(instance);
    return instance;
  }
  MockMutationObserver._getCallback = () => _mutationCallback;
  MockMutationObserver._getInstances = () => mutationObserverInstances;

  // --- Title element stub ---
  const titleElement = withTitleElement
    ? { textContent: initialTitle }
    : null;

  // --- Body stub with proper appendChild tracking ---
  const body = createElement("body");
  body.scrollHeight = 0;

  // --- ServiceWorkerRegistration setup ---
  let origSW = null;
  if (withOrigSW) {
    origSW = vi.fn(() => Promise.resolve());
  }

  const context = {
    console: { log: vi.fn(), error: vi.fn(), warn: vi.fn() },
    URL,
    Event: SandboxEvent,
    MutationObserver: MockMutationObserver,
    setTimeout: vi.fn((fn) => {
      if (typeof fn === "function") return fn();
      return 1;
    }),
    clearTimeout: vi.fn(),
    setInterval: vi.fn(() => 42),
    clearInterval: vi.fn(),
    scrollTo: vi.fn(),
    navigator: {
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      language: "en-US",
    },
    window: {
      history: {
        back: vi.fn(),
        forward: vi.fn(),
      },
      location: {
        href: "https://example.com/app",
        origin: "https://example.com",
        pathname: "/app",
        reload: vi.fn(),
      },
      localStorage: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
      },
      addEventListener: registerListener,
      dispatchEvent: vi.fn(),
      open: vi.fn(() => ({})),
      isAuthLink: vi.fn(() => false),
      isAuthPopup: vi.fn(() => false),
      pakeConfig: {},
    },
    document: {
      addEventListener: registerListener,
      createElement: (tagName) => {
        const element = createElement(tagName);
        if (element.id) elementsById.set(element.id, element);
        return element;
      },
      createRange: vi.fn(() => ({
        selectNodeContents: vi.fn(),
      })),
      getElementById: (id) => elementsById.get(id) || null,
      getElementsByTagName: vi.fn(() => [{ style: {} }]),
      querySelector: vi.fn((sel) => {
        if (sel === "title") return titleElement;
        return null;
      }),
      body,
      execCommand: vi.fn(() => false),
      title: initialTitle,
      get hidden() {
        return pageHidden;
      },
    },
  };

  context.window.navigator = context.navigator;

  if (withTauri) {
    context.window.__TAURI__ = {
      core: { invoke },
      window: {
        getCurrentWindow: vi.fn(() => ({
          startDragging: vi.fn(),
          isFullscreen: vi.fn(() => Promise.resolve(false)),
          setFullscreen: vi.fn(),
        })),
      },
    };
  }

  // Set up ServiceWorkerRegistration before running the script so the IIFE
  // picks it up
  if (withSW) {
    context.ServiceWorkerRegistration = {
      prototype: {
        showNotification: origSW,
      },
    };
  }

  // Run the script in the sandbox context
  runInNewContext(source, context);

  // Fire DOMContentLoaded
  const DOMContentLoaded = eventListeners.DOMContentLoaded?.[0];
  if (DOMContentLoaded) {
    DOMContentLoaded.handler();
  }

  return {
    ...context,
    eventListeners,
    invokeCalls,
    invoke,
    _mutationObserver: MockMutationObserver,
    _titleElement: titleElement,
    _elementsById: elementsById,
    _origSW: origSW,
  };
}

// ===========================================================================
//  Service Worker showNotification polyfill
// ===========================================================================
describe("Service Worker showNotification polyfill", () => {
  it("replaces ServiceWorkerRegistration.prototype.showNotification when SW is available", () => {
    const ctx = loadNotificationHelpers({ withSW: true });
    const proto = ctx.ServiceWorkerRegistration.prototype;

    expect(typeof proto.showNotification).toBe("function");
    const result = proto.showNotification("Test", { body: "Body" });
    expect(typeof result?.then).toBe("function");
  });

  it("calls send_notification invoke with title, body, icon, tag", async () => {
    const ctx = loadNotificationHelpers({ withSW: true });

    await ctx.ServiceWorkerRegistration.prototype.showNotification("Hello", {
      body: "World",
      icon: "/icon.png",
      tag: "msg-1",
    });

    expect(ctx.invokeCalls).toContainEqual([
      "send_notification",
      {
        params: {
          title: "Hello",
          body: "World",
          icon: "https://example.com/icon.png",
          tag: "msg-1",
        },
      },
    ]);
  });

  it("resolves relative icon against window.location.origin", async () => {
    const ctx = loadNotificationHelpers({ withSW: true });

    await ctx.ServiceWorkerRegistration.prototype.showNotification("Hi", {
      icon: "/images/bell.svg",
    });

    expect(ctx.invokeCalls).toContainEqual([
      "send_notification",
      {
        params: {
          title: "Hi",
          body: "",
          icon: "https://example.com/images/bell.svg",
          tag: "",
        },
      },
    ]);
  });

  it("keeps absolute icon URLs unchanged", async () => {
    const ctx = loadNotificationHelpers({ withSW: true });

    await ctx.ServiceWorkerRegistration.prototype.showNotification("Hi", {
      icon: "https://cdn.example.com/icon.png",
    });

    expect(ctx.invokeCalls).toContainEqual([
      "send_notification",
      {
        params: {
          title: "Hi",
          body: "",
          icon: "https://cdn.example.com/icon.png",
          tag: "",
        },
      },
    ]);
  });

  it("calls the original showNotification as fire-and-forget", async () => {
    const ctx = loadNotificationHelpers({ withSW: true, withOrigSW: true });

    await ctx.ServiceWorkerRegistration.prototype.showNotification("Hello", {
      body: "World",
    });

    expect(ctx._origSW).toHaveBeenCalledWith("Hello", { body: "World" });
  });

  it("does not throw when ServiceWorkerRegistration is undefined", () => {
    expect(() => loadNotificationHelpers({ withSW: false })).not.toThrow();
  });
});

// ===========================================================================
//  Document title change → notification fallback
// ===========================================================================
describe("Document title change notification fallback", () => {
  it("triggers a notification when title changes to (1) while page hidden", () => {
    const ctx = loadNotificationHelpers({
      withTitleElement: true,
      pageHidden: true,
      initialTitle: "Discord",
    });

    ctx.document.title = "(1) Discord";
    const cb = ctx._mutationObserver._getCallback();
    expect(cb).toBeTruthy();
    cb();

    expect(ctx.invokeCalls).toContainEqual([
      "send_notification",
      {
        params: {
          title: "(1) Discord",
          body: "From: https://example.com",
          icon: "",
          tag: "pake-title-change",
        },
      },
    ]);
  });

  it("respects the 3-second cooldown between consecutive title change notifications", () => {
    const ctx = loadNotificationHelpers({
      withTitleElement: true,
      pageHidden: true,
      initialTitle: "Discord",
    });

    // First change triggers a notification
    ctx.document.title = "(1) Discord";
    ctx._mutationObserver._getCallback()();
    expect(
      ctx.invokeCalls.filter(([cmd]) => cmd === "send_notification").length,
    ).toBe(1);

    // Second change within cooldown — does NOT trigger
    ctx.document.title = "(2) Discord";
    ctx._mutationObserver._getCallback()();
    expect(
      ctx.invokeCalls.filter(([cmd]) => cmd === "send_notification").length,
    ).toBe(1);
  });

  it("does not trigger for title changes without notification patterns", () => {
    const ctx = loadNotificationHelpers({
      withTitleElement: true,
      pageHidden: true,
      initialTitle: "My App",
    });

    ctx.document.title = "Discord";
    ctx._mutationObserver._getCallback()();

    expect(ctx.invokeCalls).not.toContainEqual([
      "send_notification",
      expect.any(Object),
    ]);
  });

  it("does not trigger when the page is visible even with notification patterns", () => {
    const ctx = loadNotificationHelpers({
      withTitleElement: true,
      pageHidden: false,
      initialTitle: "Discord",
    });

    ctx.document.title = "(1) Discord";
    ctx._mutationObserver._getCallback()();

    expect(ctx.invokeCalls).not.toContainEqual([
      "send_notification",
      expect.any(Object),
    ]);
  });

  it("triggers for @-mention patterns when page is hidden", () => {
    const ctx = loadNotificationHelpers({
      withTitleElement: true,
      pageHidden: true,
      initialTitle: "Slack",
    });

    ctx.document.title = "@you in #general";
    ctx._mutationObserver._getCallback()();

    expect(ctx.invokeCalls).toContainEqual([
      "send_notification",
      {
        params: {
          title: "@you in #general",
          body: "From: https://example.com",
          icon: "",
          tag: "pake-title-change",
        },
      },
    ]);
  });

  it("triggers for 'message' keyword when page is hidden", () => {
    const ctx = loadNotificationHelpers({
      withTitleElement: true,
      pageHidden: true,
      initialTitle: "Site",
    });

    ctx.document.title = "New message received";
    ctx._mutationObserver._getCallback()();

    expect(ctx.invokeCalls).toContainEqual([
      "send_notification",
      expect.objectContaining({
        params: expect.objectContaining({ title: "New message received" }),
      }),
    ]);
  });

  it("triggers for 'alert' keyword when page is hidden", () => {
    const ctx = loadNotificationHelpers({
      withTitleElement: true,
      pageHidden: true,
      initialTitle: "My Dashboard",
    });

    ctx.document.title = "Alert: Disk space low";
    ctx._mutationObserver._getCallback()();

    expect(ctx.invokeCalls).toContainEqual([
      "send_notification",
      expect.objectContaining({
        params: expect.objectContaining({ title: "Alert: Disk space low" }),
      }),
    ]);
  });

  it("triggers for 'notification' keyword when page is hidden", () => {
    const ctx = loadNotificationHelpers({
      withTitleElement: true,
      pageHidden: true,
      initialTitle: "My App",
    });

    ctx.document.title = "notification: New update available";
    ctx._mutationObserver._getCallback()();

    expect(ctx.invokeCalls).toContainEqual([
      "send_notification",
      expect.objectContaining({
        params: expect.objectContaining({
          title: "notification: New update available",
        }),
      }),
    ]);
  });

  it("skips unchanged titles (same as previous)", () => {
    const ctx = loadNotificationHelpers({
      withTitleElement: true,
      pageHidden: true,
      initialTitle: "Discord",
    });

    ctx.document.title = "Discord";
    ctx._mutationObserver._getCallback()();

    expect(ctx.invokeCalls).toEqual([]);
  });
});

// ===========================================================================
//  Notification click handling (pendingClickCallbacks + focus/visibility)
// ===========================================================================
describe("Notification click handling", () => {
  it("queues onclick callbacks from the Notification polyfill and fires on focus", () => {
    const ctx = loadNotificationHelpers();
    const onclick = vi.fn();

    const notif = new ctx.window.Notification("Test", { body: "Body" });
    notif.onclick = onclick;

    const focusEntry = ctx.eventListeners.focus?.[0];
    expect(focusEntry).toBeDefined();
    focusEntry.handler();

    // The callback fires once from the queue (pushed by the setter) and once
    // from the legacy lastNotif.onclick path, for a total of 2 calls.
    expect(onclick).toHaveBeenCalledTimes(2);
    expect(onclick.mock.calls[0][0].type).toBe("click");
  });

  it("fires pendingClickCallbacks on visibilitychange when page becomes visible", () => {
    const ctx = loadNotificationHelpers();
    const onclick = vi.fn();

    const notif = new ctx.window.Notification("Vis", { body: "Test" });
    notif.onclick = onclick;

    const visEntry = ctx.eventListeners.visibilitychange?.[0];
    expect(visEntry).toBeDefined();

    // Ensure hidden is false so the guard passes
    Object.defineProperty(ctx.document, "hidden", {
      get: () => false,
      configurable: true,
    });
    visEntry.handler();

    // Queue (1) + legacy (1) = 2
    expect(onclick).toHaveBeenCalledTimes(2);
  });

  it("drains the queue completely (all callbacks are called)", () => {
    const ctx = loadNotificationHelpers();
    const fn1 = vi.fn();
    const fn2 = vi.fn();

    const n1 = new ctx.window.Notification("A");
    n1.onclick = fn1;
    const n2 = new ctx.window.Notification("B");
    n2.onclick = fn2;

    const focusEntry = ctx.eventListeners.focus?.[0];
    focusEntry.handler();

    // Each callback fires twice: once from queue, once from legacy lastNotif
    // (only the last notification object's lastNotif fires the legacy path)
    expect(fn1).toHaveBeenCalledTimes(1); // only from queue (n2 is lastNotif)
    expect(fn2).toHaveBeenCalledTimes(2); // queue + legacy

    // Second focus should not re-fire drained callbacks
    fn1.mockClear();
    fn2.mockClear();
    focusEntry.handler();
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).not.toHaveBeenCalled();
  });

  it("does not fire callbacks when page is still hidden on visibilitychange", () => {
    const ctx = loadNotificationHelpers({ pageHidden: true });
    const onclick = vi.fn();

    const notif = new ctx.window.Notification("Hidden", { body: "Test" });
    notif.onclick = onclick;

    const visEntry = ctx.eventListeners.visibilitychange?.[0];
    expect(visEntry).toBeDefined();

    // hidden stays true — callbacks must NOT fire
    visEntry.handler();
    expect(onclick).not.toHaveBeenCalled();
  });
});

// ===========================================================================
//  Edge cases and resilience
// ===========================================================================
describe("Notification edge cases", () => {
  it("handles empty / missing options gracefully", () => {
    const ctx = loadNotificationHelpers();
    const onclick = vi.fn();

    const notif = new ctx.window.Notification("Only Title");
    notif.onclick = onclick;

    const focusEntry = ctx.eventListeners.focus?.[0];
    focusEntry.handler();

    expect(onclick).toHaveBeenCalled();
  });

  it("sets Notification.permission to granted", () => {
    const ctx = loadNotificationHelpers();
    expect(ctx.window.Notification.permission).toBe("granted");
  });

  it("requestPermission returns granted", async () => {
    const ctx = loadNotificationHelpers();
    const perm = await ctx.window.Notification.requestPermission();
    expect(perm).toBe("granted");
  });

  it("uses empty string for body and icon when options are absent", () => {
    const ctx = loadNotificationHelpers();

    new ctx.window.Notification("Hello");

    expect(ctx.invokeCalls).toContainEqual([
      "send_notification",
      {
        params: {
          title: "Hello",
          body: "",
          icon: "",
        },
      },
    ]);
  });
});
