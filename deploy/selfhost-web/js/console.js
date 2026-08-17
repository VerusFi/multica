// xterm.js console glue for selfhost guest serial I/O.
//
// Load pattern: xterm is a UMD library vendored in vendor/xterm.js and loaded
// via a classic <script> tag before this module runs (page must load
// vendor/xterm.js via <script src="vendor/xterm.js"></ script> before any
// ES modules). The UMD build sets window.Terminal, which this module reads
// via globalThis.Terminal. This allows module code to use the UMD library
// without repackaging it as an ES module.
//
// attachConsole(containerEl, vmController) attaches an xterm Terminal to the
// container, piping guest serial output (vmController.onSerial) to the
// terminal display and user input (term.onData) to the guest console
// (vmController.sendToConsole). Returns an object with a dispose() method
// that cleans up both terminal and serial callbacks, plus the terminal
// instance for testing purposes (e.g., calling term.paste()).

/**
 * Attach an xterm Terminal to a container and wire it to a VmController.
 * @param {HTMLElement} containerEl - Container to attach the terminal to.
 * @param {VmController} vmController - The VM controller instance.
 * @returns {{dispose: () => void, terminal: Terminal}} - Object with dispose() cleanup method and the terminal instance.
 */
export function attachConsole(containerEl, vmController) {
  const Terminal = globalThis.Terminal;
  if (!Terminal) {
    throw new Error("Terminal (xterm.js) not available on globalThis; vendor/xterm.js must be loaded via <script> tag");
  }

  // Create and open the terminal.
  const term = new Terminal({
    cols: 80,
    rows: 24,
  });
  term.open(containerEl);

  // Compose the serial listener: chain the terminal writer to the existing
  // onSerial callback (if any) so both receive serial output.
  const originalOnSerial = vmController.onSerial;
  vmController.onSerial = (ch) => {
    term.write(ch);
    originalOnSerial?.(ch);
  };

  // Wire user input from the terminal to the guest console.
  // term.onData returns an IDisposable; store it for proper cleanup.
  const dataListener = (data) => {
    vmController.sendToConsole(data);
  };
  const dataDisposable = term.onData(dataListener);

  // Cleanup: restore the original callback and dispose both the listener and terminal.
  return {
    dispose: () => {
      vmController.onSerial = originalOnSerial;
      dataDisposable.dispose(); // Properly remove the onData listener.
      term.dispose();
    },
    terminal: term, // Exposed for testing (e.g., term.paste() in verification drivers)
  };
}
