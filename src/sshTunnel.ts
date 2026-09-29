import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { createServer, Server, Socket } from 'net';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { Duplex } from 'stream';
import { Client, ClientChannel, ConnectConfig } from 'ssh2';
import { ConnectionSecrets, SshConfig } from './types';

/** Decides whether an unknown or changed host key may be trusted. */
export type HostKeyCheck = (fingerprint: string, expected: string | undefined) => Promise<boolean>;

const DEFAULT_KEYS = ['id_ed25519', 'id_ecdsa', 'id_rsa'];

/** Where a driver that cannot take a stream connects: a Unix socket path (port 0) or 127.0.0.1:port. */
export interface LocalEndpoint {
  host: string;
  port: number;
}

/**
 * An SSH session forwarding to `dstHost:dstPort` (as seen from the SSH server).
 * Drivers that accept a stream get one channel per connection (`connect`), so no
 * port is opened on this machine. `listen` is for the others (MongoDB).
 */
export class SshTunnel {
  private closed = false;
  private server?: Server;
  private socketDir?: string;
  onClose?: () => void;

  private constructor(
    private readonly ssh: Client,
    private readonly dstHost: string,
    private readonly dstPort: number,
    readonly fingerprint: string,
  ) {}

  static async open(
    cfg: SshConfig,
    secrets: ConnectionSecrets,
    dstHost: string,
    dstPort: number,
    checkHostKey: HostKeyCheck,
  ): Promise<SshTunnel> {
    const ssh = new Client();
    let fingerprint = '';

    const options: ConnectConfig = {
      host: cfg.host,
      port: cfg.port || 22,
      username: cfg.username,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
        fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
        if (fingerprint === cfg.hostFingerprint) return verify(true);
        checkHostKey(fingerprint, cfg.hostFingerprint).then(verify, () => verify(false));
      },
    };
    if (cfg.auth === 'password') {
      options.password = secrets.sshPassword;
    } else if (cfg.auth === 'agent') {
      options.agent = process.env.SSH_AUTH_SOCK;
      if (!options.agent) throw new Error('SSH agent requested but SSH_AUTH_SOCK is not set.');
    } else {
      options.privateKey = readPrivateKey(cfg.privateKeyPath);
      options.passphrase = secrets.sshPassphrase || undefined;
    }

    await new Promise<void>((resolve, reject) => {
      ssh.once('ready', resolve);
      ssh.once('error', reject);
      ssh.connect(options);
    });

    const tunnel = new SshTunnel(ssh, dstHost, dstPort, fingerprint);
    ssh.on('close', () => tunnel.shutdown());
    ssh.on('error', () => tunnel.shutdown());
    return tunnel;
  }

  private forward(): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('SSH tunnel closed'));
      this.ssh.forwardOut('127.0.0.1', 0, this.dstHost, this.dstPort, (err, channel) => (err ? reject(err) : resolve(channel)));
    });
  }

  /** A new forwarded channel, shaped like a connected net.Socket for the drivers. */
  async connect(): Promise<Duplex> {
    return asSocket(await this.forward());
  }

  /**
   * Local listener for drivers that only dial an address. On Linux and macOS it is a
   * Unix socket in a directory only this user can open; on Windows, 127.0.0.1 TCP,
   * which any local process can reach while the connection is open.
   */
  async listen(): Promise<LocalEndpoint> {
    if (this.server) return this.address();
    const server = createServer((sock: Socket) => {
      this.forward().then(
        (channel) => {
          sock.on('error', () => channel.destroy());
          channel.on('error', () => sock.destroy());
          sock.pipe(channel).pipe(sock);
        },
        (err: Error) => sock.destroy(err),
      );
    });
    this.server = server;
    const path = process.platform === 'win32' ? undefined : join((this.socketDir = mkdtempSync(join(tmpdir(), 'datalodestar-'))), 'mongo.sock');
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      if (path) server.listen(path, resolve);
      else server.listen(0, '127.0.0.1', resolve);
    });
    return this.address();
  }

  private address(): LocalEndpoint {
    const addr = this.server!.address();
    return typeof addr === 'string' ? { host: addr, port: 0 } : { host: '127.0.0.1', port: addr?.port ?? 0 };
  }

  close(): void {
    this.shutdown();
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    this.server?.close();
    if (this.socketDir) rmSync(this.socketDir, { recursive: true, force: true });
    this.ssh.end();
    this.onClose?.();
  }
}

/**
 * pg calls connect() / setNoDelay(), ioredis setNoDelay() / setKeepAlive(), which an
 * SSH channel lacks: they become no-ops, connect() only reports the channel as open.
 */
function asSocket(channel: ClientChannel): Duplex {
  const s = channel as unknown as Duplex & Record<string, unknown>;
  s.connecting = false;
  s.setNoDelay = () => s;
  s.setKeepAlive = () => s;
  s.setTimeout = () => s;
  s.connect = () => {
    process.nextTick(() => s.emit('connect'));
    return s;
  };
  return s;
}

function readPrivateKey(path: string | undefined): Buffer {
  const expand = (p: string) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p);
  if (path) return readFileSync(expand(path));
  for (const name of DEFAULT_KEYS) {
    try {
      return readFileSync(join(homedir(), '.ssh', name));
    } catch {
      // try the next default key
    }
  }
  throw new Error('No private key path given and none of ~/.ssh/id_ed25519, id_ecdsa, id_rsa exists.');
}
