/**
 * Gives the API tests a real DynamoDB, never AWS: DYNAMODB_ENDPOINT when set (CI runs
 * amazon/dynamodb-local as a service), otherwise DynamoDB Local started in memory from .dynamodb/
 * (needs Java 17+). Fetch it once with:
 *
 *   mkdir -p .dynamodb && curl -sL https://d1ni2b6xgvw0s0.cloudfront.net/v2.x/dynamodb_local_latest.tar.gz | tar xz -C .dynamodb
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { GlobalSetupContext } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    dynamodbEndpoint: string;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

export default async function setup({ provide }: GlobalSetupContext) {
  if (process.env.DYNAMODB_ENDPOINT) {
    provide('dynamodbEndpoint', process.env.DYNAMODB_ENDPOINT);
    return;
  }
  const dir = path.resolve('.dynamodb');
  if (!fs.existsSync(path.join(dir, 'DynamoDBLocal.jar'))) {
    throw new Error(`DynamoDB Local is not in ${dir}. Download it (see tests/dynamodb-local.ts) or set DYNAMODB_ENDPOINT.`);
  }
  const port = await freePort();
  const java = spawn('java', ['-Djava.library.path=./DynamoDBLocal_lib', '-jar', 'DynamoDBLocal.jar', '-inMemory', '-port', String(port)], {
    cwd: dir,
    stdio: 'ignore',
  });
  const exited = new Promise<never>((_, reject) => java.once('exit', (code) => reject(new Error(`DynamoDB Local exited with code ${code}`))));
  exited.catch(() => {});
  const deadline = Date.now() + 30_000;
  while (!(await canConnect(port))) {
    if (java.exitCode !== null) await exited;
    if (Date.now() > deadline) throw new Error('DynamoDB Local did not start within 30 seconds');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  provide('dynamodbEndpoint', `http://127.0.0.1:${port}`);
  return () => {
    java.kill();
  };
}
