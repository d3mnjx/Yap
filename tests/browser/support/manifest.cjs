const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Static worker fixtures model the manifest endpoint; server contracts verify the real inventory.
function manifest(root, read = (url) => fs.readFileSync(path.join(root, url))) {
    const files = fs
        .readdirSync(root, { recursive: true })
        .filter((name) => fs.statSync(path.join(root, name)).isFile());
    const assets = files
        .map((name) => '/' + name.replaceAll(path.sep, '/'))
        .filter(
            (url) =>
                !/\.(br|gz|md)$/.test(url) &&
                !url.includes('/sample/') &&
                !url.includes('/aardvark-') &&
                !url.endsWith('/aardvark.svg') &&
                !/^\/chat-client\/emoji\/.*\.svg$/.test(url) &&
                (/^\/(chat-client|fonts|themes|images)\//.test(url) ||
                    /^\/(app\.css|themes\.css|notif\.mp3|js\/appearance\.js|service-worker(?:-module)?\.js|icon(?:-192|-512)?\.(?:svg|png)|emoji_selection_(?:greys|color)\.png)$/.test(
                        url,
                    )),
        )
        .sort()
        .map((url) => ({
            url,
            hash: hash(read(url)),
            install:
                (!/^\/(themes|images)\//.test(url) || url.endsWith('.css')) &&
                !url.startsWith('/chat-client/vendor/add-to-homescreen-3.5/assets/img/'),
        }));
    return {
        version: hash(
            assets
                .map((a) => a.url + ':' + a.hash + ':' + (a.install ? 'True' : 'False'))
                .join('\n'),
        ),
        assets,
    };
}
module.exports = { manifest };
