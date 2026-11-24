import { RelayError, requireValue } from './protocol.mjs';
import { MAX_ATTACHMENT_BYTES } from './task-attachments.mjs';

const invalidResponse = () => new RelayError('invalid_backend_response', 'Invalid attachment response', 502);

// WHATWG URLs collapse even percent-encoded dot segments. For the two exact
// dot keys, use a raw semicolon marker (a literal semicolon encodes as %3B).
const dotKey = /^\.{1,2}$/;
export function attachmentReceiptPath(key) {
  return `/v1/task-attachment-receipts/${dotKey.test(key) ? `${key};` : encodeURIComponent(key)}`;
}

export function decodeAttachmentReceiptKey(segment) {
  return /^\.{1,2};$/.test(segment) ? segment.slice(0, -1) : decodeURIComponent(segment);
}

async function readJson(res) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of res) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw invalidResponse();
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {}
  throw invalidResponse();
}

// Leave the response side alive when an upload is refused before the source
// ends. pipeline(source, req) would tear down both halves and lose the receipt.
export function attachmentRequest(request, options, { readable, signal, timeoutMs, waitForContinue = false }) {
  return new Promise((resolve, reject) => {
    let req, res, stopped = false;
    const stopSource = () => {
      if (!readable || stopped) return;
      stopped = true;
      readable.unpipe(req);
      if (!readable.readableEnded) readable.destroy();
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const fail = error => {
      stopSource();
      res?.destroy(error);
      req?.destroy(error);
      cleanup();
      reject(error);
    };
    const abort = () => fail(new RelayError('request_aborted', 'Attachment request aborted', 499));
    const timer = setTimeout(() => fail(new RelayError('request_timeout', 'Attachment request timed out', 504)), timeoutMs);
    timer.unref();
    const transportError = error => error instanceof RelayError ? error : new RelayError('attachment_transport_error', 'Attachment transfer failed', 502);
    try {
      if (readable) readable.once('error', error => { if (!stopped) fail(transportError(error)); });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      req = request({ ...options, signal }, async response => {
        res = response;
        // A caller may await metadata before consuming this response stream.
        res.on('error', () => {});
        res.once('close', cleanup);
        stopSource();
        try {
          if (res.statusCode >= 300 && res.statusCode < 400) throw new RelayError('access_authentication_required', 'Attachment request was redirected', 401);
          if (res.statusCode !== 200) {
            const data = await readJson(res);
            throw new RelayError(data.code ?? 'backend_error', data.message ?? 'Attachment request failed', res.statusCode);
          }
          if (readable) {
            const result = await readJson(res);
            // Do not pool a socket with an unfinished request body.
            if (!req.writableFinished) req.destroy();
            resolve(result);
          } else {
            const sha256 = res.headers['x-content-sha256'], length = res.headers['content-length'];
            requireValue(typeof sha256 === 'string' && sha256.length === 64 && /^[0-9a-f]{64}$/.test(sha256) &&
              typeof length === 'string' && /^\d+$/.test(length) && Number(length) <= MAX_ATTACHMENT_BYTES,
            'invalid_backend_response', 'Invalid attachment digest or length header', 502);
            resolve({ stream: res, sha256, size: Number(length) });
          }
        } catch (error) { fail(transportError(error)); }
      });
      req.on('error', error => { if (!res?.complete) fail(transportError(error)); });
      if (readable) {
        if (waitForContinue) req.once('continue', () => { if (!stopped) readable.pipe(req); });
        req.flushHeaders();
        if (!waitForContinue) readable.pipe(req);
      } else req.end();
    } catch (error) { fail(transportError(error)); }
  });
}
