// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PWARegister from "./PWARegister";

const controls = vi.hoisted(() => ({
  pathname: "/",
  showToast: vi.fn(),
}));

vi.mock("next/navigation", () => ({ usePathname: () => controls.pathname }));
vi.mock("@/components/Toast", () => ({ showToast: controls.showToast }));

const DEFERRED_UPDATE_KEY = "omr_pwa_deferred_update_v1";
// Synthetic field contents only; this harness never authenticates or sends a form.
const ENTRY_ID = "a".repeat(18);
const ENTRY_SECRET = "b".repeat(19);

class WorkerHarness extends EventTarget {
  state = "installing";
  postMessage = vi.fn();

  install() {
    this.state = "installed";
    this.dispatchEvent(new Event("statechange"));
  }
}

class RegistrationHarness extends EventTarget {
  waiting: WorkerHarness | null = new WorkerHarness();
  installing: WorkerHarness | null = null;
  update = vi.fn().mockResolvedValue(undefined);

  findUpdate() {
    this.installing = new WorkerHarness();
    this.dispatchEvent(new Event("updatefound"));
    return this.installing;
  }
}

class ServiceWorkerHarness extends EventTarget {
  controller: WorkerHarness | null = new WorkerHarness();
  registration = new RegistrationHarness();
  register = vi.fn().mockResolvedValue(this.registration);
  getRegistration = vi.fn().mockResolvedValue(this.registration);

  takeControl() {
    this.controller = new WorkerHarness();
    this.dispatchEvent(new Event("controllerchange"));
  }
}

function EntryHarness() {
  const [id, setId] = useState("");
  const [secret, setSecret] = useState("");
  return <>
    <PWARegister />
    <form>
      <label>Entry ID<input value={id} onChange={event => setId(event.target.value)} /></label>
      <label>Entry secret<input type="password" value={secret} onChange={event => setSecret(event.target.value)} /></label>
    </form>
  </>;
}

describe("PWARegister update lifecycle", () => {
  let browserWindow: Window & typeof globalThis;
  let serviceWorkers: ServiceWorkerHarness;
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "production");
    controls.pathname = "/";
    browserWindow = window;
    browserWindow.history.replaceState(null, "", "/");
    browserWindow.sessionStorage.clear();
    serviceWorkers = new ServiceWorkerHarness();
    reload = vi.fn();

    // jsdom's real Location is non-configurable. A window facade intercepts
    // only reload calls, so these tests can never perform document navigation.
    vi.stubGlobal("window", new Proxy(browserWindow, {
      get(target, property) {
        if (property === "location") return { reload };
        return Reflect.get(target, property, target);
      },
    }));
    vi.stubGlobal("navigator", new Proxy(navigator, {
      has(target, property) {
        return property === "serviceWorker" || Reflect.has(target, property);
      },
      get(target, property) {
        if (property === "serviceWorker") return serviceWorkers;
        return Reflect.get(target, property, target);
      },
    }));
  });

  afterEach(() => {
    cleanup();
    browserWindow.sessionStorage.clear();
    browserWindow.history.replaceState(null, "", "/");
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  async function mountEntry(url = "/") {
    controls.pathname = new URL(url, browserWindow.location.href).pathname;
    browserWindow.history.replaceState(null, "", url);
    const view = render(<EntryHarness />);
    await act(async () => { await Promise.resolve(); });
    return view;
  }

  function fillEntry() {
    fireEvent.change(screen.getByLabelText("Entry ID"), { target: { value: ENTRY_ID } });
    fireEvent.change(screen.getByLabelText("Entry secret"), { target: { value: ENTRY_SECRET } });
  }

  function expectEntryPreserved() {
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Entry ID")).toHaveValue(ENTRY_ID);
    expect(screen.getByLabelText("Entry secret")).toHaveValue(ENTRY_SECRET);
  }

  function navigate(view: ReturnType<typeof render>, url: string) {
    controls.pathname = new URL(url, browserWindow.location.href).pathname;
    browserWindow.history.replaceState(null, "", url);
    view.rerender(<EntryHarness />);
  }

  it.each([
    "/",
    "/?role=teacher",
    "/?role=teacher&teacherRecovery=legacy_link",
    "/?role=student",
  ])("keeps filled entry fields when a waiting update takes control on %s", async url => {
    await mountEntry(url);
    fillEntry();

    expect(serviceWorkers.register).toHaveBeenCalledWith("/sw.js");
    expect(serviceWorkers.registration.update).toHaveBeenCalledOnce();
    expect(serviceWorkers.registration.waiting?.postMessage)
      .toHaveBeenCalledWith({ type: "OMR_SKIP_WAITING" });
    act(() => serviceWorkers.takeControl());

    expectEntryPreserved();
    expect(browserWindow.sessionStorage.getItem(DEFERRED_UPDATE_KEY)).toBe("1");
    expect(controls.showToast).toHaveBeenCalledWith(
      "info", "새 버전 준비됨", expect.stringContaining("현재 작업은 유지됩니다"), 6500,
    );
    act(() => serviceWorkers.takeControl());
    expect(controls.showToast).toHaveBeenCalledOnce();
    expectEntryPreserved();
  });

  it("activates an installed update on home without discarding entry state", async () => {
    serviceWorkers.registration.waiting = null;
    await mountEntry("/?role=teacher&teacherRecovery=legacy_link");
    fillEntry();

    let installing!: WorkerHarness;
    act(() => { installing = serviceWorkers.registration.findUpdate(); });
    act(() => installing.install());
    expect(installing.postMessage).toHaveBeenCalledWith({ type: "OMR_SKIP_WAITING" });
    act(() => serviceWorkers.takeControl());

    expectEntryPreserved();
    expect(browserWindow.sessionStorage.getItem(DEFERRED_UPDATE_KEY)).toBe("1");
  });

  it("applies a deferred update once after leaving entry and other protected screens", async () => {
    const view = await mountEntry();
    fillEntry();
    act(() => serviceWorkers.takeControl());
    navigate(view, "/?role=teacher&teacherRecovery=legacy_link");
    navigate(view, "/create");
    navigate(view, "/teacher/live");
    expectEntryPreserved();
    expect(browserWindow.sessionStorage.getItem(DEFERRED_UPDATE_KEY)).toBe("1");

    navigate(view, "/teacher/dashboard");
    expect(reload).toHaveBeenCalledOnce();
    expect(browserWindow.sessionStorage.getItem(DEFERRED_UPDATE_KEY)).toBeNull();
    navigate(view, "/student/dashboard");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("retains an already deferred update during canonical home query transitions", async () => {
    serviceWorkers.registration.waiting = null;
    browserWindow.sessionStorage.setItem(DEFERRED_UPDATE_KEY, "1");
    const view = await mountEntry("/?role=teacher");
    fillEntry();
    navigate(view, "/?role=teacher&teacherRecovery=legacy_link");

    expectEntryPreserved();
    expect(browserWindow.sessionStorage.getItem(DEFERRED_UPDATE_KEY)).toBe("1");
    navigate(view, "/teacher/dashboard");
    expect(reload).toHaveBeenCalledOnce();
  });

  it.each(["/", "/create", "/solve/exam-fixture"])(
    "rechecks %s before a controller change after activation began on a safe route",
    async pathname => {
      const view = await mountEntry("/pwa-check");
      navigate(view, pathname);
      fillEntry();
      act(() => serviceWorkers.takeControl());

      expectEntryPreserved();
      expect(browserWindow.sessionStorage.getItem(DEFERRED_UPDATE_KEY)).toBe("1");
      navigate(view, "/teacher/dashboard");
      expect(reload).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "/create",
    "/solve/exam-fixture",
    "/teacher/exam/exam-fixture",
    "/teacher/live/exam-fixture",
    "/teacher/billing",
  ])("preserves the existing update protection for %s", async pathname => {
    await mountEntry(pathname);
    fillEntry();
    act(() => serviceWorkers.takeControl());

    expectEntryPreserved();
    expect(browserWindow.sessionStorage.getItem(DEFERRED_UPDATE_KEY)).toBe("1");
  });

  it("lets a first-install worker take control of home without a reload or update notice", async () => {
    serviceWorkers.controller = null;
    serviceWorkers.registration.waiting = null;
    await mountEntry("/?role=teacher&teacherRecovery=legacy_link");
    fillEntry();
    let installing!: WorkerHarness;
    act(() => { installing = serviceWorkers.registration.findUpdate(); });
    act(() => installing.install());
    act(() => serviceWorkers.takeControl());

    expectEntryPreserved();
    expect(serviceWorkers.register).toHaveBeenCalledWith("/sw.js");
    expect(serviceWorkers.registration.update).toHaveBeenCalledOnce();
    expect(installing.postMessage).not.toHaveBeenCalled();
    expect(controls.showToast).not.toHaveBeenCalled();
    expect(browserWindow.sessionStorage.getItem(DEFERRED_UPDATE_KEY)).toBeNull();
  });

  it("continues reloading for a waiting update that takes control on a safe screen", async () => {
    await mountEntry("/pwa-check");
    act(() => serviceWorkers.takeControl());

    expect(reload).toHaveBeenCalledOnce();
    expect(controls.showToast).not.toHaveBeenCalled();
    expect(browserWindow.sessionStorage.getItem(DEFERRED_UPDATE_KEY)).toBeNull();
    act(() => serviceWorkers.takeControl());
    expect(reload).toHaveBeenCalledOnce();
  });

  it("ignores worker and online events after the registration component unmounts", async () => {
    const view = await mountEntry();
    const installing = serviceWorkers.registration.findUpdate();
    view.unmount();
    act(() => {
      installing.install();
      serviceWorkers.takeControl();
      browserWindow.dispatchEvent(new Event("online"));
    });

    expect(reload).not.toHaveBeenCalled();
    expect(installing.postMessage).not.toHaveBeenCalled();
    expect(controls.showToast).not.toHaveBeenCalled();
    expect(serviceWorkers.getRegistration).not.toHaveBeenCalled();
  });
});
