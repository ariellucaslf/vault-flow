const { test } = require("node:test");
const assert = require("node:assert/strict");
const { google } = require("googleapis");
const {
  GoogleDriveStorageProvider,
} = require("../dist/services/providers/googleDriveProvider");

function provider() {
  return new GoogleDriveStorageProvider({
    folderId: "root-id",
    credentialsJson: JSON.stringify({
      client_email: "fixture@example.com",
      private_key: "fixture",
    }),
  });
}

test("Drive usa o ID da pasta na query e encaminha cancelamento/paginação", async (t) => {
  const signal = new AbortController().signal;
  const calls = [];
  t.mock.method(google, "drive", () => ({
    files: {
      list: async (params, options) => {
        calls.push({ params, options });
        return params.pageToken
          ? {
              data: {
                files: [
                  {
                    id: "file-id",
                    name: "fixture.txt",
                    size: "4",
                    mimeType: "text/plain",
                  },
                ],
              },
            }
          : { data: { nextPageToken: "next", files: [] } };
      },
    },
  }));
  const files = await provider().listFiles(undefined, signal);
  assert.equal(files[0].key, "fixture.txt");
  assert.equal(calls[0].params.q, "'root-id' in parents and trashed = false");
  assert.equal(calls[1].params.pageToken, "next");
  assert.equal(calls[0].options.signal, signal);
});

test("Drive não finge filtrar prefixo nem ignora arquivos nativos", async (t) => {
  t.mock.method(google, "drive", () => ({
    files: {
      list: async () => ({
        data: {
          files: [
            {
              id: "doc",
              name: "Documento",
              mimeType: "application/vnd.google-apps.document",
            },
          ],
        },
      }),
    },
  }));
  await assert.rejects(
    provider().listFiles("folder"),
    /Prefixo.*não suportado/,
  );
  await assert.rejects(provider().listFiles(), /Arquivos nativos/);
});
