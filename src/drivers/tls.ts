import { readFileSync } from 'fs';
import { isIP } from 'net';
import { homedir } from 'os';
import { checkServerIdentity, ConnectionOptions, PeerCertificate } from 'tls';
import { Endpoint } from './driver';

const expandHome = (path: string) => (path.startsWith('~/') ? homedir() + path.slice(1) : path);

/** Name the server certificate must carry: the configured one, else the host dialled. */
export const serverName = (e: Endpoint) => e.sslServerName || e.host;

/**
 * Node TLS options for `e`: verification on unless the connection opted out, with an
 * optional CA file and the name to check. An IP cannot go in SNI, so it is checked
 * through `checkServerIdentity` instead.
 */
export function tlsOptions(e: Endpoint, read: (path: string) => Buffer = readFileSync): ConnectionOptions | undefined {
  if (!e.ssl) return undefined;
  if (!e.sslVerify) return { rejectUnauthorized: false };
  const options: ConnectionOptions = { rejectUnauthorized: true };
  if (e.sslCaPath) options.ca = read(expandHome(e.sslCaPath));
  const name = serverName(e);
  if (isIP(name)) options.checkServerIdentity = (_host: string, cert: PeerCertificate) => checkServerIdentity(name, cert);
  else options.servername = name;
  return options;
}

/** The same choices in MongoDB driver options (it reads the CA file itself). */
export function mongoTlsOptions(e: Endpoint): Record<string, unknown> {
  if (!e.ssl) return {};
  if (!e.sslVerify) return { tls: true, tlsAllowInvalidCertificates: true };
  const { servername, checkServerIdentity: check } = tlsOptions({ ...e, sslCaPath: undefined })!;
  return { tls: true, ...(e.sslCaPath ? { tlsCAFile: expandHome(e.sslCaPath) } : {}), ...(servername ? { servername } : { checkServerIdentity: check }) };
}

/**
 * mysql2 only checks the name against the host it dials. Any other name (SSH tunnel,
 * IP) comes back in `nameAfterConnect`, to check on the peer certificate once connected.
 */
export function mysqlTlsOptions(e: Endpoint, read?: (path: string) => Buffer): { ssl?: { rejectUnauthorized?: boolean; ca?: Buffer; verifyIdentity: boolean }; nameAfterConnect?: string } {
  const tls = tlsOptions(e, read);
  if (!tls) return {};
  const byDriver = !!e.sslVerify && !isIP(e.host) && serverName(e) === e.host;
  return {
    ssl: { rejectUnauthorized: tls.rejectUnauthorized, ca: tls.ca as Buffer | undefined, verifyIdentity: byDriver },
    nameAfterConnect: e.sslVerify && !byDriver ? serverName(e) : undefined,
  };
}
