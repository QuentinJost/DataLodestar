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
