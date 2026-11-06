import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteTaskStore } from "../store.js";

function execution(store: SqliteTaskStore, name: string) {
  let task = store.start({ scopeId: "scope", idempotencyKey: `start-identity-${name}`, workspace: `/tmp/${name}`,
    packet: {}, model: "fake/model", profile: "bounded-build", baselineHash: "a".repeat(64), promptHash: "b".repeat(64) });
  task = store.bindSession(task.scopeId, task.taskId, task.revision, `backend-${name}`, `session-${name}`);
  return store.transition(task.scopeId, task.taskId, task.revision, "running", "current");
}

test("native IDs coexist across executions and every response/update/expiry stays isolated after reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-identity-"));
  const file = join(directory, "store.sqlite");
  let store = new SqliteTaskStore(file);
  try {
    const a = execution(store, "a"), b = execution(store, "b");
    const detail = (sessionId: string) => ({ sessionId, type: "permission", detail: { tool: "edit" } });
    store.upsertInputRequest("scope", a.taskId, a.executionId, "30", "permission", detail(a.sessionId!));
    store.upsertInputRequest("scope", b.taskId, b.executionId, "30", "permission", detail(b.sessionId!));
    const updatedDetail = { ...detail(b.sessionId!), revisionMarker: "new" };
    const request = store.upsertInputRequest("scope", b.taskId, b.executionId, "30", "permission", updatedDetail);
    assert.equal(request.revision, 2);
    assert.equal(store.inputRequests(a.executionId)[0]!.revision, 1);
    assert.equal(store.upsertInputRequest("scope", b.taskId, b.executionId, "30", "permission", updatedDetail).revision, 2);
    const input = { scopeId: "scope", taskId: b.taskId, executionId: b.executionId,
      expectedRevision: store.get("scope", b.taskId)!.revision, idempotencyKey: "reply-identity-b-0001",
      requestId: "30", requestRevision: 2, reply: "deny", authorizationBasis: "audit-only", workerExplanation: "Use existing evidence and finish the report." };
    assert.throws(() => store.respondToRequest({ ...input, requestRevision: 1 }), /revision is stale/);
    assert.throws(() => store.respondToRequest({ ...input, expectedRevision: 1 }), /STALE_REVISION/);
    store.respondToRequest(input);
    assert.equal(store.inputRequests(a.executionId)[0]!.status, "pending");
    assert.equal(store.inputRequests(a.executionId)[0]!.workerExplanation, null);
    store.close(); store = new SqliteTaskStore(file);
    assert.equal(store.inputRequests(b.executionId)[0]!.workerExplanation, input.workerExplanation);
    store.respondToRequest(input);
    assert.throws(() => store.respondToRequest({ ...input, workerExplanation: "Different" }), /IDEMPOTENCY_CONFLICT/);
    store.acknowledgeInputResponse(b.executionId, "30");
    store.expireMissingInputRequests(a.executionId, []);
    assert.equal(store.inputRequests(a.executionId)[0]!.status, "expired");
    assert.equal(store.inputRequests(b.executionId)[0]!.status, "responded");
    const c = execution(store, "c");
    store.upsertInputRequest("scope", c.taskId, c.executionId, "30", "permission", detail("wrong-session"));
    assert.throws(() => store.respondToRequest({ ...input, taskId: c.taskId, executionId: c.executionId,
      expectedRevision: store.get("scope", c.taskId)!.revision, requestRevision: 1, idempotencyKey: "reply-identity-c-0001" }), /binding/);
    store.expireInputRequest(c.executionId, "30");
    assert.equal(store.inputRequests(b.executionId)[0]!.status, "responded");
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

function oldRequestTable(db: DatabaseSync) {
  db.exec(`BEGIN;
    ALTER TABLE input_requests RENAME TO input_requests_new;
    CREATE TABLE input_requests(request_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES executions(execution_id),
      kind TEXT NOT NULL, revision INTEGER NOT NULL, detail_json TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT, response_json TEXT, authorization_basis_json TEXT);
    INSERT INTO input_requests SELECT request_id,execution_id,kind,revision,detail_json,status,created_at,response_json,authorization_basis_json FROM input_requests_new;
    DROP TABLE input_requests_new; UPDATE schema_version SET version=3; COMMIT;`);
}

for (const fail of ["none", "backup", "migration"] as const) {
  test(`v3 migration preserves every request state and durable reply hash (failure: ${fail})`, () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-migrate-"));
    const file = join(directory, "store.sqlite");
    let store: SqliteTaskStore | undefined = new SqliteTaskStore(file);
    try {
      const task = execution(store, "migrate");
      const request = store.upsertInputRequest("scope", task.taskId, task.executionId, "30", "permission", { sessionId: task.sessionId, type: "permission" });
      const reply = { scopeId: "scope", taskId: task.taskId, executionId: task.executionId,
        expectedRevision: store.get("scope", task.taskId)!.revision, requestId: "30", requestRevision: request.revision,
        reply: "allow_once", authorizationBasis: "previous approval", idempotencyKey: "previous-reply-000001" };
      store.respondToRequest(reply); store.close(); store = undefined;
      const old = new DatabaseSync(file); oldRequestTable(old);
      for (const status of ["pending", "responded", "unconfirmed", "expired"]) old.prepare(
        "INSERT INTO input_requests VALUES(?,?,?,?,?,?,?,?,?)").run(status, task.executionId, "permission", 7,
        JSON.stringify({ sessionId: task.sessionId, type: "permission" }), status, "original-time", '"deny"', '"original audit"');
      if (fail === "migration") { old.exec("PRAGMA foreign_keys=OFF"); old.prepare("UPDATE input_requests SET execution_id='missing' WHERE request_id='expired'").run(); }
      const before = old.prepare("SELECT * FROM input_requests ORDER BY request_id").all();
      old.close();
      if (fail === "backup") writeFileSync(join(directory, "backups"), "blocked");
      if (fail !== "none") {
        assert.throws(() => new SqliteTaskStore(file), fail === "backup" ? /backup failed/ : /FOREIGN KEY|foreign-key validation/);
        const check = new DatabaseSync(file, { readOnly: true });
        assert.equal((check.prepare("SELECT version FROM schema_version").get() as { version: number }).version, 3);
        assert.deepEqual(check.prepare("SELECT * FROM input_requests ORDER BY request_id").all(), before);
        check.close(); return;
      }
      store = new SqliteTaskStore(file);
      assert.equal(store.findResponseByKey("scope", reply.idempotencyKey, reply)?.executionId, task.executionId);
      store.respondToRequest(reply); // Historical no-explanation hash still matches after migration.
      const backupFile = join(directory, "backups", readdirSync(join(directory, "backups"))[0]!);
      assert.equal(statSync(backupFile).mode & 0o777, 0o600);
      const backup = new DatabaseSync(backupFile, { readOnly: true });
      assert.deepEqual(backup.prepare("SELECT * FROM input_requests ORDER BY request_id").all(), before); backup.close();
      store.close(); store = undefined;
      const check = new DatabaseSync(file, { readOnly: true });
      const after = check.prepare("SELECT request_id,execution_id,kind,revision,detail_json,status,created_at,response_json,authorization_basis_json FROM input_requests ORDER BY request_id").all();
      assert.deepEqual(after, before);
      assert.deepEqual(check.prepare("PRAGMA foreign_key_check").all(), []); check.close();
      store = new SqliteTaskStore(file);
      assert.equal(readdirSync(join(directory, "backups")).length, 1);
    } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}
