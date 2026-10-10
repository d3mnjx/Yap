import { get } from './api.js';
import * as storage from './storage.js';

const base64 = (value) => btoa(String.fromCharCode(...new TextEncoder().encode(value)));

export async function uploadAttachments(item, owner, changed, signal) {
    if (!item.files?.length) return item;
    const checkCancelled = async () => {
        signal?.throwIfAborted();
        const latest = (await storage.outbox()).find((m) => m.operationId === item.operationId);
        if (!latest || latest.cancelled)
            throw Object.assign(new Error('Upload cancelled'), { code: 'cancelled' });
    };
    const request = (url, options) => {
        // The caller holds the account's sender lock. A stalled tus request must not
        // retain it forever; retry resumes the saved upload instead of starting over.
        const timeout = AbortSignal.timeout(30000);
        return fetch(url, {
            ...options,
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
    };
    const uploads = item.uploads || [];
    for (let index = 0; index < item.files.length; index++) {
        await checkCancelled();
        const file = item.files[index];
        let upload = uploads[index] || {};
        const save = async () => {
            uploads[index] = upload;
            await storage.patchOutgoing(item.operationId, { uploads }, owner);
        };
        const completed = async () => {
            if (!upload.id) return null;
            try {
                return await get('uploads/' + upload.id, { signal });
            } catch (error) {
                if (error.status !== 404) throw error;
                return null;
            }
        };
        let receipt = upload.receipt || (await completed());
        if (!receipt) {
            let offset = 0;
            if (upload.url) {
                const head = await request(upload.url, {
                    method: 'HEAD',
                    headers: {
                        'Tus-Resumable': '1.0.0',
                        'X-Yap-Upload-User': owner.userId,
                    },
                });
                if (head.ok) offset = Number(head.headers.get('Upload-Offset'));
                else if (head.status === 404 || head.status === 410) upload = {};
                else
                    throw Object.assign(new Error('Upload could not resume. Retry is safe.'), {
                        status: head.status,
                    });
            }
            if (!upload.url) {
                const endpoint = new URL(
                    (await storage.metadata('catalog'))?.uploadEndpoint || '/api/tus',
                    location.origin,
                );
                if (endpoint.origin !== location.origin)
                    throw Object.assign(
                        new Error('This upload endpoint is outside the configured chat origin.'),
                        { status: 400 },
                    );
                const created = await request(endpoint.href, {
                    method: 'POST',
                    headers: {
                        'Tus-Resumable': '1.0.0',
                        'X-Yap-Upload-User': owner.userId,
                        'Upload-Length': String(file.size),
                        'Upload-Metadata': `filename ${base64(file.name)},filetype ${base64(file.type)}${item.gifUpload ? ',kind ' + base64('gif') + ',target ' + base64('user') : ''}`,
                    },
                });
                if (!created.ok)
                    throw Object.assign(new Error('Upload could not start.'), {
                        status: created.status,
                    });
                const url = new URL(created.headers.get('Location'), location.origin);
                if (url.origin !== location.origin) throw new Error('Unexpected upload location');
                upload = { url: url.pathname, id: url.pathname.split('/').pop() };
                await save();
            }
            while (offset < file.size) {
                await checkCancelled();
                const end = Math.min(offset + 1024 * 1024, file.size);
                const result = await request(upload.url, {
                    method: 'PATCH',
                    headers: {
                        'Tus-Resumable': '1.0.0',
                        'X-Yap-Upload-User': owner.userId,
                        'Upload-Offset': String(offset),
                        'Content-Type': 'application/offset+octet-stream',
                    },
                    body: file.slice(offset, end),
                });
                if (!result.ok)
                    throw Object.assign(new Error('Upload interrupted. Retry is safe.'), {
                        status: result.status === 409 ? 503 : result.status,
                    });
                offset = Number(result.headers.get('Upload-Offset')) || end;
                const completedHeader = result.headers.get('X-Yap-Upload-Complete');
                if (completedHeader) {
                    try {
                        receipt = JSON.parse(
                            new TextDecoder().decode(
                                Uint8Array.from(atob(completedHeader), (c) => c.charCodeAt(0)),
                            ),
                        );
                    } catch {
                        /* A missing/unsupported header falls back to the durable receipt endpoint. */
                    }
                }
                await storage.patchOutgoing(
                    item.operationId,
                    {
                        progress: Math.round(
                            (100 * (index + offset / file.size)) / item.files.length,
                        ),
                    },
                    owner,
                );
                await changed();
            }
            for (let attempt = 0; attempt < 60 && !receipt; attempt++) {
                await checkCancelled();
                receipt = await completed();
                if (!receipt) await new Promise((resolve) => setTimeout(resolve, 500));
            }
            if (!receipt) throw new Error('Upload processing is not finished. Retrying is safe.');
        }
        upload.receipt = receipt;
        await save();
        if (receipt.type === 'error')
            throw Object.assign(new Error(receipt.error || 'Upload processing failed.'), {
                status: 400,
            });
        await save();
    }
    await checkCancelled();
    const uploadIds = uploads.map((u) => u.id);
    await storage.patchOutgoing(item.operationId, { uploadIds }, owner);
    return { ...item, uploadIds };
}
