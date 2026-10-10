// Blocking, before CSS in both shells. This tiny mirror is only appearance data;
// IndexedDB remains the owner of account data and offline work.
(() => {
    const root = document.documentElement;
    const key = 'yap-appearance';
    let current;
    function apply(value) {
        current = {
            userId: value.userId,
            theme: value.theme || 'discord-dark',
            fontSize: value.fontSize >= 12 && value.fontSize <= 24 ? value.fontSize : null,
        };
        root.dataset.theme = current.theme;
        root.style.fontSize = current.fontSize ? `${current.fontSize}px` : '';
        try {
            localStorage.setItem(key, JSON.stringify(current));
        } catch {
            /* Storage may be blocked. */
        }
    }
    if (root.dataset.appearanceUser) {
        apply({
            userId: root.dataset.appearanceUser,
            theme: root.dataset.theme,
            fontSize: parseInt(root.style.fontSize),
        });
    } else {
        try {
            const saved = JSON.parse(localStorage.getItem(key));
            if (saved) apply(saved);
        } catch {
            /* First visit or unavailable storage uses the default. */
        }
    }
    // Tea House must have its scene before first paint, too.
    const scenes = [
        'midnight',
        'midnight',
        '2am',
        '314am',
        '4am',
        '4am',
        '6am',
        '6am',
        '8am',
        '8am',
        '10am',
        '10am',
        'noon',
        'noon',
        '2pm',
        '2pm',
        '4pm',
        '4pm',
        '6pm',
        '6pm',
        '8pm',
        '8pm',
        '10pm',
        '10pm',
    ];
    root.dataset.scene = scenes[new Date().getHours()];
    window.yapAppearance = {
        apply,
        get current() {
            return current;
        },
    };
})();
