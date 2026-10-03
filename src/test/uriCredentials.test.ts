import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { splitUriPassword } from '../uriCredentials';

test('lifts the password out of a connection string', () => {
  assert.deepEqual(splitUriPassword('mongodb+srv://ann:s3cret@cluster0.example.net/app?retryWrites=true'), {
    uri: 'mongodb+srv://ann@cluster0.example.net/app?retryWrites=true',
    user: 'ann',
    password: 's3cret',
  });
});

test('decodes percent-encoded user and password, keeps the user encoded in the string', () => {
  assert.deepEqual(splitUriPassword('mongodb://ann%40corp:p%40ss%3Aw%2Fd@h/'), { uri: 'mongodb://ann%40corp@h/', user: 'ann@corp', password: 'p@ss:w/d' });
});

test('multi-host strings (not valid URLs) work', () => {
  assert.deepEqual(splitUriPassword('mongodb://u:p@h1:27017,h2:27017/db?replicaSet=rs0'), { uri: 'mongodb://u@h1:27017,h2:27017/db?replicaSet=rs0', user: 'u', password: 'p' });
});

test('strings without a password are left alone', () => {
  assert.deepEqual(splitUriPassword('mongodb://ann@h/'), { uri: 'mongodb://ann@h/', user: 'ann' });
  assert.deepEqual(splitUriPassword('mongodb://h:27017/?authSource=admin'), { uri: 'mongodb://h:27017/?authSource=admin' });
  assert.deepEqual(splitUriPassword('mongodb://h/?x=a@b'), { uri: 'mongodb://h/?x=a@b' }, '@ after the host part is not a credential');
});

test('an empty password ("u:@") is removed and reported as none', () => {
  assert.deepEqual(splitUriPassword('mongodb://u:@h/'), { uri: 'mongodb://u@h/', user: 'u', password: undefined });
});

test('a user or password the driver would refuse unencoded is reported, a clear string is not', () => {
  const { credentialProblem } = require('../uriCredentials') as typeof import('../uriCredentials');
  for (const unclear of ['mongodb://u:pa/ss@h/', 'mongodb://admin:Xy/9#k@cluster.example.net/', 'mongodb://u:p@ss@h/', 'mongodb://u:p?w@h/', 'mongodb://a:b:c@h/']) {
    assert.match(credentialProblem(unclear) ?? '', /not encoded: write @ as %40/, unclear);
  }
  for (const clear of [
    'mongodb://u:p%40ss%2F@h1:27017,h2:27017/db?replicaSet=rs0',
    'mongodb+srv://ann:s3cret@cluster0.example.net/app?retryWrites=true',
    'mongodb://u:pw@h/db?authSource=admin&appName=a@b',
    'mongodb://h1:27017,h2:27018/',
    'mongodb://u@h/',
  ]) {
    assert.equal(credentialProblem(clear), undefined, clear);
  }
});
