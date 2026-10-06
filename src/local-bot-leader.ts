import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:net';

/** A stable loopback port for a bot. The operating system releases it on exit. */
export function portForBot(appId: string): number {
  const hash = createHash('sha256').update(appId).digest();
  return 30000 + (hash.readUInt32BE(0) % 20000);
}

export class LocalBotLeader {
  private server: Server | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private waitingLogged = false;

  constructor(
    private readonly port: number,
    private readonly retryMs: number,
    private readonly onLeader: () => void | Promise<void>,
    private readonly log: (message: string) => void = () => {},
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    this.waitingLogged = false;
    await this.tryAcquire();
  }

  private async tryAcquire(): Promise<void> {
    if (this.stopped || this.server) return;
    const server = createServer((socket) => socket.destroy());
    const outcome = await new Promise<'leader' | 'busy'>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeAllListeners('listening');
        if (err.code === 'EADDRINUSE') resolve('busy');
        else reject(err);
      };
      server.once('error', onError);
      server.once('listening', () => {
        server.removeListener('error', onError);
        resolve('leader');
      });
      server.listen({ host: '127.0.0.1', port: this.port, exclusive: true });
    });
    if (this.stopped) {
      server.close();
      return;
    }
    if (outcome === 'busy') {
      if (!this.waitingLogged) {
        this.log(`bot port ${this.port} is occupied; waiting ${this.retryMs}ms`);
        this.waitingLogged = true;
      }
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.tryAcquire().catch((err) => {
          this.log(`leader election failed: ${(err as Error).message}`);
          process.exit(1);
        });
      }, this.retryMs);
      this.retryTimer.unref();
      return;
    }
    this.server = server;
    this.waitingLogged = false;
    server.on('error', (err) => {
      this.log(`leader port error: ${err.message}`);
      process.exit(1);
    });
    this.log(`acquired bot port ${this.port}`);
    await this.onLeader();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const server = this.server;
    this.server = null;
    if (server?.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}
