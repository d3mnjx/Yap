// The square preview of a picked file: the picture, or the first frame of a video with a play mark (IB-33). The
// tray of the input box and the pending row draw the same square (IB-34); its styles are the tray's (composer.css).

import { el } from './dom.js';

export function fileThumb(file, url) {
  const video = file.type.startsWith('video/');
  // #t=0.001 makes Safari draw the first frame; it draws nothing for a plain metadata preload.
  const media = video ? el('video', { class: 'tray-media', src: `${url}#t=0.001`, muted: true, playsinline: true, preload: 'metadata' })
                      : el('img', { class: 'tray-media', src: url, alt: file.name });
  return el('div', { class: 'tray-item', title: file.name }, media, video ? el('span', { class: 'tray-play', 'aria-hidden': 'true' }) : null);
}
