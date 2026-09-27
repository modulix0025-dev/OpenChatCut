// Native permission dialog for the capability broker (server/security/capabilities.ts).
//
// The dialog is drawn by the OS through Electron's main process, so page
// script — including a compromised renderer, agent tool output, or a
// malicious template — cannot render, pre-answer or click it. Deny is the
// default button and the cancel action (Esc / closing the dialog).
import { BrowserWindow, dialog } from 'electron';
import type { CapabilityPrompter } from '../server/security/capabilities.ts';
import { capabilityDialogChoices, capabilityDialogOptions } from './capability-dialog.ts';

export { capabilityDialogChoices, capabilityDialogDetail, capabilityDialogOptions } from './capability-dialog.ts';

export function createNativeCapabilityPrompter(
  parentWindow: () => BrowserWindow | null,
): CapabilityPrompter {
  return async (request) => {
    const options = capabilityDialogOptions(request);
    const choices = capabilityDialogChoices(request);
    const parent = parentWindow();
    const result = parent && !parent.isDestroyed()
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    return choices[result.response]?.decision ?? 'deny';
  };
}
