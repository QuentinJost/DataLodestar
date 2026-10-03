import { readFileSync } from 'fs';
import { connect as netConnect, isIP, Socket } from 'net';
import { homedir } from 'os';
import { checkServerIdentity, ConnectionOptions, PeerCertificate } from 'tls';
import { Endpoint } from './driver';

const expandHome = (path: string) => (path.startsWith('~/') ? homedir() + path.slice(1) : path);

/** Name the server certificate must carry: the configured one, else the host dialled. */
export const serverName = (e: Endpoint) => e.sslServerName || e.host;

/**
 * Node TLS options for `e`: verification on unless the connection opted out, with an
 * optional CA file and the name to check. The name is checked by `checkServerIdentity`
 * whatever host the driver dials; it also goes in SNI, unless it is an IP.
 */
export function tlsOptions(e: Endpoint, read: (path: string) => Buffer = readFileSync): ConnectionOptions | undefined {
  if (!e.ssl) return undefined;
  if (!e.sslVerify) return { rejectUnauthorized: false };
  const options: ConnectionOptions = { rejectUnauthorized: true };
  if (e.sslCaPath) options.ca = read(expandHome(e.sslCaPath));
  const name = serverName(e);
  // pg replaces `servername` with the host it dials, which Node would then check.
  options.checkServerIdentity = (_host: string, cert: PeerCertificate) => checkServerIdentity(name, cert);
  if (!isIP(name)) options.servername = name;
  return options;
}

/** The same choices in MongoDB driver options (it reads the CA file itself). */
export function mongoTlsOptions(e: Endpoint): Record<string, unknown> {
  if (!e.ssl) return {};
  if (!e.sslVerify) return { tls: true, tlsAllowInvalidCertificates: true };
  const { servername, checkServerIdentity: check } = tlsOptions({ ...e, sslCaPath: undefined })!;
  return { tls: true, ...(e.sslCaPath ? { tlsCAFile: expandHome(e.sslCaPath) } : {}), ...(servername ? { servername } : { checkServerIdentity: check }) };
}

/** The socket mysql2 opens itself (base/connection.js): no Nagle delay, keep-alive once connected. */
export const dialTcp = (port: number, host: string) => (): Socket => {
  const socket = netConnect(port, host);
  socket.setNoDelay(true);
  socket.once('connect', () => socket.setKeepAlive(true));
  return socket;
};

/**
 * mysql2 checks the certificate against the `host` it is given, during the TLS handshake, so before
 * it authenticates: given the certificate name as `host`, it checks that name, and `dial` opens the
 * socket to the real address (through SSH the tunnel's stream is used instead).
 *
 * An IP address cannot be checked that way (mysql2 sends no server name, and Node then checks
 * "localhost"): it is checked once connected, so only with a CA file, which limits who can receive
 * the password first to holders of a certificate from that CA; without one the connection is refused.
 */
export function mysqlTlsOptions(
  e: Endpoint,
  read?: (path: string) => Buffer,
): { ssl?: { rejectUnauthorized?: boolean; ca?: Buffer; verifyIdentity: boolean }; host: string; dial?: () => Socket; nameAfterConnect?: string } {
  const tls = tlsOptions(e, read);
  if (!tls) return { host: e.host };
  const ssl = { rejectUnauthorized: tls.rejectUnauthorized, ca: tls.ca as Buffer | undefined, verifyIdentity: !!e.sslVerify };
  if (!e.sslVerify) return { ssl, host: e.host };
  const name = serverName(e);
  if (isIP(name)) {
    if (!e.sslCaPath) {
      throw new Error(
        `MySQL cannot check a certificate issued to an IP address (${name}) before sending the password. ` +
          'Set "Certificate name" to a DNS name the certificate carries, or give the CA file that signed it.',
      );
    }
    return { ssl: { ...ssl, verifyIdentity: false }, host: e.host, nameAfterConnect: name };
  }
  if (name === e.host) return { ssl, host: e.host };
  return { ssl, host: name, dial: e.stream ? undefined : dialTcp(e.port, e.host) };
}
