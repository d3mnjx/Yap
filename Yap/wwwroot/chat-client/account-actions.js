import { hasUnsentWork } from './storage.js';

// Shared by chat and retained Settings/Admin pages, which can also sign out.
export async function confirmDiscard(action, currentDraft = '') {
    let pending;
    try {
        pending = !!currentDraft.trim() || (await hasUnsentWork());
    } catch {
        // A storage failure cannot establish that discarding the account is harmless.
        return confirm(
            `Offline work could not be checked. ${action} will discard any unsent messages and drafts on this device. Continue?`,
        );
    }
    return (
        !pending ||
        confirm(
            `${action} will discard unsent messages, attachments, changes and drafts on this device, including other tabs. Continue?`,
        )
    );
}
