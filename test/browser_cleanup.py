"""Bounded cleanup for the dedicated Playwright driver and its test browsers."""

import glob
import os
import subprocess
import threading


def launch_test_browser(pw):
    """Launch a headless Chromium for tests, preferring the installed Playwright build.

    The Edge channel is the historical default, but a system Edge update can break
    Playwright's ``--remote-debugging-pipe`` handshake while the bundled Chromium keeps
    working. Prefer an explicitly configured executable, then the newest bundled
    Chromium, and only fall back to the Edge channel when neither is available.
    """
    explicit = os.environ.get('DEVHUB_TEST_BROWSER')
    if explicit:
        return pw.chromium.launch(executable_path=explicit, headless=True)
    root = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'ms-playwright')
    bundled = sorted(
        glob.glob(os.path.join(root, 'chromium-*', 'chrome-win64', 'chrome.exe')),
        key=lambda path: os.path.getmtime(path),
        reverse=True,
    )
    if bundled:
        return pw.chromium.launch(executable_path=bundled[0], headless=True)
    try:
        return pw.chromium.launch(headless=True)
    except Exception:
        return pw.chromium.launch(channel='msedge', headless=True)


def close_test_browser(browser, timeout=10):
    """Try normal close, then reap only this test's driver tree if Edge hangs.

    Playwright's sync close has no timeout parameter. On Windows, Edge can stop
    answering Browser.close after all assertions have run. The watchdog uses the
    driver process owned by this exact Browser connection; it never targets an
    existing interactive browser or uses a process-name-wide kill.
    """
    if os.name != 'nt':
        browser.close()
        return
    # Playwright does not expose its child PID publicly; this one cleanup helper
    # owns the version-sensitive lookup instead of spreading it through tests.
    driver = browser._impl_obj._connection._transport._proc
    forced = threading.Event()
    failures = []
    try:
        import psutil
    except ImportError:
        psutil = None
    owner = psutil.Process(driver.pid) if psutil else None
    children = owner.children(recursive=True) if owner else []

    def reap():
        if driver.returncode is not None:
            return
        forced.set()
        try:
            if owner:
                try:
                    children.extend(owner.children(recursive=True))
                except psutil.NoSuchProcess:
                    pass
                processes = list({process.pid: process for process in [owner, *children]}.values())
                for process in reversed(processes):
                    try:
                        process.kill()
                    except psutil.NoSuchProcess:
                        pass
                _, alive = psutil.wait_procs(processes, timeout=5)
                if any(process.pid == owner.pid for process in alive):
                    raise RuntimeError('The isolated Playwright driver did not exit')
                if alive:
                    print('Browser cleanup warning: termination was requested, but Windows still reports Edge processes '
                          + str([process.pid for process in alive]) + '; the test driver has exited.', flush=True)
            else:
                try:
                    subprocess.run(['taskkill.exe', '/PID', str(driver.pid), '/T', '/F'],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   check=False, timeout=15)
                except subprocess.TimeoutExpired:
                    if driver.returncode is None:
                        raise
        except BaseException as error:
            failures.append(error)

    watchdog = threading.Timer(timeout, reap)
    watchdog.daemon = True
    watchdog.start()
    try:
        browser.close()
    except Exception:
        if not forced.is_set():
            raise
    finally:
        watchdog.cancel()
        watchdog.join(timeout=16)
    if failures:
        raise RuntimeError('Failed to reap the isolated browser test process tree') from failures[0]
    if forced.is_set():
        print('Edge close exceeded the deadline; stopped the test driver and requested termination of its browser tree.', flush=True)
