const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'),
    fs = require('node:fs'),
    { spawn } = require('node:child_process'),
    { once } = require('node:events');
const origin = process.env.YAP_TEST_ORIGIN || 'http://127.0.0.1:7643';
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname))
    throw new Error('Isolated local origin required');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
    const end = Date.now() + 30000;
    while (Date.now() < end) {
        if (await check()) return;
        await pause(100);
    }
    throw new Error('Notification acceptance timed out');
}
const launcher = process.env.YAP_TEST_LAUNCHER;
let server;
function launch() {
    const fd = fs.openSync('/tmp/yap-phase4-test-server.log', 'a');
    server = spawn(launcher, [], { detached: true, stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    server.unref();
}
(async () => {
    const browser = await chromium.launch();
    const pages = [];
    try {
        const names = ['nfa', 'nfb', 'nfc'].map((n) => n + Date.now().toString(36));
        const contexts = await Promise.all(
            names.map(() => browser.newContext({ viewport: { width: 1440, height: 1000 } })),
        );
        if (launcher) {
            if (await contexts[0].request.get(origin + '/lobby').catch(() => null))
                throw new Error(
                    'Stop only the isolated test instance before running the launcher check',
                );
            launch();
            await until(() =>
                contexts[0].request
                    .get(origin + '/lobby')
                    .then((r) => r.ok())
                    .catch(() => false),
            );
        }
        for (const context of contexts)
            await context.addInitScript(() => {
                window.testHidden = sessionStorage.getItem('notification-test-hidden') === 'true';
                window.audioCalls = [];
                window.rejectAudio = false;
                Object.defineProperty(document, 'hidden', {
                    configurable: true,
                    get: () => window.testHidden,
                });
                Object.defineProperty(document, 'visibilityState', {
                    configurable: true,
                    get: () => (window.testHidden ? 'hidden' : 'visible'),
                });
                const original = HTMLMediaElement.prototype.play;
                HTMLMediaElement.prototype.play = function () {
                    if (
                        this instanceof HTMLAudioElement &&
                        new URL(this.src, location.href).pathname === '/notif.mp3'
                    ) {
                        window.audioCalls.push({
                            src: this.src,
                            volume: this.volume,
                            rejected: window.rejectAudio,
                        });
                        return window.rejectAudio
                            ? Promise.reject(
                                  new DOMException('Autoplay fixture', 'NotAllowedError'),
                              )
                            : Promise.resolve();
                    }
                    return original.call(this);
                };
            });
        pages.push(...(await Promise.all(contexts.map((c) => c.newPage()))));
        const [alice, bob, carol] = pages;
        const errors = [];
        for (const page of pages) page.on('pageerror', (e) => errors.push(e.message));
        async function ready(page, path) {
            await page.goto(origin + path);
            await page.waitForFunction(
                () =>
                    document.querySelector('#connection')?.textContent.startsWith('Synced') &&
                    !document.querySelector('[data-status="online"]').disabled,
            );
            await pause(300);
        }
        async function hidden(page, value) {
            await page.evaluate((value) => {
                window.testHidden = value;
                sessionStorage.setItem('notification-test-hidden', String(value));
                document.dispatchEvent(new Event('visibilitychange'));
            }, value);
            await pause(150);
        }
        async function send(page, label) {
            const text = label + ' ' + Date.now();
            await page.locator('#draft').fill(text);
            await page.locator('#send').click();
            await until(() =>
                page
                    .locator('#timeline .message-text')
                    .filter({ hasText: text })
                    .count()
                    .then((n) => n === 1),
            );
            return text;
        }
        const calls = (page) => page.evaluate(() => window.audioCalls.length);
        const count = (page) => page.title().then((t) => Number(/^\((\d+)\) /.exec(t)?.[1] || 0));
        for (let i = 0; i < 3; i++) {
            await pages[i].goto(origin + '/login');
            await pages[i].locator('.username-input').fill(names[i]);
            await pages[i].locator('.join-button').click();
            await pages[i].waitForURL('**/lobby');
            await pages[i].waitForFunction(
                () => !document.querySelector('[data-status="online"]').disabled,
            );
        }
        await ready(bob, '/dm/' + names[0]);
        await ready(carol, '/dm/' + names[0]);
        await send(bob, 'seed Bob');
        await send(carol, 'seed Carol');
        await ready(alice, '/dm/' + names[1]);
        assert.equal(
            await alice.evaluate(
                () =>
                    new Promise((resolve, reject) => {
                        const sound = new Audio('/notif.mp3');
                        sound.oncanplay = () => resolve(sound.duration > 0);
                        sound.onerror = () =>
                            reject(new Error('Notification audio did not decode'));
                        sound.load();
                    }),
            ),
            true,
        );
        const base = await alice.title();
        assert(base.endsWith('| @' + names[1]));
        await hidden(alice, true);
        await send(bob, 'hidden first');
        await until(async () => (await count(alice)) === 1 && (await calls(alice)) === 1);
        await send(bob, 'hidden second');
        await until(async () => (await count(alice)) === 2 && (await calls(alice)) === 2);
        assert.equal(await alice.evaluate(() => window.audioCalls[0].volume), 0.5);
        await hidden(alice, false);
        await until(async () => (await alice.title()) === base);
        const visibleCalls = await calls(alice);
        await send(bob, 'visible quiet');
        await pause(500);
        assert.equal(await count(alice), 0);
        assert.equal(await calls(alice), visibleCalls);
        console.log(
            'PASS original title format, hidden counts/audio at volume 0.5, foreground reset and visible silence',
        );

        // Two recipient tabs share a single audible claim but keep independent title counters.
        const sibling = await contexts[0].newPage();
        pages.push(sibling);
        sibling.on('pageerror', (e) => errors.push(e.message));
        await ready(sibling, '/dm/' + names[1]);
        await hidden(alice, true);
        await hidden(sibling, true);
        const before = (await calls(alice)) + (await calls(sibling));
        await send(bob, 'one sound across tabs');
        await until(
            async () =>
                (await count(alice)) === 1 &&
                (await count(sibling)) === 1 &&
                (await calls(alice)) + (await calls(sibling)) === before + 1,
        );
        await pause(600);
        assert.equal((await calls(alice)) + (await calls(sibling)), before + 1);
        // A read on another tab and presence/typing updates must not count as new arrivals.
        await hidden(sibling, false);
        await bob.locator('#draft').fill('typing should not ring');
        await pause(800);
        assert.equal(await count(alice), 1);
        assert.equal((await calls(alice)) + (await calls(sibling)), before + 1);
        await sibling.close();
        await hidden(alice, false);
        await send(alice, 'own send quiet');
        await hidden(alice, true);
        const beforeReplay = await calls(alice);
        await pause(500);
        assert.equal(await count(alice), 0);
        assert.equal(await calls(alice), beforeReplay);
        console.log(
            'PASS one sound across tabs; own sends, read acknowledgements and transient updates stay quiet',
        );

        await alice.evaluate(() => navigator.serviceWorker.ready);
        await contexts[0].setOffline(true);
        await send(bob, 'missed while disconnected');
        await contexts[0].setOffline(false);
        await until(async () => (await count(alice)) === 1);
        await pause(700);
        assert.equal(await calls(alice), beforeReplay);
        await send(bob, 'fresh after reconnect');
        await until(
            async () => (await count(alice)) === 2 && (await calls(alice)) === beforeReplay + 1,
        );
        // Cold hidden reload is a quiet baseline, including existing unread and shared claims.
        await alice.reload();
        await alice.waitForFunction(() =>
            document.querySelector('#connection')?.textContent.startsWith('Synced'),
        );
        await pause(600);
        assert.equal(await count(alice), 0);
        assert.equal(await calls(alice), 0);
        console.log(
            'PASS reconnect catches up title without old sounds; fresh arrival rings; hidden reload has no replay',
        );

        await hidden(alice, false);
        await alice.goto(origin + '/settings#notification-settings');
        const individual = alice
            .getByRole('radiogroup', { name: 'Direct messages', exact: true })
            .getByRole('radio', { name: 'Individual', exact: true });
        await individual.click();
        const bobSetting = alice.locator('.notif-item').filter({ hasText: names[1] });
        await bobSetting.getByRole('button', { name: 'Mute', exact: true }).click();
        await bobSetting.getByRole('button', { name: 'Unmute', exact: true }).waitFor();
        const rooms = alice
            .getByRole('radiogroup', { name: 'Rooms', exact: true })
            .getByRole('radio', { name: 'Allow all', exact: true });
        await rooms.click();
        await until(() => rooms.evaluate((el) => el.classList.contains('seg-selected')));
        await ready(alice, '/dm/' + names[1]);
        await hidden(alice, true);
        await send(carol, 'unmuted source through muted open DM');
        await until(async () => (await count(alice)) === 1 && (await calls(alice)) === 1);
        await hidden(alice, false);
        await ready(alice, '/dm/' + names[2]);
        await hidden(alice, true);
        await send(bob, 'muted source while unmuted DM open');
        await pause(700);
        assert.equal(await count(alice), 0);
        assert.equal(await calls(alice), 0);
        await send(carol, 'unmuted source visible title');
        await until(async () => (await count(alice)) === 1 && (await calls(alice)) === 1);
        console.log(
            'PASS Q-01 correction: incoming conversation mute controls title/sound independently of the open conversation',
        );

        await hidden(alice, false);
        await ready(alice, '/lobby');
        await hidden(alice, true);
        await send(carol, 'DM while viewing room');
        await until(async () => (await count(alice)) === 1);
        assert.equal(await calls(alice), 0);
        assert((await alice.title()).endsWith('| #lobby'));
        await ready(bob, '/lobby');
        await send(bob, 'unmuted room arrival');
        await until(async () => (await count(alice)) === 2);
        assert.equal(await calls(alice), 0);
        await hidden(alice, false);
        await ready(alice, '/dm/' + names[2]);
        await hidden(alice, true);
        await send(bob, 'room while viewing DM');
        await pause(700);
        assert.equal(await count(alice), 0);
        assert.equal(await calls(alice), 0);
        console.log(
            'PASS original routing: room pages update silently; DM pages do not ring/count room arrivals',
        );

        // Server-wide mute, then unmute: never replay the messages suppressed by the setting.
        await hidden(alice, false);
        await alice.goto(origin + '/settings#notification-settings');
        const muteAll = alice
            .getByRole('radiogroup', { name: 'Server notifications', exact: true })
            .getByRole('radio', { name: 'Mute', exact: true });
        await muteAll.click();
        await until(() => muteAll.evaluate((el) => el.classList.contains('seg-selected')));
        await ready(alice, '/dm/' + names[2]);
        await hidden(alice, true);
        await send(carol, 'server muted arrival');
        await pause(700);
        assert.equal(await count(alice), 0);
        assert.equal(await calls(alice), 0);
        await hidden(alice, false);
        await alice.goto(origin + '/settings#notification-settings');
        const allowAll = alice
            .getByRole('radiogroup', { name: 'Server notifications', exact: true })
            .getByRole('radio', { name: 'Allow', exact: true });
        await allowAll.click();
        await until(() => allowAll.evaluate((el) => el.classList.contains('seg-selected')));
        await ready(alice, '/dm/' + names[2]);
        await hidden(alice, true);
        await pause(600);
        assert.equal(await count(alice), 0);
        assert.equal(await calls(alice), 0);
        await alice.evaluate(() => (window.rejectAudio = true));
        await send(carol, 'autoplay rejected');
        await until(async () => (await count(alice)) === 1 && (await calls(alice)) === 1);
        await alice.evaluate(() => {
            window.rejectAudio = false;
            document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await pause(500);
        assert.equal(await calls(alice), 1);
        await send(carol, 'next allowed sound');
        await until(async () => (await count(alice)) === 2 && (await calls(alice)) === 2);
        console.log(
            'PASS server mute/unmute does not replay; autoplay rejection leaves chat working and is never retried later',
        );

        if (launcher) {
            const beforeRestart = await calls(alice),
                titleBefore = await alice.title();
            const exited = once(server, 'exit');
            server.kill('SIGTERM');
            await exited;
            server = null;
            await alice.waitForFunction(
                () => !document.querySelector('#connection').textContent.startsWith('Synced'),
            );
            launch();
            await until(() =>
                contexts[1].request
                    .get(origin + '/lobby')
                    .then((r) => r.ok())
                    .catch(() => false),
            );
            await alice.waitForFunction(() =>
                document.querySelector('#connection').textContent.startsWith('Synced'),
            );
            await carol.waitForFunction(() =>
                document.querySelector('#connection').textContent.startsWith('Synced'),
            );
            await pause(800);
            assert.equal(await calls(alice), beforeRestart);
            assert.equal(await alice.title(), titleBefore);
            await send(carol, 'fresh after actual restart');
            await until(async () => (await calls(alice)) === beforeRestart + 1);
            console.log(
                'PASS actual server restart preserves title, does not replay sound, and fresh live arrivals notify',
            );
        }
        await hidden(alice, false);
        const previousIdentity = await alice.evaluate(async () => {
            const state = await (await import('/chat-client/storage.js')).readState();
            return { userId: state.userId, epoch: state.epoch };
        });
        const bobId = (await (await contexts[1].request.get(origin + '/api/chat/session')).json())
            .userId;
        await contexts[0].addCookies(await contexts[1].cookies());
        await ready(alice, '/lobby');
        const switched = await alice.evaluate(async () =>
            (await import('/chat-client/storage.js')).readState(),
        );
        assert.equal(
            await alice.evaluate(async (previous) => {
                const store = await import('/chat-client/storage.js');
                try {
                    await store.claimNotificationAudio(
                        (await store.readState()).snapshot.serverEpoch,
                        [],
                        previous,
                    );
                    return false;
                } catch (error) {
                    return error.message === 'ACCOUNT_CHANGED';
                }
            }, previousIdentity),
            true,
        );
        assert.equal(switched.userId, bobId);
        assert.equal(switched.notificationAudio, undefined);
        assert.equal(await count(alice), 0);
        assert.equal(await calls(alice), 0);
        console.log(
            'PASS switching accounts purges private audio claims and does not replay the new account history',
        );
        await alice.locator('#menu-button').click();
        await alice.locator('#forget').click();
        await until(async () => (await alice.title()) === 'Yap | Chat');
        assert.equal(
            await alice.evaluate(async () => (await import('/chat-client/storage.js')).readState()),
            undefined,
        );
        assert.deepEqual(errors, []);
        console.log('PASS Forget clears title and account sound claims; no browser page errors');
        console.log(
            'PASS Chromium ' +
                browser.version() +
                '; audio attempts/visibility instrumented, physical playback and OS suspension not claimed',
        );
        if (server) console.log('Isolated test server left running; PID ' + server.pid);
    } catch (error) {
        for (let i = 0; i < pages.length; i++)
            console.log('Page', i, await pages[i].title().catch(() => '(closed)'));
        server?.kill('SIGTERM');
        throw error;
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
