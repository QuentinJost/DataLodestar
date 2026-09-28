import { DbKind } from '../types';
import { Endpoint, SqlDriver } from './driver';
import { MongoDriver } from './mongo';
import { MysqlDriver } from './mysql';
import { PostgresDriver } from './postgres';
import { RedisDriver } from './redis';

export type AnyDriver = SqlDriver | MongoDriver | RedisDriver;

export function createDriver(kind: DbKind, endpoint: Endpoint): AnyDriver {
  switch (kind) {
    case 'mysql':
      return new MysqlDriver(endpoint);
    case 'postgres':
      return new PostgresDriver(endpoint);
    case 'mongodb':
      return new MongoDriver(endpoint);
    case 'redis':
      return new RedisDriver(endpoint);
  }
}

export const DEFAULT_PORTS: Record<DbKind, number> = { mysql: 3306, postgres: 5432, mongodb: 27017, redis: 6379 };
