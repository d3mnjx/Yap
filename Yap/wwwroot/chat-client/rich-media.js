const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
};
const externalLink = (url, cls, text) => {
    const a = el('a', cls, text);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
};
const source = (video, url, type) => {
    const s = el('source', '');
    s.src = url;
    if (type) s.type = type;
    video.append(s);
};
export function renderMedia(message, content, onFavorite) {
    if (message.videos?.length) {
        const gallery = el('div', 'video-gallery');
        content.append(gallery);
        for (const url of message.videos) {
            const box = el('div', 'video-container'),
                video = el('video', 'video-player');
            video.preload = 'none';
            video.playsInline = true;
            video.poster = url.replace(/\.[^.]+$/, '_poster.webp');
            source(video, url.replace(/\.[^.]+$/, '.mp4'), 'video/mp4');
            source(video, url);
            const play = el('button', 'video-play-overlay');
            play.title = 'Play video';
            play.setAttribute('aria-label', 'Play video');
            // Static original icon, never user content.
            play.innerHTML =
                '<svg class="play-icon" viewBox="0 0 64 64" fill="white"><circle cx="32" cy="32" r="30" fill="rgba(0,0,0,0.5)"/><polygon points="26,20 26,44 46,32"/></svg>';
            play.onclick = () => {
                video.controls = true;
                play.hidden = true;
                video.play().catch(() => {
                    play.hidden = false;
                });
            };
            box.append(video, play);
            gallery.append(box);
        }
    }
    if (message.gifs?.length) {
        const gallery = el('div', 'gif-message-gallery');
        content.append(gallery);
        for (const gif of message.gifs) {
            const box = el('div', 'gif-message');
            box.style.maxWidth = gif.width ? Math.min(gif.width, 360) + 'px' : '240px';
            box.style.aspectRatio = gif.width && gif.height ? gif.width + '/' + gif.height : '1';
            const isVideo = /\.(mp4|webm)(?:\?|$)/i.test(gif.url || ''),
                media = el(isVideo ? 'video' : 'img', isVideo ? 'gif-message-video' : '');
            media.src = gif.url || '';
            if (gif.width) media.width = gif.width;
            if (gif.height) media.height = gif.height;
            if (isVideo) {
                media.autoplay = true;
                media.loop = true;
                media.muted = true;
                media.playsInline = true;
                media.preload = 'auto';
                media.oncanplay = () => {
                    box.classList.add('gif-loaded');
                    media.play().catch(() => {});
                };
            } else {
                media.alt = gif.title || 'GIF';
                media.loading = 'lazy';
                media.onload = () => box.classList.add('gif-loaded');
            }
            // Original CSS owns the spinner; both load and error must release it.
            media.onerror = () => {
                box.classList.add('gif-loaded');
                media.hidden = true;
                box.append(el('div', 'gif-message-missing', 'GIF unavailable'));
            };
            box.append(media);
            if (!message.pending && gif.id) {
                const star = el('button', 'gif-message-fav' + (gif.favorite ? ' favorited' : ''));
                star.title = gif.favorite ? 'Remove from favorites' : 'Add to favorites';
                star.innerHTML =
                    '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>';
                star.onclick = () => onFavorite(gif, star);
                box.append(star);
            }
            if (gif.uploader) {
                const via = el('div', 'gif-message-uploader', 'via ' + gif.uploader);
                via.title = 'Uploaded by ' + gif.uploader;
                box.append(via);
            }
            gallery.append(box);
        }
    }
    for (const preview of message.previews || []) {
        if (preview.cachedMediaUrl) {
            const container = el('div', 'media-player-container');
            content.append(container);
            if (preview.mediaType === 1) {
                const player = el('div', 'cached-audio-player'),
                    info = el('div', 'audio-info');
                container.append(player);
                if (preview.imageUrl) {
                    const thumb = el('img', 'audio-thumbnail');
                    thumb.src = preview.imageUrl;
                    thumb.alt = '';
                    thumb.loading = 'lazy';
                    player.append(thumb);
                }
                player.append(info);
                if (preview.title) info.append(el('span', 'audio-title', preview.title));
                if (preview.siteName) info.append(el('span', 'audio-site', preview.siteName));
                const audio = el('audio', 'audio-element');
                audio.controls = true;
                audio.preload = 'metadata';
                source(audio, preview.cachedMediaUrl);
                info.append(audio);
            } else {
                if (preview.title || preview.siteName) {
                    const info = el('div', 'video-info');
                    if (preview.siteName) info.append(el('span', 'video-site', preview.siteName));
                    if (preview.title)
                        info.append(externalLink(preview.url, 'video-title', preview.title));
                    container.append(info);
                }
                const video = el('video', 'cached-video-player');
                video.controls = true;
                video.preload = 'metadata';
                video.playsInline = true;
                // Safari does not preload video frames; prefer the stable local poster over expiring OG images.
                if (preview.cachedPosterUrl || preview.imageUrl)
                    video.poster = preview.cachedPosterUrl || preview.imageUrl;
                if (preview.mediaWidth > 0 && preview.mediaHeight > 0)
                    video.style.aspectRatio = preview.mediaWidth + '/' + preview.mediaHeight;
                source(video, preview.cachedMediaUrl, 'video/mp4');
                container.append(video);
            }
            continue;
        }
        if (preview.failed || (!preview.title && !preview.description)) continue;
        const card = externalLink(preview.url, 'link-preview-card'),
            text = el('div', 'link-preview-content');
        for (const [key, cls] of [
            ['siteName', 'link-preview-site'],
            ['title', 'link-preview-title'],
            ['description', 'link-preview-description'],
        ])
            if (preview[key]) text.append(el('span', cls, preview[key]));
        card.append(text);
        if (preview.imageUrl) {
            const thumb = el('div', 'link-preview-thumbnail'),
                img = el('img', '');
            img.src = preview.imageUrl;
            img.alt = '';
            img.loading = 'lazy';
            thumb.append(img);
            card.append(thumb);
        }
        content.append(card);
    }
}
