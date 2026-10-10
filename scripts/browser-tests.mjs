import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
const standardSuites = [
    'sync-protocol',
    'communication',
    'review-recovery',
    'review-composer',
    'text-sending',
    'history-interface',
    'rich-content',
    'message-actions',
    'pwa-integration',
    'local-http',
];
// Special deployment/reference/fixture suites have their own prerequisites in tests/browser/README.md.
const allowed = new Set([
    ...standardSuites,
    'composer-parity',
    'emoji-parity',
    'emoji-loading',
    'emoji-cache',
    'appearance',
    'gif-parity',
    'action-parity',
    'gallery-parity',
    'media-playback',
    'reported-regressions',
    'interface-integration',
    'account-integration',
    'presence-unread',
    'tab-notifications',
    'queued-scroll',
    'review-worker-upgrade',
    'upgrade-rollout',
]);
const selected = process.argv.slice(2);
const suites = selected.length ? selected : standardSuites;
const origin = new URL(process.env.YAP_TEST_ORIGIN || 'http://127.0.0.1:7643');
if (!['127.0.0.1', 'localhost'].includes(origin.hostname) || origin.port === '7543')
    throw new Error(
        'Use a disposable localhost fixture; development port 7543 is not a test target.',
    );
for (const suite of suites)
    if (!allowed.has(suite))
        throw new Error(`Unknown suite: ${suite}. See tests/browser/README.md.`);
const artifacts =
    process.env.YAP_TEST_ARTIFACTS || (await mkdtemp(path.join(tmpdir(), 'yap-browser-')));
console.log(`Browser checks: ${origin.origin}; artifacts: ${artifacts}`);
for (const suite of suites) {
    console.log(`Running ${suite}`);
    await mkdir(path.join(artifacts, suite), { recursive: true });
    // Serial execution keeps fixture mutations and their failures attributable to one suite.
    const code = await new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            [path.join(repository, 'tests/browser', suite + '.cjs')],
            {
                cwd: repository,
                env: {
                    ...process.env,
                    YAP_TEST_ORIGIN: origin.origin,
                    YAP_TEST_ARTIFACTS: path.join(artifacts, suite),
                },
                stdio: 'inherit',
            },
        );
        child.on('error', reject);
        child.on('exit', (code, signal) => resolve(signal ? 1 : code));
    });
    if (code !== 0) {
        process.exitCode = code || 1;
        break;
    }
}
