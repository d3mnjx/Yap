// Client locale detection (timezone + language)
window.getClientLocaleInfo = () => ({
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: navigator.language
});

// IPv4 beacon (opt-in via ChatSettings:Ipv4BeaconUrl): one fire-and-forget GET at an
// A-record-only hostname. DNS forces this request over IPv4, letting the server record
// the v4 address of a client whose circuit arrived over IPv6. no-cors: we only need the
// request to ARRIVE — the (opaque) response is irrelevant, so no CORS setup needed.
// The nonce is a single-use server-minted value, not the sessionId (it ends up in logs).
window.fireIpv4Beacon = (origin, nonce) => {
    try {
        fetch(`${origin.replace(/\/+$/, '')}/api/ipv4-beacon?n=${encodeURIComponent(nonce)}`,
            { mode: 'no-cors', cache: 'no-store' }).catch(() => { });
    } catch { /* best-effort — an ad-blocker or offline state must never break chat */ }
};

// Welcome page: attach click handler to #yap-enter element
// Supports optional .welcome-bg transition (grayscale → color) before navigating
window.setupWelcomePage = (dotNetRef) => {
    const el = document.getElementById('yap-enter');
    if (!el) return;

    el.style.cursor = 'pointer';
    const handleClick = () => {
        el.removeEventListener('click', handleClick);

        const bg = document.querySelector('.welcome-bg');
        if (bg) {
            el.classList.add('lit');
            bg.classList.add('awaken');
            setTimeout(() => dotNetRef.invokeMethodAsync('OnEnterClicked'), 2200);
        } else {
            dotNetRef.invokeMethodAsync('OnEnterClicked');
        }
    };
    el.addEventListener('click', handleClick);
};

// Tab notification helpers
let dotNetRef = null;
let notificationAudio = null;

// Last real user input in this tab. The latency probe reports "seconds since input" every tick so
// the server derives presence (auto-away) from what the user actually does — not from circuit
// traffic, which the probe itself would otherwise keep "active" forever.
let lastInputTs = performance.now();
['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'].forEach((ev) =>
    document.addEventListener(ev, () => { lastInputTs = performance.now(); }, { capture: true, passive: true }));

// Pre-load audio on first user interaction
function ensureAudioLoaded() {
    if (!notificationAudio) {
        notificationAudio = new Audio('/notif.mp3');
        notificationAudio.volume = 0.5;
        notificationAudio.load();
    }
}

// Initialize audio on first user interaction (required by browsers)
document.addEventListener('click', ensureAudioLoaded, { once: true });
document.addEventListener('keydown', ensureAudioLoaded, { once: true });

let visibilityListenerInstalled = false;

window.setupVisibilityListener = (ref) => {
    dotNetRef = ref;
    ensureAudioLoaded();
    // Every chat page registers here on navigation; install the document listener once, or a
    // single visibility flip ends up invoking OnPageVisibilityChanged N times after N navigations.
    if (!visibilityListenerInstalled) {
        visibilityListenerInstalled = true;
        document.addEventListener('visibilitychange', () => {
            if (!dotNetRef) return;
            const visible = document.visibilityState === 'visible';
            if (visible) lastInputTs = performance.now(); // foregrounding is a user action
            dotNetRef.invokeMethodAsync('OnPageVisibilityChanged', visible);
        });
    }
    // Current visibility, so the caller can sync the server-side session state on load —
    // a tab loaded/restored in the background must not sit on the server default of "visible".
    return document.visibilityState === 'visible';
};

window.isPageVisible = () => document.visibilityState === 'visible';

window.setDocumentTitle = (title) => {
    document.title = title;
};

window.notifyNewMessage = (title) => {
    document.title = title;
    ensureAudioLoaded();
    if (notificationAudio) {
        notificationAudio.currentTime = 0;
        notificationAudio.play().catch(() => {});
    }
};

window.scrollToBottom = () => {
    const element = document.querySelector('.messages');
    if (!element) return;

    const doScroll = () => {
        element.scrollTop = element.scrollHeight;
    };

    // Two passes: now and after Blazor's render flushes. The freshly-added message
    // (e.g. a just-sent GIF) often hasn't hit the DOM yet on the first pass, so its
    // img wouldn't be in our pending-load list. Re-running querySelectorAll inside
    // a deferred callback catches it.
    const wireUpAndScroll = () => {
        doScroll();

        const pendingImgs = Array.from(element.querySelectorAll('img')).filter(img => !img.complete);
        const pendingMedia = Array.from(element.querySelectorAll('video, audio'))
            .filter(m => m.readyState < 1 /* HAVE_METADATA */);

        const total = pendingImgs.length + pendingMedia.length;
        if (total === 0) return;

        let remaining = total;
        const onSettled = () => {
            if (--remaining === 0) {
                requestAnimationFrame(doScroll);
            }
        };

        pendingImgs.forEach(img => {
            img.addEventListener('load', onSettled, { once: true });
            img.addEventListener('error', onSettled, { once: true });
        });
        pendingMedia.forEach(m => {
            let done = false;
            const fire = () => { if (!done) { done = true; onSettled(); } };
            m.addEventListener('loadedmetadata', fire, { once: true });
            m.addEventListener('error', fire, { once: true });
            // Safety: some browsers/elements never fire loadedmetadata
            // (e.g. cross-origin or stalled fetches). Don't wait forever.
            setTimeout(fire, 1500);
        });
    };

    // Pass 1: immediate (catches existing pending media).
    requestAnimationFrame(wireUpAndScroll);

    // Pass 2: short delay so Blazor's render queue has flushed and any just-added
    // message (with its img) is now in the DOM and gets a load-listener wired up.
    // 80ms is enough for one or two render passes without feeling laggy.
    setTimeout(wireUpAndScroll, 80);
};

// Check if user is scrolled near the bottom of messages
// Used to decide whether to auto-scroll after adding reactions
window.isNearBottom = (threshold = 100) => {
    const element = document.querySelector('.messages');
    if (!element) return true; // Default to true if no element

    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    return distanceFromBottom <= threshold;
};

// ==========================================
// Image gallery viewer (ImageGalleryModal)
// Everything the finger does is client-owned, so no gesture waits for the circuit: swipe is
// native scroll-snap on .gallery-strip, fit/fill is a "fill" class per .modal-stage, drag-down
// sets "dragging" + a --drag variable, and every close path adds "closing" (hide now, tell the
// circuit after). Those class attributes are static in the markup, so Blazor's diff never
// clobbers what we add. The circuit is only ever told to close.
// ==========================================

const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 25;
const DRAG_CLOSE_PX = 120;      // release below this and the picture springs back
const DRAG_FADE_PX = 300;       // backdrop fully faded at this drag distance

let modalRef = null;
let modalKeyHandler = null;

window.attachGalleryModal = (dotNetRef) => {
    modalRef = dotNetRef;
    document.removeEventListener('keydown', modalKeyHandler);
    modalKeyHandler = (e) => {
        if (e.key === 'Escape') closeGallery();
        else if (e.key === 'ArrowRight') stepGallery(1);
        else if (e.key === 'ArrowLeft') stepGallery(-1);
    };
    document.addEventListener('keydown', modalKeyHandler);
};

window.detachGalleryModal = () => {
    document.removeEventListener('keydown', modalKeyHandler);
    modalKeyHandler = null;
    modalRef = null;
};

const galleryStrip = () => document.querySelector('.image-modal .gallery-strip');

const stepGallery = (dir) => {
    const strip = galleryStrip();
    strip?.scrollBy({ left: dir * strip.clientWidth, behavior: 'smooth' });
};

// The stage currently snapped into view.
const visibleStage = (strip) => strip.children[Math.round(strip.scrollLeft / strip.clientWidth)];

const closeGallery = () => {
    document.querySelector('.image-modal')?.classList.add('closing');
    modalRef?.invokeMethodAsync('CloseModalFromJs').catch(() => {});
};

// Blazor inserts the strip scrolled to item 0. A JS-interop call after render would move it a
// round-trip later, with item 0 visible until then, so we catch the insertion here and scroll in
// the same task, before the first paint.
new MutationObserver((mutations) => {
    for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
            if (node.nodeType !== 1) continue;
            const strip = node.matches('.image-modal') ? node.querySelector('.gallery-strip') : null;
            if (strip) initGalleryStrip(strip);
        }
    }
}).observe(document.body, { childList: true, subtree: true });

const initGalleryStrip = (strip) => {
    strip.scrollLeft = Number(strip.dataset.start) * strip.clientWidth;

    const stages = [...strip.children];
    const counter = strip.parentElement.querySelector('.modal-counter-index');
    const watcher = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            const video = entry.target.querySelector('video');
            if (entry.isIntersecting) {
                video?.play().catch(() => {});   // iOS may refuse sound without a tap; controls are there
                if (counter) counter.textContent = stages.indexOf(entry.target) + 1;
            } else {
                video?.pause();
                entry.target.classList.remove('fill', 'fill-w');   // like every native viewer: a swipe lands on fit
            }
        }
    }, { root: strip, threshold: 0.6 });
    stages.forEach((stage) => watcher.observe(stage));
};

// Fit <-> fill. CSS scales the picture along one axis; we pick the axis (fill-w for a picture
// narrower than the stage) and centre the scroll on the tapped point instead of landing top-left.
const toggleFill = (stage, rx = 0.5, ry = 0.5) => {
    const img = stage?.querySelector('img');
    if (!img?.naturalWidth) return;       // videos have no fill mode; an unloaded picture has no ratio yet
    if (stage.classList.contains('fill')) { stage.classList.remove('fill', 'fill-w'); return; }
    const narrower = img.naturalWidth / img.naturalHeight < stage.clientWidth / stage.clientHeight;
    stage.classList.toggle('fill-w', narrower);
    stage.classList.add('fill');
    stage.scrollLeft = rx * img.clientWidth - stage.clientWidth / 2;
    stage.scrollTop = ry * img.clientHeight - stage.clientHeight / 2;
};

// Capture phase: runs before Blazor's delegated click handling and can't be affected by it.
document.addEventListener('click', (e) => {
    const modal = e.target.closest('.image-modal');
    if (!modal) return;
    if (e.target.closest('.modal-nav.prev')) stepGallery(-1);
    else if (e.target.closest('.modal-nav.next')) stepGallery(1);
    else if (e.target.closest('.modal-fill')) toggleFill(visibleStage(galleryStrip()));
    else if (!e.target.closest('img, video')) modal.classList.add('closing');   // backdrop or ×: Blazor's @onclick closes, this hides now
}, true);

// Own double-tap detection instead of dblclick: iOS support for dblclick on touch is patchy,
// and this gives mouse double-click the same behaviour for free.
let lastTap = null;
document.addEventListener('pointerup', (e) => {
    const img = e.target.closest('.modal-stage > img');
    if (!img) { lastTap = null; return; }
    const r = img.getBoundingClientRect();
    const tap = {
        t: e.timeStamp, x: e.clientX, y: e.clientY,
        rx: (e.clientX - r.left) / r.width, ry: (e.clientY - r.top) / r.height,
    };
    const isDouble = lastTap && tap.t - lastTap.t < DOUBLE_TAP_MS
        && Math.hypot(tap.x - lastTap.x, tap.y - lastTap.y) < DOUBLE_TAP_PX;
    lastTap = isDouble ? null : tap;
    if (isDouble) toggleFill(img.parentElement, tap.rx, tap.ry);
});

// Drag down to close: touch only, fit mode only (in fill mode a vertical drag pans the picture).
// The stage's touch-action hands horizontal pans to the strip; those arrive as pointercancel.
let drag = null;
document.addEventListener('pointerdown', (e) => {
    const stage = e.target.closest('.modal-stage:not(.fill)');
    if (!stage || e.pointerType !== 'touch' || !e.isPrimary) return;
    drag = { y: e.clientY, stage, modal: stage.closest('.image-modal') };
    stage.classList.add('dragging');
});

document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = Math.max(0, e.clientY - drag.y);
    drag.stage.style.transform = `translateY(${dy}px)`;
    drag.modal.style.setProperty('--drag', Math.min(1, dy / DRAG_FADE_PX));
});

const endDrag = (e) => {
    if (!drag) return;
    const { y, stage, modal } = drag;
    drag = null;
    stage.classList.remove('dragging');
    if (e.type === 'pointerup' && e.clientY - y > DRAG_CLOSE_PX) { closeGallery(); return; }
    stage.style.transform = '';
    modal.style.removeProperty('--drag');
};
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);

// Drag-drop file handling + drag-over visuals, fully client-side. Blazor never sees drag
// events — dragover fires continuously during a drag and used to round-trip per event just
// to re-set a bool. The highlight rides on a data-dragging ATTRIBUTE (not a class): the
// container's class attribute is Blazor-interpolated and re-renders would clobber JS classes,
// while Blazor's diff never touches an attribute it doesn't render.
let _dropDocListenersInstalled = false;
const installDropDocumentListeners = () => {
    if (_dropDocListenersInstalled) return; // document-level listeners are installed once
    _dropDocListenersInstalled = true;

    // Cancelling dragover marks drop targets valid; cancelling drop stops the browser
    // from navigating to the dropped file.
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => e.preventDefault());

    // A cancelled drag (ESC, dropped outside the window) never fires dragleave — clean up.
    const resetActive = () => document.querySelectorAll('[data-dragging]').forEach(el => {
        el._dragDepth = 0;
        el.removeAttribute('data-dragging');
    });
    document.addEventListener('dragend', resetActive);
    document.addEventListener('drop', resetActive);
};

window.setupDropZone = (dropZoneElement, fileInputId) => {
    const fileInput = document.getElementById(fileInputId);
    if (!fileInput || !dropZoneElement) return;

    installDropDocumentListeners();

    if (dropZoneElement._dropWired) return; // idempotent per element (re-setup after ReadOnly flips)
    dropZoneElement._dropWired = true;
    dropZoneElement._dragDepth = 0;

    // Only real file drags light up the overlay — not text-selection drags.
    const isFileDrag = (e) => e.dataTransfer?.types?.includes('Files');

    // dragenter/dragleave fire on every child boundary crossing (textarea, buttons) —
    // the depth counter keeps the highlight stable while moving inside the container.
    dropZoneElement.addEventListener('dragenter', (e) => {
        if (!isFileDrag(e)) return;
        if (++dropZoneElement._dragDepth === 1) dropZoneElement.setAttribute('data-dragging', '');
    });
    dropZoneElement.addEventListener('dragleave', () => {
        if (dropZoneElement._dragDepth > 0 && --dropZoneElement._dragDepth === 0)
            dropZoneElement.removeAttribute('data-dragging');
    });

    // Handle file drop on drop zone
    dropZoneElement.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZoneElement._dragDepth = 0;
        dropZoneElement.removeAttribute('data-dragging');

        const files = e.dataTransfer?.files;
        if (files && files.length > 0) {
            // Filter for image and video files
            const mediaFiles = Array.from(files).filter(f =>
                f.type.startsWith('image/') || f.type.startsWith('video/'));
            if (mediaFiles.length > 0) {
                // Create a DataTransfer object and add the files
                const dt = new DataTransfer();
                mediaFiles.forEach(f => dt.items.add(f));

                // Set the files on the input and trigger change
                fileInput.files = dt.files;
                fileInput.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }
    });
};

// Auto-resize textarea (Discord-style)
window.autoResizeTextarea = (id) => {
    requestAnimationFrame(() => {
        const textarea = document.getElementById(id);
        if (textarea) {
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
        }
    });
};

window.resetTextareaHeight = (id) => {
    const textarea = document.getElementById(id);
    if (textarea) {
        textarea.style.height = '44px'; // Reset to min-height, avoids scrollbar flash
    }
};

// Emoji toggle button: randomize which color emoji appears on each hover
// Listens on the button (parent) to avoid re-triggering when moving within it
window.setupEmojiToggle = (iconId, cols, totalEmojis) => {
    const icon = document.getElementById(iconId);
    if (!icon) return;
    const button = icon.parentElement;
    if (!button) return;

    button.addEventListener('mouseenter', () => {
        // Pick one random emoji — set on both color and grey
        // Color shows immediately (hover), grey shows when you leave (same emoji, greyed out)
        const index = Math.floor(Math.random() * totalEmojis);
        const col = index % cols;
        const row = Math.floor(index / cols);
        icon.style.setProperty('--color-col', col);
        icon.style.setProperty('--color-row', row);
        icon.style.setProperty('--grey-col', col);
        icon.style.setProperty('--grey-row', row);
    });
};

// Detect touch/mobile device - Enter should not send on these
window.isTouchDevice = () => {
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
};

// Watch viewport for the mobile breakpoint and notify Blazor when it changes.
// Returns the initial match value so the caller can set state on first render.
const _mobileLayoutWatchers = new Map(); // id -> { mq, handler }

window.setupMobileLayoutWatcher = (dotnetRef, id) => {
    const mq = window.matchMedia('(max-width: 600px)');
    const handler = (e) => {
        // An open picker's pane is about to be swapped for the other layout's — close
        // the client-owned picker state before Blazor rebuilds the pane.
        window.closePickers();
        try { dotnetRef.invokeMethodAsync('OnMobileLayoutChanged', e.matches); }
        catch { /* circuit may be gone */ }
    };
    if (mq.addEventListener) mq.addEventListener('change', handler);
    else mq.addListener(handler);
    // Track per MessageInput instance so DisposeAsync can detach it — otherwise every page
    // navigation leaks a matchMedia handler that later fires on a disposed DotNetObjectReference.
    _mobileLayoutWatchers.set(id, { mq, handler });
    return mq.matches;
};

window.teardownMobileLayoutWatcher = (id) => {
    const w = _mobileLayoutWatchers.get(id);
    if (!w) return;
    if (w.mq.removeEventListener) w.mq.removeEventListener('change', w.handler);
    else w.mq.removeListener(w.handler);
    _mobileLayoutWatchers.delete(id);
};

// Prevent textarea from losing focus when send button is tapped (keeps mobile keyboard open)
window.setupSendButtonFocus = (textareaId) => {
    const textarea = document.getElementById(textareaId);
    if (!textarea) return;
    const container = textarea.closest('.message-input-container');
    if (!container) return;
    const sendBtn = container.querySelector('.send-button');
    if (!sendBtn) return;

    sendBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
    });
};

// Desktop Enter-to-send, fully client-side: prevent the newline and route the send
// through the send button's click, so the button's @onclick stays the single server
// entry point and typing costs no extra keydown dispatches.
window.setupEnterKeyHandler = (textareaId) => {
    const textarea = document.getElementById(textareaId);
    if (!textarea) return;

    // Remove any existing handler to avoid duplicates
    if (textarea._enterKeyHandler) {
        textarea.removeEventListener('keydown', textarea._enterKeyHandler);
    }

    const isTouch = window.isTouchDevice();

    textarea._enterKeyHandler = (e) => {
        // On touch devices, Enter creates newline (use send button)
        // On desktop, Enter sends message (prevent newline), Shift+Enter for newline
        if (e.key !== 'Enter' || e.shiftKey || isTouch) return;
        // An IME commit also arrives as Enter (keyCode 229 on some IMEs) — sending
        // here would eat the composed text, so let the IME have it.
        if (e.isComposing || e.keyCode === 229) return;
        e.preventDefault(); // no newline on desktop Enter, even with nothing to send
        if (!textarea.value.trim()) return;
        textarea.closest('.message-input-container')?.querySelector('.send-button')?.click();
    };

    textarea.addEventListener('keydown', textarea._enterKeyHandler);
};

// Message-edit box wiring: autogrow + focus + client-side keys, so editing keystrokes
// never round-trip (the draft is bound at change granularity server-side).
// Deliberate INVERSION vs. the send pipeline: the send path must NOT sync the textarea
// before its click (the empty-guard would reject the send), while Enter-to-save MUST —
// the synthetic change commits the draft, and in-order circuit processing guarantees it
// lands before the click's SaveEdit. A direct ✓ click needs no synthetic event: native
// blur→change→click ordering commits the draft first. Invariant: edit buttons must never
// get the send button's mousedown-preventDefault (keep-keyboard-open) treatment — it
// would suppress that blur and silently save stale content.
window.setupEditBox = (textareaId) => {
    const textarea = document.getElementById(textareaId);
    if (!textarea) return;

    window.setupTextareaAutoResize(textareaId);
    window.autoResizeTextarea(textareaId); // pre-filled multi-line content opens at the right height

    // The edit UI is taller than the message line it replaces — on the LAST message the
    // actions row would open below the fold. Keep it in view on open and while the box
    // autogrows. rAF runs after autoResizeTextarea's own rAF (queue order), so the height
    // is settled first; block:'nearest' is a no-op whenever it's already visible.
    const actions = textarea.closest('.edit-container')?.querySelector('.edit-actions');
    const keepActionsVisible = () => requestAnimationFrame(() =>
        actions?.scrollIntoView({ block: 'nearest' }));
    keepActionsVisible();
    if (textarea._editGrowHandler) {
        textarea.removeEventListener('input', textarea._editGrowHandler);
    }
    textarea._editGrowHandler = keepActionsVisible;
    textarea.addEventListener('input', textarea._editGrowHandler);

    // Focus with caret at the end. On touch devices this won't raise the keyboard
    // (we're outside the tap gesture) — tapping the box does; accepted.
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    if (textarea._editKeyHandler) {
        textarea.removeEventListener('keydown', textarea._editKeyHandler);
    }

    const isTouch = window.isTouchDevice();

    textarea._editKeyHandler = (e) => {
        if (e.isComposing || e.keyCode === 229) return; // IME composition owns the keys
        const container = textarea.closest('.edit-container');
        if (e.key === 'Escape') {
            e.preventDefault();
            container?.querySelector('.edit-cancel')?.click();
        } else if (e.key === 'Enter' && !e.shiftKey && !isTouch) {
            e.preventDefault(); // no newline on plain desktop Enter; Shift+Enter keeps it
            textarea.dispatchEvent(new Event('change', { bubbles: true })); // commit draft BEFORE the save click
            container?.querySelector('.edit-save')?.click();
        }
    };

    textarea.addEventListener('keydown', textarea._editKeyHandler);
};

// PWA Badge API for unread notifications
window.setAppBadge = async (count) => {
    if ('setAppBadge' in navigator) {
        try {
            // iOS requires notification permission for badges (only prompt inside PWA)
            if (window.isPwaInstalled() && 'Notification' in window && Notification.permission === 'default') {
                await Notification.requestPermission();
            }

            if (count > 0) {
                await navigator.setAppBadge(count);
            } else {
                await navigator.clearAppBadge();
            }
            return true;
        } catch (e) {
            console.warn('[PWA] Badge update failed:', e);
            return false;
        }
    }
    return false;
};

window.clearAppBadge = async () => {
    if ('clearAppBadge' in navigator) {
        try {
            await navigator.clearAppBadge();
            return true;
        } catch (e) {
            console.warn('[PWA] Badge clear failed:', e);
            return false;
        }
    }
    return false;
};

// Check if Badge API is supported
window.isBadgeSupported = () => {
    return 'setAppBadge' in navigator;
};

// ==========================================
// Push Notification Subscription
// ==========================================

// Check if push is supported
window.isPushSupported = () => {
    return 'PushManager' in window && 'serviceWorker' in navigator;
};

// Get current notification permission
window.getNotificationPermission = () => {
    if (!('Notification' in window)) return 'unsupported';
    return Notification.permission;
};

// Request notification permission
window.requestNotificationPermission = async () => {
    if (!('Notification' in window)) return 'unsupported';
    try {
        const result = await Notification.requestPermission();
        console.log('[Push] Permission result:', result);
        return result;
    } catch (e) {
        console.error('[Push] Permission request failed:', e);
        return 'error';
    }
};

// Check if app is installed as PWA
window.isPwaInstalled = () => {
    return window.matchMedia('(display-mode: standalone)').matches ||
           window.navigator.standalone === true;
};

// PWA last-route persistence (resume where you left off)
window.saveLastRoute = (route) => {
    localStorage.setItem('yap-last-route', route);
};

window.getLastPwaRoute = () => {
    if (!window.isPwaInstalled()) return null;
    return localStorage.getItem('yap-last-route');
};

// PWA Install Banner helpers
window.isMessageInputFocused = () => {
    return document.activeElement?.classList.contains('message-input') === true;
};

window.shouldShowPwaInstallBanner = () => {
    if (window.isPwaInstalled()) return false;
    if (sessionStorage.getItem('pwa-banner-dismissed')) return false;
    return true;
};

window.dismissPwaInstallBanner = () => {
    sessionStorage.setItem('pwa-banner-dismissed', 'true');
};

// Push permission prompt (full-page overlay for PWA users)
window.shouldShowPushPermissionPrompt = () => {
    if (!window.isPwaInstalled()) return false;
    if (!window.isPushSupported()) return false;
    // Already granted or denied — no point showing
    if ('Notification' in window && Notification.permission !== 'default') return false;
    // Dismissed 3+ times — stop asking
    const dismissCount = parseInt(localStorage.getItem('push-prompt-dismiss-count') || '0');
    if (dismissCount >= 3) return false;
    return true;
};

window.dismissPushPermissionPrompt = () => {
    const count = parseInt(localStorage.getItem('push-prompt-dismiss-count') || '0');
    localStorage.setItem('push-prompt-dismiss-count', String(count + 1));
};

// Submit a hidden POST form. The browser navigates, so the endpoint can set the auth cookie
// (a Blazor circuit can't) and secrets stay out of the URL. Used by the passphrase page and
// by the invite / login-link page.
window.postForm = (action, fields) => {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = action;
    form.style.display = 'none';

    for (const [name, value] of Object.entries(fields)) {
        if (value == null) continue;
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = value;
        form.appendChild(input);
    }

    document.body.appendChild(form);
    form.submit();
};

window.submitSigninForm = (username, password, returnUrl) =>
    window.postForm('/auth/signin', { username, password, returnUrl });

// Capture native install prompt (Chrome/Edge on desktop & Android)
let _deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    _deferredInstallPrompt = e;
});

window.showPwaInstallGuide = async () => {
    sessionStorage.setItem('pwa-banner-dismissed', 'true');

    // Use native prompt if available (desktop Chrome/Edge, Android Chrome)
    if (_deferredInstallPrompt) {
        _deferredInstallPrompt.prompt();
        const result = await _deferredInstallPrompt.userChoice;
        console.log('[PWA] Install prompt result:', result.outcome);
        _deferredInstallPrompt = null;
        return;
    }

    // Fallback: show add-to-homescreen guide (iOS Safari, etc.)
    const cdnBase = 'https://cdn.jsdelivr.net/gh/philfung/add-to-homescreen@3.5/dist';

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = cdnBase + '/add-to-homescreen.min.css';
    document.head.appendChild(link);

    const script = document.createElement('script');
    script.src = cdnBase + '/add-to-homescreen.min.js';
    script.onload = () => {
        if (window.AddToHomeScreen) {
            const instance = window.AddToHomeScreen({
                appName: 'Yap',
                appIconUrl: 'icon-192.png',
                assetUrl: cdnBase + '/assets/img/',
                allowClose: false,
                showArrow: true
            });
            instance.show('en');
        }
    };
    document.body.appendChild(script);
};

// Subscribe to push notifications
window.subscribeToPush = async (vapidPublicKey) => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        console.warn('[Push] Push not supported');
        return null;
    }

    try {
        const registration = await navigator.serviceWorker.ready;
        const convertedKey = urlBase64ToUint8Array(vapidPublicKey);

        // Check for existing subscription
        let subscription = await registration.pushManager.getSubscription();

        // If an existing subscription was created with a DIFFERENT applicationServerKey (e.g. the
        // server's VAPID key was rotated/fixed), it can never receive pushes signed by the new key.
        // Drop it and re-subscribe so users migrate automatically with no action on their part.
        if (subscription && !applicationServerKeyMatches(subscription, convertedKey)) {
            console.log('[Push] VAPID key changed — re-subscribing with the new key');
            try { await subscription.unsubscribe(); } catch (e) { console.warn('[Push] old unsubscribe failed', e); }
            subscription = null;
        }

        if (!subscription) {
            subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: convertedKey
            });
            console.log('[Push] New subscription created');
        } else {
            console.log('[Push] Using existing subscription');
        }

        // Return subscription as JSON string
        window.__lastPushError = null;
        const subJson = subscription.toJSON();
        return JSON.stringify({
            endpoint: subJson.endpoint,
            p256dh: subJson.keys.p256dh,
            auth: subJson.keys.auth
        });
    } catch (e) {
        console.error('[Push] Subscription failed:', e);
        window.__lastPushError = e ? `${e.name || 'Error'}: ${e.message || e}` : 'unknown error';
        return null;
    }
};

// Blazor reads this after a null subscribeToPush result. The DOMException text is the only
// clue that separates "this browser cannot reach its push service" from a bug of ours.
window.getLastPushError = () => window.__lastPushError || null;

// Unsubscribe from push notifications
window.unsubscribeFromPush = async () => {
    try {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();

        if (subscription) {
            await subscription.unsubscribe();
            console.log('[Push] Unsubscribed');
            return true;
        }
        return false;
    } catch (e) {
        console.error('[Push] Unsubscribe failed:', e);
        return false;
    }
};

// Get current push subscription
window.getPushSubscription = async () => {
    try {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();

        if (subscription) {
            const subJson = subscription.toJSON();
            return JSON.stringify({
                endpoint: subJson.endpoint,
                p256dh: subJson.keys.p256dh,
                auth: subJson.keys.auth
            });
        }
        return null;
    } catch (e) {
        console.error('[Push] Get subscription failed:', e);
        return null;
    }
};

// Helper: true if the subscription was created with the given applicationServerKey.
// If the browser doesn't expose options.applicationServerKey, assume a match so we never
// churn a working subscription on a browser that simply can't tell us what key it used.
function applicationServerKeyMatches(subscription, expectedKeyBytes) {
    try {
        const current = subscription.options && subscription.options.applicationServerKey;
        if (!current) return true;
        const actual = new Uint8Array(current);
        if (actual.length !== expectedKeyBytes.length) return false;
        for (let i = 0; i < actual.length; i++) {
            if (actual[i] !== expectedKeyBytes[i]) return false;
        }
        return true;
    } catch (e) {
        return true;
    }
}

// Helper: Convert VAPID key to Uint8Array
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding)
        .replace(/-/g, '+')
        .replace(/_/g, '/');

    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);

    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

// Listen for notification clicks from service worker
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data?.type === 'NOTIFICATION_CLICK' && event.data?.url) {
            // Navigate to the URL from notification
            window.location.href = event.data.url;
        }
    });
}

// ==========================================
// Emoji Picker Positioning
// ==========================================

// Bottom edge a message popup may reach: the nearest scrolling ancestor's bottom
// (the message list), not the viewport. The input box sits directly under that
// list and its send button shares the popup's z-index while coming later in the
// DOM, so a popup that spills below the list has its last item (Delete) painted
// over. Keeping popups inside the list means they flip above the anchor instead.
function popupBottomLimit(anchor) {
    let el = anchor.parentElement;
    while (el && el !== document.body) {
        const overflowY = getComputedStyle(el).overflowY;
        if (overflowY === 'auto' || overflowY === 'scroll') {
            return Math.min(el.getBoundingClientRect().bottom, window.innerHeight);
        }
        el = el.parentElement;
    }
    return window.innerHeight;
}

// Position emoji picker as a fixed overlay near the anchor button, clamped to viewport.
// On mobile (<=600px), CSS handles bottom-sheet positioning so we skip JS.
window.positionEmojiPickerFixed = (wrapper, anchor) => {
    if (!wrapper || !anchor) return;

    // On mobile, CSS bottom-sheet handles positioning
    if (window.innerWidth <= 600) return;

    const anchorRect = anchor.getBoundingClientRect();
    const pickerWidth = 340;
    // Measured, not assumed: the wrapper is already laid out when Blazor calls this,
    // and a stale constant (384 vs a real 450) put the flipped picker 66px too low.
    const pickerHeight = wrapper.offsetHeight || 384;
    const margin = 4;

    // Default: below anchor, right-aligned with anchor's right edge
    let top = anchorRect.bottom + margin;
    let left = anchorRect.right - pickerWidth;

    // If not enough space below (within the message list), position above the anchor
    const bottomLimit = popupBottomLimit(anchor);
    if (top + pickerHeight > bottomLimit - margin) {
        top = anchorRect.top - pickerHeight - margin;
    }

    // Clamp to viewport edges
    if (top < margin) top = margin;
    if (left < margin) left = margin;
    if (left + pickerWidth > window.innerWidth - margin) {
        left = window.innerWidth - pickerWidth - margin;
    }
    if (top + pickerHeight > window.innerHeight - margin) {
        top = window.innerHeight - pickerHeight - margin;
    }

    wrapper.style.top = top + 'px';
    wrapper.style.left = left + 'px';
};

// Position a small dropdown (e.g. the message ⋯ menu) near its anchor.
// Unlike positionEmojiPickerFixed this measures the element's real size.
// The dropdown starts visibility:hidden (CSS) and is revealed only after
// placement, so it never flashes at its pre-positioned spot.
window.positionDropdownFixed = (wrapper, anchor) => {
    if (!wrapper || !anchor) return;

    // On mobile, CSS bottom-sheet handles positioning (and visibility)
    if (window.innerWidth <= 600) return;

    const anchorRect = anchor.getBoundingClientRect();
    const width = wrapper.offsetWidth;
    const height = wrapper.offsetHeight;
    const margin = 4;

    // Default: below anchor, right-aligned with anchor's right edge
    let top = anchorRect.bottom + margin;
    let left = anchorRect.right - width;

    // If not enough space below (within the message list), position above the anchor
    if (top + height > popupBottomLimit(anchor) - margin) {
        top = anchorRect.top - height - margin;
    }

    // Clamp to viewport edges
    if (top < margin) top = margin;
    if (left < margin) left = margin;
    if (left + width > window.innerWidth - margin) {
        left = window.innerWidth - width - margin;
    }

    wrapper.style.top = top + 'px';
    wrapper.style.left = left + 'px';
    wrapper.style.visibility = 'visible';
};

// Copy text to clipboard. Clipboard API needs a secure context, so fall back
// to the hidden-textarea trick for plain-http access (e.g. LAN testing).
window.copyTextToClipboard = async (text) => {
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
    }
};

// Initialize scroll-tracking for emoji picker sidebar highlights.
// Returns an object with dispose() to clean up the scroll listener.
window.initEmojiPickerScroll = (contentElement) => {
    if (!contentElement) return { dispose: () => {} };

    const picker = contentElement.closest('.emoji-picker');
    if (!picker) return { dispose: () => {} };

    const sidebar = picker.querySelector('.emoji-sidebar');
    if (!sidebar) return { dispose: () => {} };

    const highlightActive = () => {
        const sections = contentElement.querySelectorAll('.emoji-section');
        let activeKey = null;

        // Find the section whose top is at or above the container's scroll position
        for (const section of sections) {
            if (section.offsetParent === null) continue; // hidden by an active search filter
            if (section.offsetTop <= contentElement.scrollTop + 8) {
                activeKey = section.getAttribute('data-section');
            }
        }

        // Fallback to first section if nothing matched
        if (!activeKey && sections.length > 0) {
            activeKey = sections[0].getAttribute('data-section');
        }

        // Toggle .active on matching sidebar button
        for (const btn of sidebar.querySelectorAll('.category-btn')) {
            btn.classList.toggle('active', btn.getAttribute('data-category') === activeKey);
        }
    };

    // Run initial highlight
    highlightActive();

    const onScroll = () => highlightActive();
    contentElement.addEventListener('scroll', onScroll, { passive: true });

    return {
        dispose: () => {
            contentElement.removeEventListener('scroll', onScroll);
        }
    };
};

// Client-side click handler for emoji picker — inserts emoji into textarea instantly
// without waiting for Blazor server round-trip. Blazor @onclick still fires for bookkeeping.
// Document-level event delegation for emoji picker clicks.
// Survives Blazor DOM replacements — the handler is on document, not the picker element.
//
// All per-click state is sourced from the DOM at click time (no shared module globals):
//   - which textarea to insert into → the picker's data-textarea-id
//   - where to insert → textarea._emojiCaret (captured on blur, see setupCaretTracking)
//   - bookkeeping callback → textarea._emojiDotNetRef
// This is what kills the old race: previously the insert offset lived in a module global
// that was only reset via a server round-trip, so a fast click could read a stale offset
// from a previous message and insert mid-text.
let _emojiClickSetup = false;

window.setupEmojiPickerClick = (textareaId, dotNetRef) => {
    // Stash the recents/counts callback on the textarea element. Reaction-mode pickers
    // (MessageItem) pass an empty id and have no textarea → nothing to wire up.
    const ta = textareaId ? document.getElementById(textareaId) : null;
    if (ta) ta._emojiDotNetRef = dotNetRef || null;

    if (_emojiClickSetup) return;
    _emojiClickSetup = true;

    // Blur search input on pointerdown to dismiss mobile keyboard early,
    // so the click event fires without keyboard dismissal delay.
    document.addEventListener('pointerdown', (e) => {
        const btn = e.target.closest('.emoji-picker .emoji-btn[data-emoji]');
        if (btn) {
            const searchInput = btn.closest('.emoji-picker')?.querySelector('.emoji-search input');
            if (searchInput && document.activeElement === searchInput) {
                searchInput.blur();
            }
        }
    });

    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.emoji-picker .emoji-btn[data-emoji]');
        if (!btn) return;

        const emoji = btn.getAttribute('data-emoji');
        // The target textarea is carried on the picker. Empty/missing means a reaction-mode
        // picker (no TextareaId) — bail so the Blazor @onclick handles it instead.
        const picker = btn.closest('.emoji-picker');
        const tid = picker && picker.getAttribute('data-textarea-id');
        if (!emoji || !tid) return;

        const textarea = document.getElementById(tid);
        if (!textarea) return;

        // Caret was captured on the textarea's blur (before Blazor reset selectionStart to 0).
        // Fall back to end-of-text when the field was never focused (e.g. mobile tap-to-insert).
        const pos = (typeof textarea._emojiCaret === 'number') ? textarea._emojiCaret : textarea.value.length;
        const value = textarea.value;

        textarea.value = value.substring(0, pos) + emoji + value.substring(pos);

        const newPos = pos + emoji.length;
        textarea.selectionStart = newPos;
        textarea.selectionEnd = newPos;
        // Advance the cached caret synchronously so rapid emoji-to-emoji clicks (no blur
        // between them) chain after each other instead of stacking at the same offset.
        textarea._emojiCaret = newPos;

        // Intentionally do NOT focus the textarea — on mobile, focus() within a user gesture
        // pops the keyboard, which we don't want while the picker is open.
        // The synthetic input feeds client-side listeners only (typing tracker, auto-resize);
        // with plain @bind the server's draft syncs via the send pipeline's pre-send change,
        // so inserting emoji costs zero circuit traffic.
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        window.autoResizeTextarea(tid);

        // Fire-and-forget bookkeeping (recents + counts). MUST stay render-free for the
        // MessageInput component: a re-render triggered here could push the server's older
        // messageText back over the value we just spliced in, clobbering the emoji.
        textarea._emojiDotNetRef?.invokeMethodAsync('RecordEmojiUsed', emoji).catch(() => { });
    });
};

// Client-side textarea auto-resize on input. Replaces the server-side
// JS.InvokeVoidAsync("autoResizeTextarea") round-trip that used to fire on
// every keystroke.
window.setupTextareaAutoResize = (textareaId) => {
    const textarea = document.getElementById(textareaId);
    if (!textarea) return;
    if (textarea._autoResizeHandler) {
        textarea.removeEventListener('input', textarea._autoResizeHandler);
    }
    textarea._autoResizeHandler = () => window.autoResizeTextarea(textareaId);
    textarea.addEventListener('input', textarea._autoResizeHandler);
};

// Typing-indicator bursts, client-driven. The message box is plain @bind (change
// granularity) so keystrokes carry zero circuit traffic — the typing signal can't ride
// the binding anymore. This tracker dispatches exactly two calls per burst: Start on
// the first keystroke, Stop after 3s idle or when the box empties. The send pipeline
// resets the local flag WITHOUT a Stop dispatch — HandleSend broadcasts that stop.
window.setupTypingTracker = (textareaId, dotNetRef) => {
    const textarea = document.getElementById(textareaId);
    if (!textarea) return;

    if (textarea._typingInputHandler) {
        textarea.removeEventListener('input', textarea._typingInputHandler);
        textarea._typingLocalReset?.();
    }

    let typing = false;
    let timer = null;

    const stop = () => {
        clearTimeout(timer);
        timer = null;
        if (!typing) return;
        typing = false;
        dotNetRef.invokeMethodAsync('ReportTypingStopped').catch(() => { });
    };

    textarea._typingInputHandler = () => {
        if (!textarea.value.trim()) { stop(); return; }
        if (!typing) {
            typing = true;
            dotNetRef.invokeMethodAsync('ReportTypingStarted').catch(() => { });
        }
        clearTimeout(timer);
        timer = setTimeout(stop, 3000);
    };
    textarea.addEventListener('input', textarea._typingInputHandler);

    // Silent reset for the send pipeline: the next keystroke starts a fresh burst.
    textarea._typingLocalReset = () => { clearTimeout(timer); timer = null; typing = false; };
};

// Track the textarea caret for the emoji picker. Captured on `blur` — the instant focus
// leaves the textarea for the picker, and crucially BEFORE the Blazor re-render that resets
// an unfocused textarea's selectionStart to 0. The emoji click handler reads textarea._emojiCaret.
window.setupCaretTracking = (textareaId) => {
    const textarea = document.getElementById(textareaId);
    if (!textarea) return;
    if (textarea._emojiCaretHandler) {
        textarea.removeEventListener('blur', textarea._emojiCaretHandler);
    }
    textarea._emojiCaretHandler = () => { textarea._emojiCaret = textarea.selectionStart; };
    textarea.addEventListener('blur', textarea._emojiCaretHandler);
};

// ==========================================
// Mobile action-bar dismiss (scroll + idle timeout)
// Pure client-side CSS class toggling — touchstart is high-frequency, so no
// Blazor round-trips. Relies on .messages having a STATIC class attribute
// (Blazor never re-renders it, so our added class can't be clobbered).
// ==========================================

let scrollWatchActive = false;
let scrollStartTop = 0;
let scrollDismissHandler = null;
let actionsIdleTimer = null;
const SCROLL_DISMISS_THRESHOLD = 50;  // pixels
const ACTIONS_IDLE_TIMEOUT = 5000;    // ms of inactivity before the bar fades

const dismissActions = () => {
    clearTimeout(actionsIdleTimer);
    // Never hide the bar under an open emoji picker or ⋯ menu; the tap that
    // eventually closes them lands inside .message-group and re-arms the timer.
    // (.picker-open/.menu-open = MessageItem's reaction picker & menu; [data-picker]
    // = the input pickers, whose open state is client-owned.)
    if (document.querySelector('.picker-open, .menu-open, .message-input-container[data-picker]')) return;
    const messagesEl = document.querySelector('.messages');
    if (messagesEl) {
        scrollWatchActive = false;
        messagesEl.classList.add('scroll-dismissing');
    }
};

const armActionsDismiss = () => {
    const messagesEl = document.querySelector('.messages');
    if (!messagesEl) return;
    messagesEl.classList.remove('scroll-dismissing');   // instant re-show, no round-trip
    scrollStartTop = messagesEl.scrollTop;
    scrollWatchActive = true;
    clearTimeout(actionsIdleTimer);
    actionsIdleTimer = setTimeout(dismissActions, ACTIONS_IDLE_TIMEOUT);
};

// Any touch on a message (action bar, pickers and backdrops included) re-arms.
// Capture phase: runs before Blazor's handlers and can't be affected by them —
// same pattern as the reply-button focuser. Touch-only, so desktop hover
// behavior is untouched.
document.addEventListener('touchstart', (e) => {
    if (e.target.closest('.message-group')) armActionsDismiss();
}, { capture: true, passive: true });

window.setupScrollDismiss = () => {
    const messagesEl = document.querySelector('.messages');
    if (!messagesEl) return;

    // Remove existing handler if any
    if (scrollDismissHandler) {
        messagesEl.removeEventListener('scroll', scrollDismissHandler);
    }

    scrollDismissHandler = () => {
        if (!scrollWatchActive) return;

        const delta = Math.abs(messagesEl.scrollTop - scrollStartTop);
        if (delta > SCROLL_DISMISS_THRESHOLD) {
            dismissActions();
        }
    };

    messagesEl.addEventListener('scroll', scrollDismissHandler, { passive: true });
};

window.cleanupScrollDismiss = () => {
    const messagesEl = document.querySelector('.messages');
    if (messagesEl && scrollDismissHandler) {
        messagesEl.removeEventListener('scroll', scrollDismissHandler);
        messagesEl.classList.remove('scroll-dismissing');
    }
    scrollDismissHandler = null;
    scrollWatchActive = false;
    clearTimeout(actionsIdleTimer);
};

// Focus message input (used after clicking Reply)
window.focusMessageInput = () => {
    const el = document.querySelector('.message-input');
    if (el) el.focus();
};

// Focus input on reply button click, in the user gesture context.
// Uses capture phase so it fires before Blazor's bubbling-phase handler,
// keeping focus in the same gesture without interfering with Blazor's click processing.
document.addEventListener('click', (e) => {
    if (e.target.closest('.action-reply')) {
        const el = document.querySelector('.message-input');
        if (el) el.focus();
    }
}, true);


// ==========================================
// Scroll to Message (Reply click)
// ==========================================

// Jump to a settings anchor. Blazor does not act on a URL fragment for content that renders
// after navigation, so the page asks for the scroll once it has drawn the target.
window.scrollToElementId = (id) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

window.scrollToMessage = (messageId) => {
    const el = document.getElementById('msg-' + messageId);
    if (!el) return;

    const container = document.querySelector('.messages');
    if (!container) return;

    // Target: center the element in the container
    const targetTop = el.offsetTop - container.offsetTop - (container.clientHeight / 2) + (el.offsetHeight / 2);
    const startTop = container.scrollTop;
    const distance = targetTop - startTop;
    const duration = 600; // ms — fixed duration regardless of distance
    const startTime = performance.now();

    // Ease-out cubic for a natural deceleration feel
    const ease = (t) => 1 - Math.pow(1 - t, 3);

    const step = (now) => {
        const elapsed = Math.min((now - startTime) / duration, 1);
        container.scrollTop = startTop + distance * ease(elapsed);
        if (elapsed < 1) {
            requestAnimationFrame(step);
        } else {
            // Highlight with blurple tint after scroll completes
            el.classList.add('highlight-message');
            setTimeout(() => el.classList.remove('highlight-message'), 2000);
        }
    };

    requestAnimationFrame(step);
};

// ==========================================
// Clipboard Paste Upload
// ==========================================

window.setupPasteUpload = (textareaId, fileInputId) => {
    const textarea = document.getElementById(textareaId);
    const fileInput = document.getElementById(fileInputId);
    if (!textarea || !fileInput) return;

    textarea.addEventListener('paste', (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;

        const mediaFiles = [];
        for (const item of items) {
            if (item.type.startsWith('image/') || item.type.startsWith('video/')) {
                const file = item.getAsFile();
                if (file) mediaFiles.push(file);
            }
        }

        if (mediaFiles.length === 0) return;

        // Prevent the default paste (don't paste media as text)
        e.preventDefault();

        const dt = new DataTransfer();
        mediaFiles.forEach(f => dt.items.add(f));
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    });
};

// ==========================================
// Parallel File Upload via HTTP
// ==========================================

// Resumable file upload via tus.io protocol
// Returns same shape as old uploadFilesParallel: { success, error, files, totalCount, successCount }
window.uploadFilesWithTus = async (fileInputId, maxSizeMB, tusEndpoint, dotNetRef) => {
    const fileInput = document.getElementById(fileInputId);
    if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
        return { success: false, error: 'No files selected' };
    }

    maxSizeMB = maxSizeMB || 100;
    tusEndpoint = tusEndpoint || '/api/tus';
    const files = Array.from(fileInput.files);
    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.webm', '.mov', '.avi', '.mkv'];
    const maxSize = maxSizeMB * 1024 * 1024;

    // Check each file and collect rejection reasons
    const validFiles = [];
    const rejections = [];
    for (const f of files) {
        const ext = '.' + f.name.split('.').pop().toLowerCase();
        const isAllowedExt = allowedExtensions.includes(ext);
        const isAllowedMime = f.type.startsWith('image/') || f.type.startsWith('video/');

        if (!isAllowedExt && !isAllowedMime) {
            rejections.push(`"${f.name}" — unsupported file type`);
        } else if (f.size > maxSize) {
            const sizeMB = (f.size / 1024 / 1024).toFixed(0);
            rejections.push(`"${f.name}" — too large (${sizeMB} MB, max ${maxSizeMB} MB)`);
        } else {
            validFiles.push(f);
        }
    }

    if (validFiles.length === 0) {
        return { success: false, error: rejections.join('\n') || 'No valid files selected' };
    }

    // Track aggregate progress across all files
    const totalBytes = validFiles.reduce((sum, f) => sum + f.size, 0);
    const fileProgress = new Array(validFiles.length).fill(0);
    let completedFiles = 0;

    const updateProgress = () => {
        const uploadedBytes = fileProgress.reduce((sum, b) => sum + b, 0);
        const percent = totalBytes > 0 ? Math.round((uploadedBytes / totalBytes) * 100) : 0;
        if (dotNetRef) {
            dotNetRef.invokeMethodAsync('OnUploadProgress', percent, completedFiles, validFiles.length)
                .catch(() => {}); // ignore if circuit is dead
        }
    };

    // Upload all files via tus (parallel — browser limits concurrency naturally)
    const errors = [...rejections];
    const uploadPromises = validFiles.map((file, index) => {
        return new Promise((resolve) => {
            const upload = new tus.Upload(file, {
                endpoint: tusEndpoint,
                chunkSize: 5 * 1024 * 1024, // 5 MB chunks
                retryDelays: [0, 1000, 3000, 5000],
                withCredentials: true, // send cookies cross-origin
                metadata: {
                    filename: file.name,
                    filetype: file.type
                },
                onProgress: (bytesUploaded, bytesTotal) => {
                    fileProgress[index] = bytesUploaded;
                    updateProgress();
                },
                onSuccess: async () => {
                    completedFiles++;
                    fileProgress[index] = file.size;
                    updateProgress();

                    // Extract file ID from tus upload URL
                    const fileId = upload.url.split('/').pop();
                    console.log('[Tus] Upload complete:', file.name, 'fileId=' + fileId, 'url=' + upload.url);
                    try {
                        // Fetch the processed file info from server
                        // Server may still be processing (thumbnails/posters), retry briefly
                        let info = null;
                        const infoBaseUrl = upload.url.substring(0, upload.url.lastIndexOf('/'));
                        const infoUrl = infoBaseUrl + '/info/' + fileId;
                        console.log('[Tus] Fetching info from:', infoUrl);
                        for (let attempt = 0; attempt < 30; attempt++) {
                            const resp = await fetch(infoUrl, { credentials: 'include' });
                            console.log('[Tus] Info attempt', attempt + 1, 'status:', resp.status);
                            if (resp.ok) {
                                info = await resp.json();
                                break;
                            }
                            // Not ready yet, wait and retry
                            await new Promise(r => setTimeout(r, 1000));
                        }
                        if (info) {
                            console.log('[Tus] Got file info:', info);
                            resolve(info);
                        } else {
                            errors.push(`"${file.name}" — server processing timeout`);
                            resolve(null);
                        }
                    } catch (e) {
                        errors.push(`"${file.name}" — failed to get upload result`);
                        resolve(null);
                    }
                },
                onError: (error) => {
                    const msg = error.message || 'Upload failed';
                    errors.push(`"${file.name}" — ${msg}`);
                    resolve(null);
                }
            });

            upload.start();
        });
    });

    const results = await Promise.all(uploadPromises);
    const successful = results.filter(r => r !== null);

    // Clear the input for next upload
    fileInput.value = '';

    return {
        success: successful.length > 0,
        error: errors.length > 0 ? errors.join('\n') : null,
        files: successful,
        totalCount: files.length,
        successCount: successful.length
    };
};

// ==========================================
// Video Player Controls
// ==========================================

window.playVideo = (containerElement) => {
    if (!containerElement) return;
    const video = containerElement.querySelector('video');
    const overlay = containerElement.querySelector('.video-play-overlay');
    if (!video) return;

    video.controls = true;
    if (overlay) overlay.style.display = 'none';
    video.play().catch(() => {});

    // Show overlay again when video ends or pauses
    const showOverlay = () => {
        if (overlay) overlay.style.display = '';
        video.controls = false;
    };
    video.addEventListener('ended', showOverlay, { once: true });
    video.addEventListener('pause', () => {
        // Only show overlay if video is not seeking (user might be scrubbing)
        if (video.ended || video.currentTime === 0) {
            showOverlay();
        }
    }, { once: true });
};

// ==========================================
// Infinite Scroll Support
// ==========================================

let infiniteScrollRef = null;
let scrollHandler = null;
const SCROLL_THRESHOLD = 100; // pixels from top to trigger load

// Get current scroll height for position restoration
window.getScrollHeight = () => {
    const el = document.querySelector('.messages');
    return el ? el.scrollHeight : 0;
};

// Restore scroll position after prepending content
window.restoreScrollPosition = (previousScrollHeight) => {
    requestAnimationFrame(() => {
        const el = document.querySelector('.messages');
        if (!el) return;

        // New content was added at top, so scrollHeight increased
        // Adjust scrollTop by the difference to maintain visual position
        const heightDiff = el.scrollHeight - previousScrollHeight;
        el.scrollTop += heightDiff;
    });
};

// Setup infinite scroll detection
window.setupInfiniteScroll = (dotNetRef) => {
    infiniteScrollRef = dotNetRef;
    const messagesElement = document.querySelector('.messages');

    if (!messagesElement) return;

    let isLoading = false;

    scrollHandler = () => {
        if (isLoading) return;

        // Check if scrolled near top
        if (messagesElement.scrollTop <= SCROLL_THRESHOLD) {
            isLoading = true;
            infiniteScrollRef.invokeMethodAsync('OnScrollNearTop')
                .finally(() => {
                    // Small delay before allowing next load
                    setTimeout(() => { isLoading = false; }, 200);
                });
        }

        // Debounce version (if needed):
        // clearTimeout(debounceTimer);
        // debounceTimer = setTimeout(() => { ... }, 50);
    };

    messagesElement.addEventListener('scroll', scrollHandler, { passive: true });
};

// Cleanup infinite scroll
window.cleanupInfiniteScroll = () => {
    const messagesElement = document.querySelector('.messages');
    if (messagesElement && scrollHandler) {
        messagesElement.removeEventListener('scroll', scrollHandler);
    }
    scrollHandler = null;
    infiniteScrollRef = null;
};

// ==========================================
// Theme switching
// ==========================================

window.applyTheme = (themeId) => {
    document.documentElement.dataset.theme = themeId || 'discord-dark';
    // Retint the phone's status bar / browser chrome (defined in App.razor).
    window.syncThemeColorMeta?.();
};

// Root font size: scales every rem-based size in the app. Clearing the inline
// style (null/0) falls back to the browser default (16px).
window.applyFontSize = (px) => {
    document.documentElement.style.fontSize = px ? px + 'px' : '';
};

// ==========================================
// GIF (MP4) message autoplay — canplay-based
// ==========================================
// Why this exists: Blazor Server's prerender → hydrate cycle can race the browser's autoplay
// decision (see dotnet/aspnetcore#59415). Rather than rely on the `autoplay` attribute surviving
// hydration, we listen for the native `canplay` event in the capturing phase on the document.
// That event fires once the browser has buffered enough data to start playing, regardless of
// when the <video> element was added to the DOM or whether Blazor patched it. We then call .play(),
// which works for muted+playsinline videos under every browser's autoplay policy.
//
// If a video's play() ever rejects with NotAllowedError (rare for muted videos but possible under
// strict policy), we install a one-shot pointerdown/keydown listener so the next user gesture
// anywhere unblocks every paused .gif-message-video on the page.
(function () {
    if (window.__gifAutoplayWired) return;
    window.__gifAutoplayWired = true;

    // Both chat-message gifs and picker-grid previews share the same canplay-driven autoplay.
    const GIF_VIDEO_SELECTOR = '.gif-message-video, .gif-card-video';

    const isGifVideo = (v) =>
        v && v.tagName === 'VIDEO' && v.classList &&
        (v.classList.contains('gif-message-video') || v.classList.contains('gif-card-video'));

    const tryPlay = (v) => {
        if (!isGifVideo(v) || !v.paused) return;
        v.play().catch(err => {
            if (err && err.name === 'NotAllowedError') installClickUnlock();
            else console.warn(`[gif autoplay] ${err.name}: ${err.message} — ${v.currentSrc}`);
        });
    };

    function installClickUnlock() {
        if (window.__gifKickPending) return;
        window.__gifKickPending = true;
        const unlock = () => {
            window.__gifKickPending = false;
            document.removeEventListener('pointerdown', unlock, true);
            document.removeEventListener('keydown', unlock, true);
            document.querySelectorAll(GIF_VIDEO_SELECTOR).forEach(v => {
                if (v.paused) v.play().catch(() => {});
            });
        };
        document.addEventListener('pointerdown', unlock, true);
        document.addEventListener('keydown', unlock, true);
    }

    // Drop the loading spinner once a chat GIF can paint. The CSS spins until we add
    // .gif-loaded to the .gif-message box. Covers <img> (animated webp/gif) via `load` and
    // the legacy <video> fallback via `canplay`; `error` also clears it so a broken URL never
    // spins forever. closest('.gif-message') returns null for every other image/video on the
    // page (avatars, emojis, gallery images, picker previews), so this is a cheap no-op for them.
    const markGifLoaded = (el) => {
        const box = el && el.closest && el.closest('.gif-message');
        if (box) box.classList.add('gif-loaded');
    };

    // Catches every <video> reaching the canplay state — initial-render, freshly inserted, or
    // hydrated. Capturing-phase listener ensures we see the event regardless of bubbling.
    document.addEventListener('canplay', e => { tryPlay(e.target); markGifLoaded(e.target); }, true);
    // `load`/`error` don't bubble, so capture them at the document to catch <img> regardless of
    // when Blazor inserted or patched the element.
    document.addEventListener('load', e => markGifLoaded(e.target), true);
    document.addEventListener('error', e => markGifLoaded(e.target), true);
})();

// =============================================================================
// Picker visibility — client-owned view state
// =============================================================================
// Opening/closing the emoji & GIF pickers is pure presentation: Blazor mounts the panes
// (hidden) shortly after page load, and visibility rides on a data-picker attribute this
// file flips on .message-input-container — no circuit round trip. That div's CLASS is
// Blazor-interpolated, so JS state lives in attributes Blazor never renders (the
// data-dragging precedent). Every close rule lives here too: backdrop tap, textarea
// focus, send (send pipeline below), GIF pick (gif-card listener), layout flip.

window.closePickers = () => document.querySelectorAll('.message-input-container[data-picker]')
    .forEach(el => el.removeAttribute('data-picker'));

// Emoji search is fully client-side: filter the mounted grid in place against each
// cell's data-kw (rendered lowercase by EmojiPicker). Cells and emptied sections hide
// via JS-set attributes that Blazor never renders — re-renders can't clobber them.
// Delegated events, so the input picker and reaction-mode pickers behave identically.
const filterEmojiPicker = (picker, rawQuery) => {
    const q = (rawQuery || '').trim().toLowerCase();
    const content = picker?.querySelector('.emoji-content');
    if (!content) return;
    let total = 0;
    content.querySelectorAll('.emoji-section').forEach(section => {
        let hits = 0;
        section.querySelectorAll('.emoji-btn[data-emoji]').forEach(btn => {
            const hit = !q || (btn.dataset.kw || '').includes(q);
            btn.toggleAttribute('data-search-miss', !hit);
            if (hit) hits++;
        });
        section.toggleAttribute('data-search-empty', hits === 0);
        total += hits;
    });
    picker.querySelector('.emoji-search-empty')?.toggleAttribute('hidden', !q || total > 0);
    if (q) content.scrollTop = 0;             // surface the first matches, like the old results list
    content.dispatchEvent(new Event('scroll')); // re-sync the sidebar highlight to the new layout
};

// Clear a picker's search box + filter state (root may be the .emoji-picker itself or
// any ancestor). Used by the ✕ button, category jumps, and the reopen reset.
const resetEmojiSearchIn = (root) => {
    const pickers = root.matches?.('.emoji-picker') ? [root] : root.querySelectorAll('.emoji-picker');
    pickers.forEach(p => {
        const input = p.querySelector('.emoji-search input');
        if (input && input.value) { input.value = ''; filterEmojiPicker(p, ''); }
    });
};

document.addEventListener('input', (e) => {
    if (!e.target.matches?.('.emoji-picker .emoji-search input')) return;
    filterEmojiPicker(e.target.closest('.emoji-picker'), e.target.value);
});

// A pane just became visible: let its Blazor components refresh stale-able data behind
// the already-open UI (emoji recents, GIF recents + first-open trending), and nudge the
// emoji scroll-highlight, whose init ran inside display:none where every offsetTop was 0.
const notifyPickerOpened = (container, which) => {
    const pane = container.querySelector(`.emoji-picker-container[data-picker-pane="${which}"]`);
    if (!pane) {
        // The tap beat the ~1.2s background mount. Ask Blazor to mount now — the pane
        // arrives already-open (the attribute is set) and registerPickerOpenHook fires
        // the open hook once the components exist.
        container._pickerHostRef?.invokeMethodAsync('EnsurePickersMounted').catch(() => { });
        return;
    }
    pane.querySelectorAll('.emoji-picker, .gif-picker').forEach(p =>
        p._openRef?.invokeMethodAsync('OnPickerOpened').catch(() => { }));
    resetEmojiSearchIn(pane); // a leftover query from the previous open would hide the grid
    pane.querySelectorAll('.emoji-content').forEach(c => c.dispatchEvent(new Event('scroll')));
};

document.addEventListener('click', (e) => {
    // GIF / emoji toggle buttons
    const toggle = e.target.closest('[data-picker-toggle]');
    if (toggle) {
        const container = toggle.closest('.message-input-container');
        if (!container) return;
        const which = toggle.dataset.pickerToggle;
        if (container.dataset.picker === which) {
            container.removeAttribute('data-picker');
        } else {
            container.dataset.picker = which; // single-valued: also swaps picker→picker directly
            notifyPickerOpened(container, which);
        }
        return;
    }

    // Backdrop tap closes
    if (e.target.classList.contains('emoji-picker-backdrop')) {
        window.closePickers();
        return;
    }

    // Emoji search ✕ — clear the query and re-filter, all local
    const searchClear = e.target.closest('.emoji-search-clear');
    if (searchClear) {
        const picker = searchClear.closest('.emoji-picker');
        if (picker) resetEmojiSearchIn(picker);
        return;
    }

    // CombinedPicker (mobile) tabs: both panes stay mounted — switching is a local flip
    const tab = e.target.closest('[data-combined-tab]');
    if (tab) tab.closest('.combined-picker')?.setAttribute('data-active-tab', tab.dataset.combinedTab);
});

// Focusing the message box closes any open picker (one-gesture dismiss — the textarea
// sits above the backdrop, see [data-picker] .message-input) and marks composing state
// (mobile CSS trades the upload button for textarea width). focusin/focusout bubble,
// focus/blur don't. The send pipeline clears data-composing explicitly: the send
// button's mousedown-preventDefault keeps focus, so no focusout fires on send.
document.addEventListener('focusin', (e) => {
    if (!e.target.classList?.contains('message-input')) return;
    window.closePickers();
    e.target.closest('.message-input-container')?.setAttribute('data-composing', '');
});
document.addEventListener('focusout', (e) => {
    if (!e.target.classList?.contains('message-input')) return;
    e.target.closest('.message-input-container')?.removeAttribute('data-composing');
});

// Blazor refs for client-owned picker state: the MessageInput host (EnsurePickersMounted,
// for taps that beat the background mount) and each picker component (OnPickerOpened,
// refresh-on-open), stashed on their DOM elements — same pattern as _emojiDotNetRef.
window.registerPickerHost = (containerElement, dotNetRef) => {
    if (containerElement) containerElement._pickerHostRef = dotNetRef;
};

window.registerPickerOpenHook = (el, dotNetRef) => {
    if (!el) return;
    el._openRef = dotNetRef;
    // If this pane is already open (the user's tap beat the background mount), the
    // toggle-time notification found no components — fire the hook now they exist.
    const pane = el.closest('[data-picker-pane]');
    const container = el.closest('.message-input-container');
    if (pane && container && container.dataset.picker === pane.dataset.pickerPane) {
        dotNetRef.invokeMethodAsync('OnPickerOpened').catch(() => { });
        resetEmojiSearchIn(el);
        el.querySelector('.emoji-content')?.dispatchEvent(new Event('scroll'));
    }
};

// Category jump inside the emoji picker — fully client-side (the sidebar buttons carry
// no Blazor handlers): clear any active search first (it hides sections, so the jump
// would have no target), then scroll the section into view.
document.addEventListener('click', (e) => {
    const btn = e.target.closest('.emoji-picker .category-btn[data-category]');
    if (!btn) return;
    const picker = btn.closest('.emoji-picker');
    resetEmojiSearchIn(picker);
    picker.querySelector('.emoji-content')
        ?.querySelector(`.emoji-section[data-section="${btn.dataset.category}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}, true);

// =============================================================================
// Client send pipeline + latency telemetry
// =============================================================================
// RTT probe: times a no-op circuit call with performance.now(). Deliberately measures the FULL
// experienced round trip — transport + dispatcher queue — because that's the latency the user
// feels. Each ping carries the PREVIOUS measurement, so one call both measures and reports.
// Send pipeline: every text send physically goes through a .send-button click (Enter clicks it
// too, see setupEnterKeyHandler), so the capture listener below is the one place that runs the
// instant-feedback work: telemetry mark, optimistic ghost, input clear. The server's HandleSend
// keeps its own guard and remains the single server entry point.

let telemetryRef = null;   // refreshed on every setup — a resumed circuit brings a fresh DotNetObjectReference
let telemetryUser = null;
let sendMark = null;       // performance.now() of the pending send; null = none pending
let sendObserver = null;

window.setupLatencyProbe = (dotNetRef, username) => {
    telemetryRef = dotNetRef;
    telemetryUser = username;

    if (window._yapProbeTimer) clearInterval(window._yapProbeTimer);
    let lastRtt = null;

    const ping = () => {
        // Heartbeat + measurement in one call: visibility and input-idle keep the server's
        // per-session presence truthful even in tabs that never fire a visibilitychange event.
        // RTT is only measured while visible — hidden tabs get throttled timers, garbage samples.
        const visible = document.visibilityState === 'visible';
        const idleSeconds = Math.round((performance.now() - lastInputTs) / 1000);
        const t0 = performance.now();
        telemetryRef.invokeMethodAsync('ProbePing', lastRtt, visible, idleSeconds)
            .then(() => { lastRtt = visible ? Math.round(performance.now() - t0) : null; })
            .catch(() => { lastRtt = null; }); // circuit down — keep ticking, reporting resumes with the circuit
    };

    window._yapProbeTimer = setInterval(ping, 10000);
    ping();
};

// Installed at script load, NOT from setupLatencyProbe — the send UX must work even
// when telemetry never initialized. Capture phase: runs before Blazor's delegated
// @onclick, so the ghost and the cleared input are painted while the click RPC travels.
document.addEventListener('click', (e) => {
    const btn = e.target.closest('.send-button');
    if (!btn) return;
    const container = btn.closest('.message-input-container');
    const textarea = container?.querySelector('.message-input');
    if (!textarea) return;

    if (!textarea.value.trim()) {
        // Nothing to send — but still commit the (empty) draft. A stale earlier commit
        // (text blurred in, then deleted with no blur since) would otherwise sit in
        // messageText, pass HandleSend's guard, and send ghost-of-the-past content.
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
        return;
    }

    // Commit the draft BEFORE the click's RPC: the box is plain @bind (change
    // granularity — typing costs zero dispatches), and Blazor serializes the value
    // synchronously during this dispatchEvent. In-order circuit processing lands the
    // change ahead of the click, so HandleSend's guard reads fresh messageText.
    // Invariant (supersedes the old "no synthetic input" rule): the synthetic change
    // carries the FULL value and fires BEFORE the clear below — and never anything
    // after the clear, for the original reason: a post-clear event would sync
    // messageText='' ahead of the click and the guard would reject the send.
    // (This is the edit-box save pattern applied to send.)
    textarea.dispatchEvent(new Event('change', { bubbles: true }));

    // Typing: reset the local burst flag only — HandleSend broadcasts its own stop.
    textarea._typingLocalReset?.();

    // Sending closes an open picker and ends "composing" (client-owned state; the old
    // server-side HandleSend flags are gone). Explicit here because the send button's
    // mousedown-preventDefault keeps focus on the textarea — no focusout will fire.
    container.removeAttribute('data-picker');
    container.removeAttribute('data-composing');

    if (telemetryRef) {
        sendMark = performance.now();
        watchForOwnMessage(sendMark);
    }

    showPendingEcho(textarea.value);

    // Instant clear (the draft above was committed pre-clear).
    textarea.value = '';
    window.resetTextareaHeight(textarea.id);
    window.scrollToBottom();
}, true);

// Optimistic echo: a dimmed plain-text ghost of the sent message, shown until the real
// render arrives (or 15s for a send that never echoes — its quiet disappearance is the
// "didn't send" signal). Ghosts live in .pending-echoes, a container Blazor always
// renders empty, so JS-owned children survive render batches. textContent only — never
// parsed as HTML. The ghost class must never be 'message-group': both the telemetry
// observer and the reconciler below match on that.
let echoObserver = null;
let echoTarget = null;     // the .messages-flow element the reconciler is bound to

// Shared tail of every optimistic echo (text and GIF): mount in the JS-owned
// container, arm the 15s "never sent" self-remove, ensure the reconciler is watching.
const appendPendingEcho = (ghost) => {
    const host = document.querySelector('.pending-echoes');
    if (!host) return;
    host.appendChild(ghost);
    setTimeout(() => ghost.remove(), 15000);
    watchForEchoConfirm();
};

const showPendingEcho = (text) => {
    const ghost = document.createElement('div');
    ghost.className = 'pending-message';
    ghost.textContent = text;
    appendPendingEcho(ghost);
};

// Persistent reconciler, separate from the one-shot telemetry observer: each of the
// sender's own messages that renders removes the oldest ghost (FIFO), so rapid sends
// inside one round trip all drain correctly. Re-binds if the .messages-flow element
// was replaced by navigation. MutationObserver runs pre-paint, so the swap is
// flicker-free. Both observers here watch DIRECT children only (no subtree), so they
// must bind to the element that directly contains the .message-group nodes — that is
// .messages-flow since the pattern-scroll wrapper landed. Binding to .messages made
// them blind: ghosts lingered to the 15s timeout next to the real message.
const watchForEchoConfirm = () => {
    const messages = document.querySelector('.messages-flow');
    if (!messages) return;
    if (echoObserver && echoTarget === messages) return;
    echoObserver?.disconnect();
    echoTarget = messages;
    echoObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== 1 || !node.matches?.('.message-group')) continue;
                // Without a known username (telemetry down) the 15s timeout cleans up instead.
                if (!telemetryUser || node.dataset.author !== telemetryUser) continue;
                document.querySelector('.pending-echoes .pending-message')?.remove();
            }
        }
    });
    echoObserver.observe(messages, { childList: true });
};

// Room/DM switches reuse the same DOM — a pending ghost's echo can never arrive in
// the new channel, so the switch paths drop ghosts explicitly.
window.clearPendingEchoes = () => {
    document.querySelectorAll('.pending-echoes .pending-message').forEach(g => g.remove());
};

// GIF-select instant feedback: tapping a picker card closes the picker at once and
// shows an optimistic ghost of the chosen GIF; the real message arrives one round trip
// later. Capture phase, installed at script load — same rationale as the send-button
// listener above. Blazor's @onclick still fires: the close is just an attribute flip
// (the mounted pane goes display:none) and the event keeps propagating.
document.addEventListener('click', (e) => {
    const card = e.target.closest('.gif-picker .gif-card');
    if (!card) return;
    // The favorite star lives inside the card — starring must not close or ghost.
    // (Its Blazor stopPropagation is bubble-phase; this capture listener runs first.)
    if (e.target.closest('.gif-fav-btn')) return;

    // Close instantly — the same client-owned data-picker state the toggle buttons flip.
    card.closest('.message-input-container')?.removeAttribute('data-picker');

    // Ghost built from the preview the user actually saw — it's in the browser cache,
    // so it paints instantly. createElement + property assignment only (XSS-safe).
    const img = card.querySelector('img');
    const vid = card.querySelector('video');
    const src = img?.src || vid?.src;
    if (!src) return; // no preview to echo — close-only

    // Class must include pending-message (all echo machinery keys on it) and must
    // never be message-group (both MutationObservers match on that).
    const ghost = document.createElement('div');
    ghost.className = 'pending-message pending-gif';

    let media;
    if (img) {
        media = document.createElement('img');
    } else {
        media = document.createElement('video');
        media.muted = true;
        media.autoplay = true;
        media.loop = true;
        media.playsInline = true;
        media.className = 'gif-card-video'; // rides the document-level canplay autoplay wiring
    }
    media.src = src;
    // The card carries the true aspect ratio inline — copying it reserves the ghost's
    // height before the preview paints, so the message list doesn't jump.
    if (card.style.aspectRatio) media.style.aspectRatio = card.style.aspectRatio;
    ghost.appendChild(media);

    appendPendingEcho(ghost);
    window.scrollToBottom();
}, true);

const watchForOwnMessage = (myMark) => {
    // .messages-flow, not .messages: direct-children watch (see watchForEchoConfirm).
    const container = document.querySelector('.messages-flow');
    if (!container) { sendMark = null; return; }

    sendObserver?.disconnect();
    sendObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== 1 || !node.matches?.('.message-group')) continue;
                if (node.dataset.author !== telemetryUser || sendMark === null) continue;
                const ms = performance.now() - sendMark;
                sendMark = null;
                sendObserver.disconnect();
                console.log(`[yap] send→appear: ${ms.toFixed(0)}ms`);
                telemetryRef?.invokeMethodAsync('ReportSendTiming', ms).catch(() => {});
                return;
            }
        }
    });
    sendObserver.observe(container, { childList: true });

    // A send that never echoes (error, disconnect) must not leave the observer running.
    // Guard on myMark so an older send's timeout can't kill a newer pending one.
    setTimeout(() => {
        if (sendMark === myMark) { sendMark = null; sendObserver?.disconnect(); }
    }, 15000);
};
