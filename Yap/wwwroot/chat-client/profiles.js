export function createProfiles({ avatar, text, status }) {
    let popup;
    const node = (tag, cls, value) => {
        const n = document.createElement(tag);
        n.className = cls;
        if (value !== undefined) n.textContent = value;
        return n;
    };
    function close() {
        popup?.remove();
        popup = null;
        document.querySelector('.profile-popup-backdrop')?.remove();
    }
    function show(person, event, mobile = false) {
        close();
        popup = node('div', 'profile-popup' + (mobile ? ' is-mobile' : ''));
        popup.setAttribute('role', 'dialog');
        popup.setAttribute('aria-label', 'Profile of ' + person.username);
        const card = node('div', 'profile-card'),
            banner = node('div', 'profile-card-banner');
        banner.style.background = person.gradient;
        card.append(banner);
        const face = node('div', 'profile-card-avatar'),
            image = avatar(person);
        image.className = 'avatar avatar-large';
        face.append(image);
        card.append(face);
        const body = node('div', 'profile-card-body'),
            identity = node('div', 'profile-card-identity'),
            name = node('span', 'profile-card-name');
        name.append(text(person.displayName));
        for (const [flag, label, emoji] of [
            [person.isAdmin, 'Admin', '👑'],
            [person.isBot, 'Bot', '🤖'],
        ])
            if (flag) {
                const badge = node('span', 'profile-card-badge');
                badge.title = label;
                badge.append(text(emoji));
                name.append(badge);
            }
        identity.append(name, node('span', 'profile-card-username', '@' + person.username));
        body.append(identity);
        const state = status(person.username) || 'invisible',
            line = node('div', 'profile-card-statusline');
        line.append(
            node('span', 'profile-card-status-dot ' + (state === 'invisible' ? 'offline' : state)),
            node(
                'span',
                '',
                state === 'invisible' ? 'Offline' : state === 'away' ? 'Away' : 'Online',
            ),
        );
        body.append(line, node('div', 'profile-card-divider'));
        if (person.bio) {
            const section = node('div', 'profile-card-section');
            section.append(node('span', 'profile-card-label', 'About me'));
            const bio = node('p', 'profile-card-bio');
            bio.append(text(person.bio));
            section.append(bio);
            body.append(section);
        } else {
            const empty = node('p', 'profile-card-empty');
            empty.append(text('No bio yet — a person of mystery 🕵️'));
            body.append(empty);
        }
        if (person.country) {
            const meta = node('div', 'profile-card-meta');
            meta.append(text('📍'), node('span', '', person.country));
            body.append(meta);
        }
        if (person.createdAt) {
            const meta = node('div', 'profile-card-meta');
            meta.append(
                text('🗓️'),
                node(
                    'span',
                    '',
                    'Member since ' +
                        new Date(person.createdAt).toLocaleDateString('en', {
                            month: 'long',
                            year: 'numeric',
                        }),
                ),
            );
            body.append(meta);
        }
        card.append(body);
        popup.append(card);
        document.body.append(popup);
        if (mobile) {
            const backdrop = node('div', 'profile-popup-backdrop');
            backdrop.onclick = close;
            document.body.insertBefore(backdrop, popup);
        } else {
            popup.style.left = `clamp(8px, ${event.clientX - 292}px, calc(100vw - 288px))`;
            popup.style.top = `clamp(8px, ${event.clientY - 56}px, calc(100dvh - 348px))`;
        }
    }
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') close();
    });
    document.addEventListener('chat-clear', close);
    return {
        show,
        close,
        hideHover() {
            if (!popup?.classList.contains('is-mobile')) close();
        },
    };
}
