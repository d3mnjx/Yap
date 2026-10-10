// Plain script syntax deliberately supports both classic and module workers, plus Blazor.
globalThis.yapWorkerCommon = Object.freeze({
    isChatNavigation(path) {
        return /^\/(?:chat|lobby)\/?$/.test(path) || /^\/(?:room|dm)\/[^/]+\/?$/.test(path);
    },
    urlBase64ToUint8Array(value) {
        const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
        return Uint8Array.from(atob(padded.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
            c.charCodeAt(0),
        );
    },
});
