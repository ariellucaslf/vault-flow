const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const childProcess = require("node:child_process");
const {
  executePgDump,
  sanitizeDiagnosticMessage,
} = require("../dist/services/backupService");

function mockChild(t, inspect, code = 0) {
  t.mock.method(childProcess, "spawn", (_command, args, options) => {
    inspect(args, options);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.end("fixture");
      child.stderr.end();
      child.exitCode = code;
      child.emit("close", code, null);
    });
    return child;
  });
}

for (const connection of [
  "postgresql://fixture:query_secret@localhost/fixture",
  "postgresql://fixture@localhost/fixture?password=query_secret",
]) {
  test(`senha removida dos argumentos (${connection.includes("?") ? "query" : "userinfo"})`, async (t) => {
    let passfile;
    mockChild(t, (args, options) => {
      assert.ok(
        !args.some(
          (arg) => arg.includes("query_secret") || arg.includes("password="),
        ),
      );
      passfile = options.env.PGPASSFILE;
      assert.equal(fs.readFileSync(passfile, "utf8"), "*:*:*:*:query_secret\n");
      assert.equal(fs.statSync(passfile).mode & 0o777, 0o600);
      assert.equal(options.env.VAULTFLOW_MASTER_KEY, undefined);
      assert.equal(options.shell, false);
    });
    const execution = executePgDump(connection);
    execution.stream.resume();
    await execution.donePromise;
    assert.equal(fs.existsSync(passfile), false);
  });
}

test("parâmetros que mudam host, arquivos ou comandos são recusados", () => {
  for (const query of [
    "hostaddr=127.0.0.1",
    "passfile=/tmp/secrets",
    "options=-csearch_path=public",
    "password=a&password=b",
  ]) {
    assert.throws(
      () => executePgDump(`postgresql://fixture@localhost/fixture?${query}`),
      /não permitido|duplicadas/,
    );
  }
});

test("código de saída diferente de zero rejeita conclusão", async (t) => {
  mockChild(t, () => {}, 1);
  const execution = executePgDump("postgresql://fixture@localhost/fixture");
  execution.stream.on("error", () => {});
  execution.stream.resume();
  await assert.rejects(execution.donePromise, /código 1/);
});

test("URI preserva mais literal e percent-encoding sem expor a senha", async (t) => {
  mockChild(t, (args, options) => {
    assert.equal(
      fs.readFileSync(options.env.PGPASSFILE, "utf8"),
      "*:*:*:*:literal+plus\n",
    );
    const uri = args[args.indexOf("-d") + 1];
    assert.ok(!uri.includes("password") && !uri.includes("literal"));
    assert.ok(uri.includes("application_name=hello%20world%2Bcli"));
  });
  const execution = executePgDump(
    "postgresql://fixture@localhost/fixture?password=literal+plus&application_name=hello%20world+cli",
  );
  execution.stream.resume();
  await execution.donePromise;
});

test("percent-encoding inválido é recusado antes de invocar o processo", () => {
  for (const password of ["%ZZ", "%00"]) {
    assert.throws(
      () =>
        executePgDump(
          `postgresql://fixture@localhost/fixture?password=${password}`,
        ),
      /Codificação/,
    );
  }
});

test("diagnósticos removem segredos JSON, bearer, userinfo HTTP e chave privada", () => {
  const fixtures = [
    '{"secretAccessKey":"JSON_MARKER"}',
    "Bearer BEARER_MARKER",
    "https://user:HTTP_MARKER@example.com/path",
    "-----BEGIN PRIVATE KEY-----\nPEM_MARKER\n-----END PRIVATE KEY-----",
    "password='SPACED_MARKER secret'",
  ];
  for (const input of fixtures)
    assert.ok(!sanitizeDiagnosticMessage(input).includes("MARKER"));
});
