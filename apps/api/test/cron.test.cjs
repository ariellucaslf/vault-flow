const { test } = require("node:test");
const assert = require("node:assert/strict");
const { setTimeout: delay } = require("node:timers/promises");
const { prisma } = require("@vault-flow/db");
const { mockPrisma } = require("./helpers.cjs");
const cron = require("node-cron");
const manager = require("../dist/scheduler/cronManager");
const { triggerBackup } = require("../dist/controllers/project.controller");

async function eventually(check) {
  const deadline = Date.now() + 1000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "agendador não recuperou no prazo");
    await delay(10);
  }
}

test("recupera falha inicial e notificação perdida sem duplicar tarefas ou recuperar logs ativos", async (t) => {
  let queries = 0;
  let projects = [];
  let blockedQuery;
  let unblock;
  let recoveryAttempts = 0;
  const recovery = mockPrisma(t, prisma.backupLog, "updateMany", async () => {
    if (++recoveryAttempts === 1)
      throw new Error("falha ao recuperar logs interrompidos");
    return { count: 0 };
  });
  mockPrisma(t, prisma.project, "findMany", async () => {
    queries++;
    if (queries === 1) throw new Error("banco indisponível");
    if (blockedQuery) await blockedQuery;
    return projects;
  });
  const schedule = t.mock.method(cron, "schedule", () => ({ stop() {} }));
  t.after(() => manager.stopCronJobs());
  await manager.initCronJobs({ intervalMs: 20 });
  assert.equal(manager.isSchedulerReady(), false);
  let status;
  await triggerBackup(
    { params: { id: "b5de9a92-0c40-4680-bc20-e5f56433ff80" } },
    {
      status(code) {
        status = code;
        return this;
      },
      json(body) {
        assert.equal(body.success, false);
      },
    },
  );
  assert.equal(status, 503);
  projects = [
    {
      id: "one",
      name: "One",
      type: "DATABASE",
      cronSchedule: "0 3 * * *",
      timezone: "UTC",
      enabled: true,
    },
  ];
  await eventually(
    () => manager.isSchedulerReady() && schedule.mock.callCount() === 1,
  );
  projects = [...projects, { ...projects[0], id: "two", name: "Two" }];
  await eventually(() => schedule.mock.callCount() === 2);
  assert.equal(recovery.mock.callCount(), 2);

  blockedQuery = new Promise((resolve) => {
    unblock = resolve;
  });
  const first = manager.reconcileCronJobs();
  const second = manager.reconcileCronJobs();
  assert.equal(first, second);
  unblock();
  await first;
  assert.equal(schedule.mock.callCount(), 2);

  projects = [];
  blockedQuery = undefined;
  await manager.reconcileCronJobs();
  assert.equal(manager.getScheduledJobsSnapshot().length, 0);
  assert.equal(recovery.mock.callCount(), 2);
  await manager.stopCronJobs();
  assert.equal(manager.isSchedulerReady(), false);
});
