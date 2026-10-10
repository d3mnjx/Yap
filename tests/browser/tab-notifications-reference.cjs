// Observe the frozen original before deciding title/audio parity. Data and cookies stay isolated.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const origin = 'https://localhost:7443',
    suffix = Date.now().toString(36),
    names = ['nta', 'ntb', 'ntc'].map((n) => n + suffix);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
        if (await check()) return;
        await pause(100);
    }
    throw new Error('Reference notification check timed out');
}
(async () => {
    const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
    try {
        const contexts = await Promise.all(
            names.map(() => browser.newContext({ ignoreHTTPSErrors: true })),
        );
        for (const context of contexts)
            await context.addInitScript(() => {
                window.testHidden = false;
                window.audioCalls = [];
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
                        window.audioCalls.push({ volume: this.volume, src: this.src });
                        return Promise.resolve();
                    }
                    return original.call(this);
                };
            });
        const pages = await Promise.all(contexts.map((c) => c.newPage()));
        const [alice, bob, carol] = pages;
        async function ready(page, path) {
            await page.goto(origin + path);
            await page.waitForFunction(
                () => !!document.querySelector('.message-input')?._typingInputHandler,
            );
        }
        async function hidden(value) {
            await alice.evaluate((value) => {
                window.testHidden = value;
                document.dispatchEvent(new Event('visibilitychange'));
            }, value);
            await pause(250);
        }
        async function send(page, text) {
            await page.locator('.message-input').fill(text);
            await page.locator('.send-button').click();
            await page.locator('.message-content').filter({ hasText: text }).first().waitFor();
        }
        const calls = () => alice.evaluate(() => window.audioCalls.length);
        for (let i = 0; i < 3; i++) {
            await pages[i].goto(origin + '/login');
            await pages[i].locator('.username-input').fill(names[i]);
            await pages[i].locator('.join-button').click();
            await pages[i].waitForURL('**/lobby');
        }
        await ready(bob, '/dm/' + names[0]);
        await ready(carol, '/dm/' + names[0]);
        await send(bob, 'seed Bob ' + suffix);
        await send(carol, 'seed Carol ' + suffix);
        await ready(alice, '/dm/' + names[1]);
        const base = await alice.title();
        assert(base.endsWith('| @' + names[1]));
        await hidden(true);
        await send(bob, 'first hidden DM ' + suffix);
        await until(async () => (await calls()) === 1 && (await alice.title()).startsWith('(1) '));
        await send(bob, 'second hidden DM ' + suffix);
        await until(async () => (await calls()) === 2 && (await alice.title()).startsWith('(2) '));
        assert.equal(await alice.evaluate(() => window.audioCalls[0].volume), 0.5);
        await hidden(false);
        await until(async () => (await alice.title()) === base);
        console.log(
            'PASS original hidden DM: (n) Project | @username, notif.mp3 volume 0.5; foreground clears title',
        );
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
        await hidden(true);
        await send(carol, 'unmuted other DM ' + suffix);
        await pause(800);
        assert.equal(await calls(), 0);
        assert(!(await alice.title()).startsWith('('));
        console.log('OBSERVED Q-01: muted open DM suppresses an unmuted other DM in the original');
        await ready(alice, '/dm/' + names[2]);
        await hidden(true);
        await send(bob, 'muted source DM ' + suffix);
        await until(async () => (await calls()) === 1);
        assert((await alice.title()).startsWith('(1) '));
        console.log(
            'OBSERVED Q-01: unmuted open DM lets a muted other DM affect title and audio in the original',
        );
        await ready(alice, '/lobby');
        await hidden(true);
        await send(carol, 'DM while viewing room ' + suffix);
        await until(async () => (await alice.title()).startsWith('(1) '));
        assert.equal(await calls(), 0);
        assert((await alice.title()).endsWith('| #lobby'));
        console.log('PASS original room context: title update without sound for an incoming DM');
        console.log(
            'PASS Chromium ' +
                browser.version() +
                '; visibility and audio-attempt fixtures, not physical speaker verification',
        );
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
