// A shared, full-duplex application-byte link. HTTP and upgraded WebSockets pass through
// the same queues. Delay is propagation (once per chunk), rate is shared across sockets.
// HTTPS passes opaque TLS records through the same queues, including its handshake.
// TCP handshakes, congestion control, loss and radio variability are not emulated.
const net = require('node:net');
const { performance } = require('node:perf_hooks');
async function shapedProxy(port, backendPort, tlsOrigin = false) {
    let profile = { rtt: 0, down: Infinity, up: Infinity };
    let end = { up: 0, down: 0 },
        bytes = { up: 0, down: 0 };
    const sockets = new Set(),
        timers = new Set();
    function relay(source, destination, direction) {
        let pending = 0,
            timer = null;
        const queue = [];
        function schedule() {
            if (timer || !queue.length) return;
            // One FIFO timer per stream is essential. Independent fractional timers can
            // fire out of order and corrupt an otherwise reliable TCP/WebSocket stream.
            timer = setTimeout(flush, Math.max(0, Math.ceil(queue[0].due - performance.now())));
            timers.add(timer);
        }
        function flush() {
            timers.delete(timer);
            timer = null;
            while (queue.length && queue[0].due <= performance.now()) {
                const { data } = queue.shift();
                if (data === null) {
                    destination.end();
                    continue;
                }
                pending -= data.length;
                if (!destination.destroyed) {
                    bytes[direction] += data.length;
                    destination.write(data);
                }
                if (pending < 512 * 1024 && !source.destroyed) source.resume();
            }
            schedule();
        }
        source.on('data', (data) => {
            pending += data.length;
            if (pending > 1024 * 1024) source.pause();
            end[direction] =
                Math.max(performance.now() + profile.rtt / 2, end[direction]) +
                (data.length / profile[direction]) * 1000;
            queue.push({ data, due: end[direction] });
            schedule();
        });
        source.on('end', () => {
            queue.push({ data: null, due: end[direction] + 1 });
            schedule();
        });
    }
    const server = net.createServer({ allowHalfOpen: true }, (client) => {
        const backend = net.connect({ host: '127.0.0.1', port: backendPort, allowHalfOpen: true });
        for (const socket of [client, backend]) {
            sockets.add(socket);
            socket.setNoDelay(true);
            socket.on('close', () => sockets.delete(socket));
            socket.on('error', () => {
                client.destroy();
                backend.destroy();
            });
        }
        relay(client, backend, 'up');
        relay(backend, client, 'down');
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
    });
    return {
        origin: `${tlsOrigin ? 'https' : 'http'}://127.0.0.1:${port}`,
        configure(value) {
            profile = value;
            end = { up: 0, down: 0 };
        },
        totals() {
            return { ...bytes };
        },
        async close() {
            for (const t of timers) clearTimeout(t);
            for (const s of sockets) s.destroy();
            await new Promise((resolve) => server.close(resolve));
        },
    };
}
module.exports = { shapedProxy };
