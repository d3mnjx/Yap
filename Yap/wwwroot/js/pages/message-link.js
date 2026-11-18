// The address of a message link, /m/{code} (TL-43). The page has nothing of its own to show: it asks the server
// where the message is and gives its place in the history to that conversation (message-links.js open). The
// question needs the hub, so after a fresh load the content column is empty until the hub is connected. The frame
// shows the state of the connection in the meantime (SH-16), as on every page.

import * as hub from '../hub.js';
import * as frame from '../ui/frame.js';
import { setTitle } from '../notify.js';
import { projectName } from '../store.js';
import { idOf, open } from '../message-links.js';

export function mount(root, { code }) {
  root.replaceChildren();
  // Without this the header keeps the name of the page before, over an empty column.
  frame.setTitle('page', { text: 'Message link' });
  setTitle(`${projectName()} | Message link`);

  const id = idOf(code);
  let off = () => {};
  // One time: the hook runs again after every reconnect, and the open has left this page by then.
  const go = () => { off(); open(id); };
  if (!id || hub.connected()) go();   // a text that is no code needs no server: open() refuses it without a question
  else off = hub.onConnected(go);
  return () => off();
}
