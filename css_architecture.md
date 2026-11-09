# CSS

The client is static files. There is no build step and no scoping: every rule is global, and `index.html` loads
every stylesheet at the start. The order of the files matters, because a later file wins a tie.

`Yap/wwwroot/css/README.md` is the map. It has the files with their subjects and their JavaScript modules, the
places where the load order decides, the root classes (`.page-login`, `.page-admin`, `.emoji-picker`, ...) that
keep equal class names apart, the two width tiers, the `z-index` layers, and the theme tokens.

The rules in short:

- One file holds one part of the screen or one page. Rules that two pages share are in `css/pages.css`.
- A colour is a token from `:root` in `app.css`. A theme changes token values in `themes.css` and nothing else.
- The JavaScript sets state through classes and a few data attributes. The map names them.
- Two width tiers apply: 768 px for the sidebar and 600 px for the compact components
  (`docs/spec/general-rules.md`, GEN-14).

The same working tree is built from Windows and from Linux. A build output that mixes the two serves an unstyled
page, so delete `Yap/bin` and `Yap/obj` before a build on the other system. The static files themselves need no build.
