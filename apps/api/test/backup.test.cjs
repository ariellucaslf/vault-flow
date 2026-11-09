const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { gunzipSync } = require("node:zlib");
const { setTimeout: delay } = require("node:timers/promises");
const { prisma, encryptSecret } = require("@vault-flow/db");
const { mockPrisma } = require("./helpers.cjs");
const storage = require("../dist/services/storageService");
const { S3StorageProvider } = require("../dist/services/providers/s3Provider");
const {
  startBackupForProject,
  getActiveBackupStatus,
} = require("../dist/services/backupOrchestrator");

const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
});

function fixture(t, type = "STORAGE") {
  process.env.VAULTFLOW_MASTER_KEY_FILE = "";
  process.env.VAULTFLOW_MASTER_KEY = "ab".repeat(32);
  process.env.BACKUP_TIMEOUT_MS = "2000";
  const secret = (value, resourceType, resourceId, field = "credentials") =>
    encryptSecret(value, { resourceType, resourceId, field });
  const credentials = JSON.stringify({
    accessKeyId: "fixture",
    secretAccessKey: "fixture",
  });
  const project = {
    id: "fixture-project",
    name: "Regression fixture",
    type,
    enabled: true,
    secretVersion: 1,
    dbUrl: null,
    destinations: [
      {
        id: "fixture-dest",
        type: "AWS_S3",
        targetFolder: "fixture",
        secretVersion: 1,
        credentials: secret(credentials, "Destination", "fixture-dest"),
      },
    ],
    storageSource: {
      id: "fixture-source",
      type: "AWS_S3",
      targetFolder: "fixture",
      prefix: null,
      secretVersion: 1,
      credentials: secret(credentials, "StorageSource", "fixture-source"),
    },
  };
  const updates = [];
  mockPrisma(t, prisma.project, "findUnique", async () => project);
  mockPrisma(t, prisma.backupLog, "create", async () => ({
    id: "fixture-log",
  }));
  mockPrisma(t, prisma.backupLog, "update", async ({ data }) => {
    updates.push(data);
    return data;
  });
  t.mock.method(S3StorageProvider.prototype, "dispose", () => {});
  return { project, updates };
}

function uploadFixture(t, received = []) {
  t.mock.method(storage, "uploadToS3", async (stream) => {
    for await (const chunk of stream) received.push(Buffer.from(chunk));
    return { artifactUri: "s3://fixture/fixture.tar.gz" };
  });
}

test("erro de leitura de um arquivo falha o backup sem derrubar o processo", async (t) => {
  const { updates } = fixture(t);
  uploadFixture(t);
  t.mock.method(S3StorageProvider.prototype, "listFiles", async () => [
    { key: "file.txt", size: 10 },
  ]);
  t.mock.method(
    S3StorageProvider.prototype,
    "getFileStream",
    async () =>
      new Readable({
        read() {
          this.destroy(new Error("falha de leitura simulada"));
        },
      }),
  );
  const run = await startBackupForProject("fixture-project");
  await assert.rejects(run.completionPromise, /falha de leitura simulada/);
  assert.equal(updates.at(-1).status, "FAILED");
  assert.equal(getActiveBackupStatus().activeCount, 0);
});

test("falha de preparação cancela uploads sem rejeições não tratadas", async (t) => {
  const { updates } = fixture(t, "DATABASE");
  t.mock.method(
    storage,
    "uploadToS3",
    (_stream, _bucket, _key, _credentials, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      ),
  );
  const run = await startBackupForProject("fixture-project");
  await assert.rejects(run.completionPromise, /URL de conexão/);
  assert.equal(updates.at(-1).status, "FAILED");
  assert.equal(getActiveBackupStatus().activeCount, 0);
});

test("deadline cobre listagem de storage que não responde", async (t) => {
  const { updates } = fixture(t);
  process.env.BACKUP_TIMEOUT_MS = "30";
  uploadFixture(t);
  t.mock.method(
    S3StorageProvider.prototype,
    "listFiles",
    () => new Promise(() => {}),
  );
  const started = Date.now();
  const run = await startBackupForProject("fixture-project");
  await assert.rejects(run.completionPromise, /Tempo limite total/);
  assert.ok(Date.now() - started < 1500);
  assert.equal(updates.at(-1).status, "FAILED");
  assert.equal(getActiveBackupStatus().activeCount, 0);
});

test("falha de upload durante listagem pendente cancela a preparação", async (t) => {
  const { updates } = fixture(t);
  t.mock.method(storage, "uploadToS3", async () => {
    throw new Error("upload indisponível");
  });
  t.mock.method(
    S3StorageProvider.prototype,
    "listFiles",
    () => new Promise(() => {}),
  );
  const run = await startBackupForProject("fixture-project");
  await assert.rejects(run.completionPromise, /upload indisponível/);
  assert.equal(updates.at(-1).status, "FAILED");
  assert.equal(getActiveBackupStatus().activeCount, 0);
});

test("deadline libera capacidade mesmo se upload ignora o cancelamento", async (t) => {
  const { updates } = fixture(t);
  process.env.BACKUP_TIMEOUT_MS = "30";
  let uploadSignal;
  t.mock.method(storage, "uploadToS3", (_s, _b, _k, _c, signal) => {
    uploadSignal = signal;
    return new Promise(() => {});
  });
  t.mock.method(S3StorageProvider.prototype, "listFiles", async () => []);
  const started = Date.now();
  const run = await startBackupForProject("fixture-project");
  await assert.rejects(run.completionPromise, /Tempo limite total/);
  assert.ok(Date.now() - started < 6500);
  assert.equal(uploadSignal.aborted, true);
  assert.equal(updates.at(-1).status, "FAILED");
  assert.equal(getActiveBackupStatus().activeCount, 0);
});

test("sucesso preserva conteúdo, tamanho e checksum do tar gzip", async (t) => {
  const { updates } = fixture(t);
  const received = [];
  uploadFixture(t, received);
  let open = 0;
  let maxOpen = 0;
  t.mock.method(S3StorageProvider.prototype, "listFiles", async () => [
    { key: "first.txt", size: 5 },
    { key: "folder/second.txt", size: 6 },
  ]);
  t.mock.method(
    S3StorageProvider.prototype,
    "getFileStream",
    async ({ key }) => {
      open++;
      maxOpen = Math.max(maxOpen, open);
      const stream = Readable.from([key === "first.txt" ? "FIRST" : "SECOND"]);
      stream.once("end", () => {
        open--;
      });
      return stream;
    },
  );
  const run = await startBackupForProject("fixture-project");
  await run.completionPromise;
  const gzip = Buffer.concat(received);
  const tar = gunzipSync(gzip);
  assert.ok(
    tar.includes(Buffer.from("FIRST")) && tar.includes(Buffer.from("SECOND")),
  );
  assert.equal(updates.at(-1).fileSize, BigInt(gzip.length));
  assert.equal(
    updates.at(-1).checksumSha256,
    crypto.createHash("sha256").update(gzip).digest("hex"),
  );
  assert.equal(updates.at(-1).fileCount, 2);
  assert.equal(updates.at(-1).status, "SUCCESS");
  assert.equal(maxOpen, 1);
});

test("caminho inseguro não entra no artefato", async (t) => {
  const { updates } = fixture(t);
  uploadFixture(t);
  t.mock.method(S3StorageProvider.prototype, "listFiles", async () => [
    { key: "../secret", size: 1 },
  ]);
  const reader = t.mock.method(
    S3StorageProvider.prototype,
    "getFileStream",
    async () => Readable.from(["secret"]),
  );
  const run = await startBackupForProject("fixture-project");
  await assert.rejects(run.completionPromise, /Nome de arquivo inseguro/);
  assert.equal(reader.mock.callCount(), 0);
  assert.equal(updates.at(-1).status, "FAILED");
});

test("stream retornado depois do cancelamento é encerrado", async (t) => {
  const { updates } = fixture(t);
  process.env.BACKUP_TIMEOUT_MS = "30";
  uploadFixture(t);
  t.mock.method(S3StorageProvider.prototype, "listFiles", async () => [
    { key: "late.txt", size: 4 },
  ]);
  let opened;
  t.mock.method(
    S3StorageProvider.prototype,
    "getFileStream",
    () =>
      new Promise((resolve) => {
        opened = resolve;
      }),
  );
  const run = await startBackupForProject("fixture-project");
  await assert.rejects(run.completionPromise, /Tempo limite total/);
  const lateStream = Readable.from(["late"]);
  opened(lateStream);
  await delay(10);
  assert.equal(lateStream.destroyed, true);
  assert.equal(updates.at(-1).status, "FAILED");
});

test("origem vazia produz gzip íntegro com marcador explícito", async (t) => {
  const { updates } = fixture(t);
  const received = [];
  uploadFixture(t, received);
  t.mock.method(S3StorageProvider.prototype, "listFiles", async () => []);
  const run = await startBackupForProject("fixture-project");
  await run.completionPromise;
  const tar = gunzipSync(Buffer.concat(received));
  assert.ok(tar.includes(Buffer.from(".vaultflow-empty-snapshot.txt")));
  assert.equal(updates.at(-1).fileCount, 0);
  assert.equal(updates.at(-1).status, "SUCCESS");
});

test("upload recebe dados antes de o arquivo de origem terminar", async (t) => {
  const { updates } = fixture(t);
  let remaining = 4 * 1024 * 1024;
  let ended = false;
  let received = false;
  t.mock.method(S3StorageProvider.prototype, "listFiles", async () => [
    { key: "large.bin", size: remaining },
  ]);
  t.mock.method(
    S3StorageProvider.prototype,
    "getFileStream",
    async () =>
      new Readable({
        read() {
          if (remaining === 0) {
            ended = true;
            this.push(null);
            return;
          }
          const chunk = crypto.randomBytes(Math.min(remaining, 64 * 1024));
          remaining -= chunk.length;
          this.push(chunk);
        },
      }),
  );
  t.mock.method(storage, "uploadToS3", async (stream) => {
    for await (const chunk of stream) {
      assert.ok(chunk.length > 0);
      if (!received)
        assert.equal(
          ended,
          false,
          "origem foi inteiramente acumulada antes do upload",
        );
      received = true;
    }
    return { artifactUri: "s3://fixture/large.tar.gz" };
  });
  const run = await startBackupForProject("fixture-project");
  await run.completionPromise;
  assert.equal(received, true);
  assert.equal(ended, true);
  assert.equal(updates.at(-1).status, "SUCCESS");
});
