import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ConnectionOptions, PeerCertificate } from 'tls';
import { Endpoint } from '../drivers/driver';
import { mongoTlsOptions, mysqlTlsOptions, tlsOptions } from '../drivers/tls';

const base: Endpoint = { host: 'db.example.net', port: 5432, user: 'u', ssl: true, sslVerify: true };
const pem = Buffer.from('-----BEGIN CERTIFICATE-----');
const read = (path: string) => {
  assert.equal(path, '/etc/ca.pem');
  return pem;
};
const certFor = (name: string) => ({ subject: { CN: name }, subjectaltname: `DNS:${name}` }) as unknown as PeerCertificate;
/** The options minus the name check, a closure tested on its own. */
const withoutCheck = (o: ConnectionOptions | undefined) => {
  const { checkServerIdentity, ...rest } = o!;
  assert.equal(typeof checkServerIdentity, 'function', 'the name is always checked');
  return rest;
};

test('no SSL: no TLS options for any driver', () => {
  const e = { ...base, ssl: false };
  assert.equal(tlsOptions(e), undefined);
  assert.deepEqual(mysqlTlsOptions(e), { host: 'db.example.net' });
  assert.deepEqual(mongoTlsOptions(e), {});
});

test('verification off keeps the old unchecked behaviour', () => {
  const e = { ...base, sslVerify: false };
  assert.deepEqual(tlsOptions(e), { rejectUnauthorized: false });
  assert.deepEqual(mysqlTlsOptions(e), { ssl: { rejectUnauthorized: false, ca: undefined, verifyIdentity: false }, host: 'db.example.net' });
  assert.deepEqual(mongoTlsOptions(e), { tls: true, tlsAllowInvalidCertificates: true });
  assert.deepEqual(tlsOptions({ ...base, sslVerify: undefined }), { rejectUnauthorized: false }, 'undefined = saved before the setting existed');
});

test('pg / redis: verification on checks the chain and the host name, with an optional CA', () => {
  assert.deepEqual(withoutCheck(tlsOptions(base)), { rejectUnauthorized: true, servername: 'db.example.net' });
  assert.deepEqual(withoutCheck(tlsOptions({ ...base, sslCaPath: '/etc/ca.pem' }, read)), { rejectUnauthorized: true, ca: pem, servername: 'db.example.net' });
});

test('pg: the certificate name is checked, not the host the driver dials', () => {
  // pg sets `servername` to the host it dials: through SSH, often localhost.
  const o = tlsOptions({ ...base, host: 'localhost', sslServerName: 'db.internal' })!;
  assert.equal(o.servername, 'db.internal', 'SNI');
  assert.equal(o.checkServerIdentity!('localhost', certFor('db.internal')), undefined);
  assert.ok(o.checkServerIdentity!('localhost', certFor('localhost')) instanceof Error, 'a certificate for the dialled host only is refused');
});

test('through a tunnel the name comes from the config, not 127.0.0.1', () => {
  const tunnelled = { ...base, host: '127.0.0.1', sslServerName: 'db.internal' };
  assert.equal(tlsOptions(tunnelled)!.servername, 'db.internal');
  const stream = async () => null as never;
  const my = mysqlTlsOptions({ ...tunnelled, stream });
  assert.equal(my.host, 'db.internal', 'mysql2 checks the name it is given as host, during the handshake');
  assert.equal(my.ssl!.verifyIdentity, true);
  assert.equal(my.dial, undefined, 'the tunnel is the stream');
  assert.equal(my.nameAfterConnect, undefined);
  assert.equal(mongoTlsOptions(tunnelled).servername, 'db.internal');
});

test('an IP name is checked by checkServerIdentity, never sent as SNI', () => {
  const o = tlsOptions({ ...base, host: '10.0.0.5' })!;
  assert.equal(o.servername, undefined);
  const cert = { subject: { CN: 'other' }, subjectaltname: 'IP Address:10.0.0.5' } as unknown as PeerCertificate;
  assert.equal(o.checkServerIdentity!('ignored', cert), undefined);
  const wrong = { subject: { CN: 'other' }, subjectaltname: 'IP Address:10.0.0.6' } as unknown as PeerCertificate;
  assert.ok(o.checkServerIdentity!('ignored', wrong) instanceof Error);
  assert.equal(typeof mongoTlsOptions({ ...base, host: '10.0.0.5' }).checkServerIdentity, 'function');
});

test('mysql: the name is checked during the handshake, before the password is sent', () => {
  assert.deepEqual(mysqlTlsOptions({ ...base, sslCaPath: '/etc/ca.pem' }, read), { ssl: { rejectUnauthorized: true, ca: pem, verifyIdentity: true }, host: 'db.example.net' });
  // Dialled by IP, certificate named db.internal: mysql2 gets the name, the socket goes to the IP.
  const byName = mysqlTlsOptions({ ...base, host: '10.0.4.12', sslServerName: 'db.internal' });
  assert.equal(byName.host, 'db.internal');
  assert.equal(byName.ssl!.verifyIdentity, true);
  assert.equal(typeof byName.dial, 'function');
  assert.equal(byName.nameAfterConnect, undefined);
});

test('mysql: an IP certificate name is refused without a CA file, checked once connected with one', () => {
  assert.throws(() => mysqlTlsOptions({ ...base, host: '10.0.4.12' }), /cannot check a certificate issued to an IP address \(10\.0\.4\.12\) before sending the password/);
  assert.throws(() => mysqlTlsOptions({ ...base, host: 'db.example.net', sslServerName: '10.0.4.12' }), /IP address/);
  const withCa = mysqlTlsOptions({ ...base, host: '10.0.4.12', sslCaPath: '/etc/ca.pem' }, read);
  assert.deepEqual(withCa, { ssl: { rejectUnauthorized: true, ca: pem, verifyIdentity: false }, host: '10.0.4.12', nameAfterConnect: '10.0.4.12' });
  assert.deepEqual(mysqlTlsOptions({ ...base, host: '10.0.4.12', sslVerify: false }).host, '10.0.4.12', 'nothing to check when Verify is off');
});

test('mongo: CA file passed by path, home directory expanded', () => {
  const o = mongoTlsOptions({ ...base, sslCaPath: '~/ca.pem' });
  assert.equal(o.tls, true);
  assert.equal(o.tlsAllowInvalidCertificates, undefined);
  assert.match(String(o.tlsCAFile), /^\/.*\/ca\.pem$/);
  assert.equal(o.servername, 'db.example.net');
});
