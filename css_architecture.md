# CSS ownership

Chat uses ordinary stylesheets with no runtime extraction or frontend build step. The retained Blazor pages use CSS isolation for their own controls.

| File under `Yap/wwwroot/` | Owner |
| --- | --- |
| `app.css` | Global resets, typography and default theme variables |
| `themes.css`, `themes/` | Theme variables, scenes and artwork |
| `chat-client/shared.css` | Shared layout, header, sidebar, avatars, profiles and push prompt |
| `chat-client/messages.css` | Message rows, actions, reactions and timeline layout |
| `chat-client/composer.css` | Composer, reply bar, attachments and typing |
| `chat-client/pickers.css` | Emoji and GIF pickers |
| `chat-client/gallery.css` | Image gallery |
| `chat-client/media.css` | Image, video, audio and link cards |
| `chat-client/chat.css` | Browser shell presentation and responsive states |

`Components/App.razor` loads the shared styles for retained Blazor pages; `chat-client/index.html` loads the browser chat styles. Admin, Settings and ChannelSettings use page-specific class names for back buttons, status dots, names and admin badges so shared chat selectors do not style those controls. Their `.razor.css` files remain their owners. Other retained components keep their existing scoped styles.

The retired Blazor chat, message input/rows, pickers and gallery have no `.razor.css` files. Change the stylesheet responsible for the current browser control. Preserve theme variables and media element lifetimes; a stylesheet change changes the startup shell manifest hash automatically.

Theme scenes and browser theme-color belong to `js/appearance.js`. See [the maintenance guide](docs/offline-client-architecture.md#styles-and-retained-blazor-pages) and [theme design](docs/themes-2.0.md). Publish complete output, including compressed assets, then restart to rebuild the shell inventory.
