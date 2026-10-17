import type { AiStreamTransport } from '../../core/ai';

// Real AiStreamTransport — XMLHttpRequest with incremental text. React Native's fetch
// buffers the whole body, so it cannot stream; RN's XHR, by contrast, emits the body as
// it arrives whenever a progress/readystate listener is attached before send() and the
// response type is text (Android: NetworkingModule's useIncrementalUpdates path).
// `responseText` then grows monotonically, and each new tail is handed to the sink.
// Excluded from the Node build; the parsing it feeds is tested via core/ai/stream.

export const xhrStreamTransport: AiStreamTransport = (req, sink, signal) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let seen = 0;
    let headersSent = false;
    let settled = false;

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
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    };

    xhr.open('POST', req.url);
    xhr.responseType = 'text';
    for (const [name, value] of Object.entries(req.headers)) xhr.setRequestHeader(name, value);

    // Both listeners must exist before send() for RN to deliver incremental data.
    xhr.onreadystatechange = () => {
      sendHeaders();
      if (xhr.readyState === 3) drain();
    };
    xhr.onprogress = () => {
      sendHeaders();
      drain();
    };
    xhr.onload = () => {
      if (settled) return;
      sendHeaders();
      drain();
      settled = true;
      resolve({ status: xhr.status, contentType: contentType(), bodyText: xhr.responseText || '' });
    };
    xhr.onerror = () => fail('Network error while The Owl was replying. Check your connection and ask again.');
    xhr.ontimeout = () => fail('The Owl took too long to reply. Please ask again.');
    xhr.onabort = () => fail('Reply cancelled.');

    const s = signal as { aborted?: boolean; addEventListener?: (t: string, f: () => void) => void } | undefined;
    if (s?.aborted) {
      fail('Reply cancelled.');
      return;
    }
    s?.addEventListener?.('abort', () => xhr.abort());

    xhr.send(req.body);
  });
