import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { createServer, Server, Socket } from 'net';
import { homedir } from 'os';
import { join } from 'path';
import { Client, ConnectConfig } from 'ssh2';
import { ConnectionSecrets, SshConfig } from './types';

/** Decides whether an unknown or changed host key may be trusted. */
export type HostKeyCheck = (fingerprint: string, expected: string | undefined) => Promise<boolean>;

const DEFAULT_KEYS = ['id_ed25519', 'id_ecdsa', 'id_rsa'];

/**
 * Local TCP listener on 127.0.0.1 whose connections are forwarded through an SSH
 * session to `dstHost:dstPort` (as seen from the SSH server).
 */
export class SshTunnel {
  private closed = false;
  onClose?: () => void;

  private constructor(
    private readonly ssh: Client,
    private readonly server: Server,
    readonly localPort: number,
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

    const server = createServer((sock: Socket) => {
      ssh.forwardOut('127.0.0.1', sock.remotePort ?? 0, dstHost, dstPort, (err, stream) => {
        if (err) {
          sock.destroy(err);
          return;
        }
        sock.on('error', () => stream.destroy());
        stream.on('error', () => sock.destroy());
        sock.pipe(stream).pipe(sock);
      });
    });
    const localPort = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });

    const tunnel = new SshTunnel(ssh, server, localPort, fingerprint);
    ssh.on('close', () => tunnel.shutdown());
    ssh.on('error', () => tunnel.shutdown());
    return tunnel;
  }

  close(): void {
    this.shutdown();
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    this.server.close();
    this.ssh.end();
    this.onClose?.();
  }
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
