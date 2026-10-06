import { connect, createServer, type Server, type Socket } from 'node:net';

export type CommitMode =
  /** Forward everything, including COMMIT, but drop the server's reply to COMMIT and cut the client: committed, acknowledgement lost. */
  | 'drop-reply'
  /** Never deliver COMMIT: cut both sides, the server rolls back. */
  | 'drop-commit'
  /** Cut the client at COMMIT but keep the server session open with the COMMIT undelivered (transaction in progress); deliver it after `holdMs`, or never. */
  | 'hold';

export interface CommitProxy {
  port: number;
  /** Resolves once a COMMIT has been intercepted. */
  intercepted: Promise<void>;
  close(): Promise<void>;
}

const isCommit = (chunk: Buffer): boolean => chunk.length === 12 && chunk[0] === 0x51 && chunk.toString('latin1', 5, 11) === 'COMMIT';

/** A TCP proxy in front of Postgres that misbehaves only at the first COMMIT it sees. */
export async function startCommitProxy(target: { host: string; port: number }, mode: CommitMode, options: { holdMs?: number; redirectAfter?: { host: string; port: number } } = {}): Promise<CommitProxy> {
  const sockets = new Set<Socket>();
  let fired = false;
  let signal: () => void = () => undefined;
  const intercepted = new Promise<void>((resolve) => (signal = resolve));
  const timers = new Set<NodeJS.Timeout>();
  const server: Server = createServer((client) => {
    const where = fired && options.redirectAfter ? options.redirectAfter : target;
    const upstream = connect(where.port, where.host);
    sockets.add(client).add(upstream);
    let swallowReplies = false;
    for (const socket of [client, upstream]) socket.on('error', () => undefined);
    upstream.on('data', (chunk) => {
      if (!swallowReplies) client.write(chunk);
    });
    upstream.on('close', () => client.destroy());
    client.on('close', () => {
      if (mode !== 'hold' || !fired) upstream.destroy();
    });
    client.on('data', (chunk: Buffer) => {
      if (fired || !isCommit(chunk)) {
        upstream.write(chunk);
        return;
      }
      fired = true;
      signal();
      if (mode === 'drop-reply') {
        swallowReplies = true;
        upstream.write(chunk);
        timers.add(setTimeout(() => client.destroy(), 50));
      } else if (mode === 'drop-commit') {
        client.destroy();
        upstream.destroy();
      } else {
        client.destroy();
        if (options.holdMs !== undefined) timers.add(setTimeout(() => upstream.write(chunk), options.holdMs));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    intercepted,
    close: () =>
      new Promise<void>((resolve) => {
        for (const timer of timers) clearTimeout(timer);
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
