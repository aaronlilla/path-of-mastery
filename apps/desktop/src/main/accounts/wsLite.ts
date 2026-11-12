import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket as NetSocket } from 'node:net';

/**
 * A tiny WebSocket client (RFC 6455, text frames only). Electron 33's main process has no WebSocket and the app
 * adds no package for one thread of messages. Supabase Realtime sends JSON text; that is all this reads or writes.
 */
export interface WsHandlers {
  onOpen(): void;
  onText(text: string): void;
  /** Called once, whether the socket failed to open, was closed by the server, or was closed by us. */
  onClose(): void;
}

export interface Ws {
  send(text: string): void;
  close(): void;
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function connectWs(url: string, h: WsHandlers): Ws {
  const u = new URL(url.replace(/^ws/, 'http')); // http.request does not take ws: urls; the upgrade headers make it a WebSocket
  const key = randomBytes(16).toString('base64');
  const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, {
    headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key },
  });
  let sock: NetSocket | null = null;
  let closed = false;
  const done = () => {
    if (closed) return;
    closed = true;
    sock?.destroy();
    h.onClose();
  };
  const write = (opcode: number, payload: Buffer) => {
    if (!sock || closed) return;
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | opcode, 0x80 | n]) : n < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), Buffer.alloc(4), Buffer.from([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])]);
    const mask = randomBytes(4);
    const body = Buffer.from(payload);
    for (let i = 0; i < n; i++) body[i]! ^= mask[i & 3]!;
    sock.write(Buffer.concat([head, mask, body]));
  };

  req.on('upgrade', (res, s, head) => {
    if (res.headers['sec-websocket-accept'] !== createHash('sha1').update(key + GUID).digest('base64')) return void s.destroy(), done();
    sock = s;
    let buf = head.length ? Buffer.from(head) : Buffer.alloc(0);
    let message: Buffer[] = [];
    s.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        const opcode = buf[0]! & 15;
        let len = buf[1]! & 127;
        let at = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          at = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          at = 10;
        }
        if (buf.length < at + len) return;
        const payload = buf.subarray(at, at + len);
        const fin = (buf[0]! & 0x80) !== 0;
        buf = buf.subarray(at + len);
        if (opcode === 8) return void done();
        if (opcode === 9) write(10, payload);
        else if (opcode === 1 || opcode === 0) {
          message.push(payload);
          if (fin) {
            const text = Buffer.concat(message).toString('utf8');
            message = [];
            h.onText(text);
          }
        }
      }
    });
    s.on('close', done);
    s.on('error', done);
    h.onOpen();
  });
  req.on('response', (res) => (res.resume(), done())); // the server answered with a normal page: not a WebSocket
  req.on('error', () => done());
  req.end();
  return {
    send: (t) => write(1, Buffer.from(t, 'utf8')),
    close: () => {
      write(8, Buffer.alloc(0));
      done();
    },
  };
}
