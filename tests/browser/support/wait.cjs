// waitForFunction's browser poll treats a returned Promise as truthy. Await I/O in
// Node instead, so IndexedDB/cache assertions wait for their actual boolean result.
async function poll(page, predicate, argument, options = {}) {
    const deadline = Date.now() + (options.timeout ?? 30000);
    while (true) {
        if (await page.evaluate(predicate, argument)) return;
        if (Date.now() >= deadline)
            throw new Error(
                'Timed out awaiting browser state: ' + predicate.toString().slice(0, 250),
            );
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}
module.exports = { poll };
