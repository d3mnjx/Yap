export function createScroll(scroller) {
    let following = true,
        previousTop = scroller.scrollTop,
        frame;
    const nearBottom = () =>
        scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 80;
    const update = () => {
        cancelAnimationFrame(frame);
        if (!following) return;
        frame = requestAnimationFrame(() => {
            if (!following) return;
            scroller.scrollTop = scroller.scrollHeight;
            previousTop = scroller.scrollTop;
        });
    };
    scroller.addEventListener(
        'scroll',
        () => {
            // Growing media can move the bottom without a user scroll. Only upward movement
            // releases the bottom lock; otherwise late images would strand us above new content.
            if (nearBottom()) following = true;
            else if (scroller.scrollTop < previousTop - 1) following = false;
            previousTop = scroller.scrollTop;
        },
        { passive: true },
    );
    scroller.addEventListener(
        'wheel',
        (event) => {
            if (event.deltaY < 0) following = false;
        },
        { passive: true },
    );
    let touchY;
    scroller.addEventListener(
        'touchstart',
        (event) => {
            touchY = event.touches[0]?.clientY;
        },
        { passive: true },
    );
    scroller.addEventListener(
        'touchmove',
        (event) => {
            if (event.touches[0]?.clientY > touchY) following = false;
            touchY = event.touches[0]?.clientY;
        },
        { passive: true },
    );
    document.addEventListener('keydown', (event) => {
        if (
            !event.target.closest('input,textarea,[contenteditable]') &&
            ['ArrowUp', 'PageUp', 'Home'].includes(event.key)
        )
            following = false;
    });
    // Observe actual layout instead of fixed delays: uploads, lazy images, video metadata
    // and composer resizing can all finish after the conversation's first render.
    const resize = new ResizeObserver(update);
    resize.observe(scroller);
    resize.observe(scroller.querySelector('.messages-flow'));
    return {
        update,
        preserve() {
            if (following) return () => {};
            const bounds = scroller.getBoundingClientRect();
            const anchors = [];
            for (const node of scroller.querySelectorAll('#timeline > .message-group')) {
                const rect = node.getBoundingClientRect();
                if (rect.top > bounds.bottom) break;
                if (rect.bottom > bounds.top) anchors.push({ id: node.id, top: rect.top });
            }
            return () => {
                // A reaction/edit above the viewport can change its height; a deletion can
                // remove the first visible row. Keep the next surviving visible row in place.
                for (const anchor of anchors) {
                    const node = document.getElementById(anchor.id);
                    if (!node) continue;
                    scroller.scrollTop += node.getBoundingClientRect().top - anchor.top;
                    previousTop = scroller.scrollTop;
                    break;
                }
            };
        },
        bottom() {
            following = true;
            update();
        },
        reset() {
            following = false;
            cancelAnimationFrame(frame);
            previousTop = 0;
        },
    };
}
