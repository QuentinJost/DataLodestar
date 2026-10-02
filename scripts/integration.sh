#!/usr/bin/env bash
# Spins up throwaway MySQL, PostgreSQL, MongoDB (replica set), Redis and sshd containers on an isolated network,
# runs the integration tests in a Node container, then removes everything.
# HOST_DIR: path of this folder as seen by the Docker daemon (defaults to $PWD).
# KEEP=1 leaves the servers running and reuses them on the next run.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST_DIR="${HOST_DIR:-$PWD}"
NET=sqlnav-it
PW=sqlnav-test-pw
cleanup() { docker rm -f sqlnav-mysql sqlnav-pg sqlnav-mongo sqlnav-redis sqlnav-ssh >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
if [ "${KEEP:-}" != 1 ]; then trap cleanup EXIT; fi
# Servers kept by an older version of this script (PostgreSQL without TLS) are recreated.
if ! docker inspect sqlnav-ssh >/dev/null 2>&1 || ! docker exec sqlnav-pg test -f /var/lib/postgresql/server.crt 2>/dev/null; then
  cleanup
  docker network create "$NET" >/dev/null
  docker run -d --name sqlnav-mysql --network "$NET" -e MYSQL_ROOT_PASSWORD=$PW mysql:8.4 >/dev/null
  # TLS on, with a self-signed certificate for db.internal: not the host the tests dial.
  docker run -d --name sqlnav-pg --network "$NET" -e POSTGRES_PASSWORD=$PW --entrypoint sh postgres:17-alpine -c \
    "apk add --no-cache openssl >/dev/null && cd /var/lib/postgresql && \
     openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj /CN=db.internal -addext subjectAltName=DNS:db.internal \
       -keyout server.key -out server.crt 2>/dev/null && chown postgres:postgres server.key server.crt && chmod 600 server.key && \
     exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/var/lib/postgresql/server.crt -c ssl_key_file=/var/lib/postgresql/server.key" >/dev/null
  # Transactions need a replica set; with auth, a replica set needs a keyfile.
  docker run -d --name sqlnav-mongo --network "$NET" -e MONGO_INITDB_ROOT_USERNAME=root -e MONGO_INITDB_ROOT_PASSWORD=$PW \
    --entrypoint bash mongo:8 -c "head -c 756 /dev/urandom | base64 > /tmp/kf && chmod 400 /tmp/kf && chown mongodb:mongodb /tmp/kf && \
      exec docker-entrypoint.sh mongod --replSet rs0 --keyFile /tmp/kf --bind_ip_all" >/dev/null
  docker run -d --name sqlnav-redis --network "$NET" redis:7-alpine redis-server --requirepass $PW >/dev/null
  docker run -d --name sqlnav-ssh --network "$NET" alpine:3 sh -c \
    "apk add --no-cache openssh >/dev/null && ssh-keygen -A >/dev/null && adduser -D tunnel && echo 'tunnel:$PW' | chpasswd && \
     exec /usr/sbin/sshd -D -e -o AllowTcpForwarding=yes -o PasswordAuthentication=yes" >/dev/null
fi

echo "waiting for servers…"
for _ in $(seq 1 90); do
  if docker exec sqlnav-mysql mysql -uroot -p$PW -e 'SELECT 1' >/dev/null 2>&1 \
    && docker exec sqlnav-pg pg_isready -U postgres >/dev/null 2>&1 \
    && docker exec sqlnav-ssh sh -c 'pgrep sshd' >/dev/null 2>&1 \
    && docker exec sqlnav-redis redis-cli -a $PW --no-auth-warning ping >/dev/null 2>&1 \
    && docker exec sqlnav-mongo mongosh -u root -p $PW --quiet --eval \
      "try { rs.status().ok } catch (e) { rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'sqlnav-mongo:27017' }] }).ok }; db.hello().isWritablePrimary" 2>/dev/null | grep -q true; then ready=1; break; fi
  sleep 2
done
[ "${ready:-}" = 1 ] || { echo "servers not ready"; exit 1; }

# MySQL generates a self-signed CA at first start, PostgreSQL got one above: the TLS tests trust them through these copies.
mkdir -p out/it && docker exec sqlnav-mysql cat /var/lib/mysql/ca.pem > out/it/mysql-ca.pem
docker exec sqlnav-pg cat /var/lib/postgresql/server.crt > out/it/pg-ca.pem

docker run --rm --init --network "$NET" -v "$HOST_DIR":/ext -w /ext \
  -e SQLNAV_IT=1 -e MYSQL_HOST=sqlnav-mysql -e PG_HOST=sqlnav-pg -e SSH_HOST=sqlnav-ssh \
  -e MONGO_HOST=sqlnav-mongo -e REDIS_HOST=sqlnav-redis \
  -e DB_PASSWORD=$PW -e SSH_PASSWORD=$PW -e MYSQL_CA=out/it/mysql-ca.pem -e PG_CA=out/it/pg-ca.pem \
  node:22-alpine sh -c 'ls out/test/*.test.js >/dev/null && node --test "out/test/*.test.js"'
