import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { PeerCertificate } from 'tls';
import { Endpoint } from '../drivers/driver';
import { mongoTlsOptions, mysqlTlsOptions, tlsOptions } from '../drivers/tls';

const base: Endpoint = { host: 'db.example.net', port: 5432, user: 'u', ssl: true, sslVerify: true };
const pem = Buffer.from('-----BEGIN CERTIFICATE-----');
const read = (path: string) => {
  assert.equal(path, '/etc/ca.pem');
  return pem;
};

test('no SSL: no TLS options for any driver', () => {
  const e = { ...base, ssl: false };
  assert.equal(tlsOptions(e), undefined);
  assert.deepEqual(mysqlTlsOptions(e), {});
  assert.deepEqual(mongoTlsOptions(e), {});
});

test('verification off keeps the old unchecked behaviour', () => {
  const e = { ...base, sslVerify: false };
  assert.deepEqual(tlsOptions(e), { rejectUnauthorized: false });
  assert.deepEqual(mysqlTlsOptions(e), { ssl: { rejectUnauthorized: false, ca: undefined, verifyIdentity: false }, nameAfterConnect: undefined });
  assert.deepEqual(mongoTlsOptions(e), { tls: true, tlsAllowInvalidCertificates: true });
  assert.deepEqual(tlsOptions({ ...base, sslVerify: undefined }), { rejectUnauthorized: false }, 'undefined = saved before the setting existed');
});

test('pg / redis: verification on checks the chain and the host name, with an optional CA', () => {
  assert.deepEqual(tlsOptions(base), { rejectUnauthorized: true, servername: 'db.example.net' });
  assert.deepEqual(tlsOptions({ ...base, sslCaPath: '/etc/ca.pem' }, read), { rejectUnauthorized: true, ca: pem, servername: 'db.example.net' });
});

test('through a tunnel the name comes from the config, not 127.0.0.1', () => {
  const tunnelled = { ...base, host: '127.0.0.1', sslServerName: 'db.internal' };
  assert.equal(tlsOptions(tunnelled)!.servername, 'db.internal');
  assert.deepEqual(mysqlTlsOptions(tunnelled).nameAfterConnect, 'db.internal');
  assert.equal(mysqlTlsOptions(tunnelled).ssl!.verifyIdentity, false, 'mysql2 would check 127.0.0.1');
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

test('mysql: the driver checks the name only when it is the host it dials', () => {
  assert.deepEqual(mysqlTlsOptions({ ...base, sslCaPath: '/etc/ca.pem' }, read), { ssl: { rejectUnauthorized: true, ca: pem, verifyIdentity: true }, nameAfterConnect: undefined });
  assert.equal(mysqlTlsOptions({ ...base, host: '10.0.0.5' }).nameAfterConnect, '10.0.0.5');
});

test('mongo: CA file passed by path, home directory expanded', () => {
  const o = mongoTlsOptions({ ...base, sslCaPath: '~/ca.pem' });
  assert.equal(o.tls, true);
  assert.equal(o.tlsAllowInvalidCertificates, undefined);
  assert.match(String(o.tlsCAFile), /^\/.*\/ca\.pem$/);
  assert.equal(o.servername, 'db.example.net');
});
