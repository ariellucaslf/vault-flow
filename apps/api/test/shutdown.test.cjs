const { test } = require("node:test");
const assert = require("node:assert/strict");
const { prisma } = require("@vault-flow/db");
const { mockPrisma } = require("./helpers.cjs");
const storage = require("../dist/services/storageService");
const {
  startBackupForProject,
  cancelActiveBackups,
  getActiveBackupStatus,
  BackupUnavailableError,
} = require("../dist/services/backupOrchestrator");

test("encerramento impede início tardio após consulta ou persistência pendente", async (t) => {
  let resolveLookup;
  let resolveLog;
  let logStarted;
  const pendingLookup = new Promise((resolve) => {
    resolveLookup = resolve;
  });
  const pendingLog = new Promise((resolve) => {
    resolveLog = resolve;
  });
  const reachedLog = new Promise((resolve) => {
    logStarted = resolve;
  });
  const project = {
    id: "persist",
    name: "Shutdown fixture",
    type: "DATABASE",
    enabled: true,
    destinations: [],
  };
  mockPrisma(t, prisma.project, "findUnique", ({ where }) =>
    where.id === "lookup" ? pendingLookup : Promise.resolve(project),
  );
  mockPrisma(t, prisma.backupLog, "create", () => {
    logStarted();
    return pendingLog;
  });
  const update = mockPrisma(
    t,
    prisma.backupLog,
    "update",
    async ({ data }) => data,
  );
  const upload = t.mock.method(storage, "uploadToS3", async () => {
    throw new Error("upload não deveria iniciar");
  });
  const first = assert.rejects(
    startBackupForProject("lookup"),
    BackupUnavailableError,
  );
  const second = assert.rejects(
    startBackupForProject("persist"),
    BackupUnavailableError,
  );
  await reachedLog;
  await cancelActiveBackups();
  resolveLookup({ ...project, id: "lookup" });
  resolveLog({ id: "shutdown-log" });
  await Promise.all([first, second]);
  assert.equal(upload.mock.callCount(), 0);
  assert.equal(update.mock.calls[0].arguments[0].data.status, "FAILED");
  assert.equal(getActiveBackupStatus().activeCount, 0);
  await assert.rejects(
    startBackupForProject("after-shutdown"),
    BackupUnavailableError,
  );
});
