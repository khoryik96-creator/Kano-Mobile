import type { AiStreamCompletion, AiStreamTransport } from '../../core/ai';

// Real AiStreamTransport — XMLHttpRequest with incremental text. React Native's fetch
// buffers the whole body, so it cannot stream; RN's XHR, by contrast, emits the body as
// it arrives whenever a progress/readystate listener is attached before send() and the
// response type is text (Android: NetworkingModule's useIncrementalUpdates path).
// `responseText` then grows monotonically, and each new tail is handed to the sink.
// Excluded from the Node build; the parsing it feeds is tested via core/ai/stream.

/**
 * No bytes for this long means the connection died silently (a Wi-Fi → mobile-data
 * hand-off can leave a socket that never errors). RN's networking has no timeouts at all
 * — XHR `timeout` defaults to 0 and the OkHttp client is built with 0 read/connect
 * timeouts — so without this the Owl would show "writing…" forever. It re-arms on every
 * byte, so a slow reply that is still arriving is never cut off. Providers send periodic
 * ping/keep-alive events, which also count.
 */
export const STREAM_IDLE_TIMEOUT_MS = 60_000;
export const STREAM_STALLED_MESSAGE = 'The Owl stopped responding. Please ask again.';

export const xhrStreamTransport: AiStreamTransport = (req, sink, signal) =>
  new Promise<AiStreamCompletion>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let seen = 0;
    let headersSent = false;
    let settled = false;
    let idle: ReturnType<typeof setTimeout> | null = null;

    // Exactly one outcome, whichever comes first: load, error, abort, or the watchdog.
    const finish = (error: Error | null, value?: AiStreamCompletion) => {
      if (settled) return;
      settled = true;
      if (idle) clearTimeout(idle);
      if (error) reject(error);
      else resolve(value as AiStreamCompletion);
    };
    const touch = () => {
      if (settled) return;
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => {
        finish(new Error(STREAM_STALLED_MESSAGE));
        xhr.abort();
      }, STREAM_IDLE_TIMEOUT_MS);
    };

    const contentType = () => xhr.getResponseHeader('content-type') || '';
    const sendHeaders = () => {
      if (headersSent || xhr.readyState < 2) return;
      headersSent = true;
      sink.onHeaders(xhr.status, contentType());
    };
    const drain = () => {
      const body = xhr.responseText || '';
      if (body.length <= seen) return;
      const chunk = body.slice(seen);
      seen = body.length;
      sink.onData(chunk);
    };

    xhr.open('POST', req.url);
    xhr.responseType = 'text';
    for (const [name, value] of Object.entries(req.headers)) xhr.setRequestHeader(name, value);

    // Both listeners must exist before send() for RN to deliver incremental data.
    xhr.onreadystatechange = () => {
      touch();
      sendHeaders();
      if (xhr.readyState === 3) drain();
    };
    xhr.onprogress = () => {
      touch();
      sendHeaders();
      drain();
    };
    xhr.onload = () => {
      if (settled) return;
      sendHeaders();
      drain();
      finish(null, { status: xhr.status, contentType: contentType(), bodyText: xhr.responseText || '' });
    };
    xhr.onerror = () => finish(new Error('Network error while The Owl was replying. Check your connection and ask again.'));
    xhr.ontimeout = () => finish(new Error(STREAM_STALLED_MESSAGE));
    xhr.onabort = () => finish(new Error('Reply stopped.'));

    const s = signal as { aborted?: boolean; addEventListener?: (t: string, f: () => void) => void } | undefined;
    if (s?.aborted) {
      finish(new Error('Reply stopped.'));
      return;
    }
    s?.addEventListener?.('abort', () => xhr.abort());

    touch(); // covers the wait for the first byte, too
    xhr.send(req.body);
  });
