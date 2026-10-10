import { imageSource } from './media.js';
export async function openGallery(images, start, userId) {
    if (!images.length) return;
    const previous = document.activeElement,
        modal = document.createElement('div'),
        strip = document.createElement('div');
    modal.className = 'image-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Image gallery');
    strip.className = 'gallery-strip';
    modal.append(strip);
    const urls = [],
        stages = [];
    let closed = false,
        index = Math.max(0, Math.min(start, images.length - 1)),
        lastTap,
        drag;
    const close = () => {
        if (closed) return;
        closed = true;
        observer.disconnect();
        modal.remove();
        document.removeEventListener('keydown', key);
        document.removeEventListener('chat-clear', close);
        window.removeEventListener('resize', resize);
        urls.forEach(URL.revokeObjectURL);
        previous?.focus();
    };
    const button = (label, cls, title, action) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.className = cls;
        b.title = title;
        b.setAttribute('aria-label', title);
        b.onclick = action;
        modal.append(b);
        return b;
    };
    const go = (delta) =>
        strip.scrollTo({
            left: Math.max(0, Math.min(index + delta, images.length - 1)) * strip.clientWidth,
            behavior: 'smooth',
        });
    const prev = button('‹', 'modal-nav prev', 'Previous image', () => go(-1)),
        next = button('›', 'modal-nav next', 'Next image', () => go(1));
    prev.hidden = next.hidden = images.length < 2;
    function toggleFill(stage, rx = 0.5, ry = 0.5) {
        const img = stage?.querySelector('img');
        if (!img?.naturalWidth) return;
        if (stage.classList.contains('fill')) {
            stage.classList.remove('fill', 'fill-w');
            return;
        }
        // CSS cannot compare intrinsic image and viewport ratios; choose the covering axis here.
        stage.classList.toggle(
            'fill-w',
            img.naturalWidth / img.naturalHeight < stage.clientWidth / stage.clientHeight,
        );
        stage.classList.add('fill');
        stage.scrollLeft = rx * img.clientWidth - stage.clientWidth / 2;
        stage.scrollTop = ry * img.clientHeight - stage.clientHeight / 2;
    }
    button('', 'modal-fill', 'Fill screen', () => toggleFill(stages[index]));
    const dismiss = button('×', 'modal-close', 'Close gallery', close);
    const counter = document.createElement('div');
    counter.className = 'modal-counter';
    counter.hidden = images.length < 2;
    modal.append(counter);
    function update() {
        index = Math.max(
            0,
            Math.min(Math.round(strip.scrollLeft / strip.clientWidth), images.length - 1),
        );
        counter.textContent = `${index + 1} / ${images.length}`;
    }
    strip.onscroll = update;
    const observer = new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) entry.target.upgrade?.();
                else entry.target.classList.remove('fill', 'fill-w');
            }
        },
        { root: strip, threshold: 0.6 },
    );
    function key(event) {
        if (event.key === 'Escape') close();
        if (event.key === 'ArrowRight') {
            event.preventDefault();
            go(1);
        }
        if (event.key === 'ArrowLeft') {
            event.preventDefault();
            go(-1);
        }
        if (event.key === 'Tab') {
            const buttons = [...modal.querySelectorAll('button')].filter((n) => !n.hidden),
                i = buttons.indexOf(document.activeElement);
            buttons[(i + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
            event.preventDefault();
        }
    }
    const resize = () => {
        strip.scrollLeft = index * strip.clientWidth;
        for (const stage of stages) stage.classList.remove('fill', 'fill-w');
    };
    images.forEach((image, i) => {
        const stage = document.createElement('div'),
            img = document.createElement('img');
        stage.className = 'modal-stage';
        img.alt = 'Full size image';
        img.draggable = false;
        img.loading = i === index ? 'eager' : 'lazy';
        stage.append(img);
        strip.append(stage);
        stages.push(stage);
        stage.onclick = (event) => {
            if (event.target === stage) close();
        };
        let ready = false,
            upgraded = false;
        const missing = () => {
            if (closed) return;
            img.remove();
            const note = document.createElement('p');
            note.textContent = 'This image is not cached. Connect to download it.';
            stage.append(note);
        };
        stage.upgrade = () => {
            if (!ready || upgraded || !navigator.onLine || closed) return;
            upgraded = true;
            const large = new Image();
            large.onload = () => {
                if (!closed) {
                    img.src = image.large;
                    img.onerror = null;
                }
            };
            large.src = image.large;
        };
        (async () => {
            const source =
                (await imageSource(image.large, userId)) ||
                (await imageSource(image.medium, userId));
            if (closed) {
                if (source) URL.revokeObjectURL(source);
                return;
            }
            if (source) {
                urls.push(source);
                img.src = source;
                ready = true;
                if (i === index) stage.upgrade();
            } else {
                upgraded = true;
                img.onerror = () => {
                    img.onerror = missing;
                    img.src = image.medium;
                };
                img.src = navigator.onLine ? image.large : image.medium;
            }
        })().catch(missing);
        observer.observe(stage);
    });
    modal.addEventListener('pointerdown', (event) => {
        const stage = event.target.closest('.modal-stage:not(.fill)');
        if (!stage || event.pointerType !== 'touch' || !event.isPrimary) return;
        drag = { y: event.clientY, stage };
        stage.classList.add('dragging');
    });
    modal.addEventListener('pointermove', (event) => {
        if (!drag) return;
        const dy = Math.max(0, event.clientY - drag.y);
        drag.stage.style.transform = `translateY(${dy}px)`;
        modal.style.setProperty('--drag', Math.min(1, dy / 300));
    });
    function endDrag(event) {
        if (!drag) return;
        const { stage, y } = drag;
        drag = null;
        stage.classList.remove('dragging');
        if (event.type === 'pointerup' && event.clientY - y > 120) {
            close();
            return;
        }
        stage.style.transform = '';
        modal.style.removeProperty('--drag');
        if (Math.abs(event.clientY - y) > 25) lastTap = null;
    }
    modal.addEventListener('pointerup', (event) => {
        const img = event.target.closest('.modal-stage > img');
        if (img && (!drag || Math.abs(event.clientY - drag.y) < 25)) {
            const r = img.getBoundingClientRect(),
                tap = { t: event.timeStamp, x: event.clientX, y: event.clientY };
            if (
                lastTap &&
                tap.t - lastTap.t < 300 &&
                Math.hypot(tap.x - lastTap.x, tap.y - lastTap.y) < 25
            ) {
                toggleFill(img.parentElement, (tap.x - r.x) / r.width, (tap.y - r.y) / r.height);
                lastTap = null;
            } else lastTap = tap;
        } else lastTap = null;
        endDrag(event);
    });
    modal.addEventListener('pointercancel', endDrag);
    document.addEventListener('keydown', key);
    document.addEventListener('chat-clear', close);
    window.addEventListener('resize', resize);
    document.body.append(modal);
    strip.scrollLeft = index * strip.clientWidth;
    update();
    dismiss.focus();
}
