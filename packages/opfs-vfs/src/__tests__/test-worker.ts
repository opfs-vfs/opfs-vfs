import { PGlite } from '@electric-sql/pglite';
import { OpfsVfsPGliteAdapter } from '../adapter';
import { OpfsVfs } from '../opfs-vfs';
import { deleteVolume } from '../volume-files';

// Intercept console.log/warn/error in this worker to forward to main thread
// This captures PGlite's createEmscriptenFS debug logs
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;
const formatLogArgs = (args: unknown[]) =>
  args.map((arg) => (typeof arg === 'object' ? JSON.stringify(arg) : String(arg))).join(' ');
const formatError = (error: unknown) =>
  `${error instanceof Error ? error.message : typeof error === 'object' ? JSON.stringify(error) : String(error)}\n${
    error instanceof Error ? (error.stack ?? '') : ''
  }`;
console.log = (...args: unknown[]) => {
  origLog(...args);
  try {
    self.postMessage({
      type: 'LOG',
      msg: formatLogArgs(args),
    });
  } catch {}
};
console.warn = (...args: unknown[]) => {
  origWarn(...args);
  try {
    self.postMessage({
      type: 'LOG',
      msg: `[WARN] ${formatLogArgs(args)}`,
    });
  } catch {}
};
console.error = (...args: unknown[]) => {
  origError(...args);
  try {
    self.postMessage({
      type: 'LOG',
      msg: `[ERROR] ${formatLogArgs(args)}`,
    });
  } catch {}
};

self.onmessage = async (event) => {
  const { id, type, bufferMode } = event.data;
  const vfsOptions = bufferMode ? { bufferMode } : undefined;

  if (type === 'RUN_TEST') {
    let vfs: OpfsVfs | null = null;
    try {
      const fileName = `pg-worker-test-${Math.random().toString(36).substring(7)}.bin`;
      console.log('test-worker: creating OpfsVfs', fileName, bufferMode ? `(${bufferMode})` : '');
      vfs = new OpfsVfs(fileName, vfsOptions);
      await vfs.ready;
      console.log('test-worker: VFS ready');

      const adapter = new OpfsVfsPGliteAdapter(vfs, { debug: false });
      console.log('test-worker: creating PGlite');
      const startTime = performance.now();
      const pg = await PGlite.create({ fs: adapter });
      console.log('test-worker: PGlite created in', Math.round(performance.now() - startTime), 'ms');
      console.log('test-worker: PGlite created successfully');

      const queryStart = performance.now();
      await pg.exec('CREATE TABLE test (id SERIAL PRIMARY KEY, name TEXT);');
      await pg.exec("INSERT INTO test (name) VALUES ('PGLite OPFS Worker');");
      const res = await pg.query('SELECT * FROM test;');
      console.log('test-worker: queries completed in', Math.round(performance.now() - queryStart), 'ms');

      await pg.close();
      await vfs.closeVfs();
      await deleteVolume(fileName);
      self.postMessage({ id, type: 'RESULT', result: res.rows });
    } catch (error) {
      if (vfs) await vfs.closeVfs();
      console.error('test-worker FAILED:', error instanceof Error ? error.message : String(error));
      self.postMessage({ id, type: 'ERROR', result: formatError(error) });
    }
  }

  if (type === 'RUN_CRUD_TEST') {
    const fileName = `pg-crud-test-${Math.random().toString(36).substring(7)}.bin`;
    let vfs: OpfsVfs | null = null;
    try {
      vfs = new OpfsVfs(fileName, vfsOptions);
      await vfs.ready;
      const pg = await PGlite.create({ fs: new OpfsVfsPGliteAdapter(vfs) });

      // CREATE TABLE
      await pg.exec(`
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT UNIQUE,
          age INT
        );
      `);

      // INSERT multiple rows
      await pg.exec(`
        INSERT INTO users (name, email, age) VALUES
          ('Alice', 'alice@example.com', 30),
          ('Bob', 'bob@example.com', 25),
          ('Charlie', 'charlie@example.com', 35),
          ('Diana', 'diana@example.com', 28),
          ('Eve', 'eve@example.com', 22);
      `);

      // SELECT with WHERE
      const young = await pg.query<{ name: string }>('SELECT name FROM users WHERE age < 30 ORDER BY name;');

      // UPDATE
      await pg.exec("UPDATE users SET age = 31 WHERE name = 'Alice';");
      const alice = await pg.query<{ age: number }>("SELECT age FROM users WHERE name = 'Alice';");

      // DELETE
      await pg.exec("DELETE FROM users WHERE name = 'Eve';");
      const remaining = await pg.query<{ count: number }>('SELECT COUNT(*)::int as count FROM users;');

      await pg.close();
      await vfs.closeVfs();
      await deleteVolume(fileName);
      self.postMessage({
        id,
        type: 'RESULT',
        result: {
          youngUsers: young.rows.map((r) => r.name),
          aliceAge: alice.rows[0]!.age,
          remainingCount: remaining.rows[0]!.count,
        },
      });
    } catch (error) {
      if (vfs) await vfs.closeVfs();
      self.postMessage({ id, type: 'ERROR', result: formatError(error) });
    }
  }

  if (type === 'RUN_SCHEMA_TEST') {
    const fileName = `pg-schema-test-${Math.random().toString(36).substring(7)}.bin`;
    let vfs: OpfsVfs | null = null;
    try {
      vfs = new OpfsVfs(fileName, vfsOptions);
      await vfs.ready;
      const pg = await PGlite.create({ fs: new OpfsVfsPGliteAdapter(vfs) });

      // Multiple tables with foreign keys and indexes
      await pg.exec(`
        CREATE TABLE departments (
          id SERIAL PRIMARY KEY,
          name TEXT UNIQUE NOT NULL
        );
        CREATE TABLE employees (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          department_id INT REFERENCES departments(id),
          salary NUMERIC(10,2)
        );
        CREATE TABLE projects (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          lead_id INT REFERENCES employees(id)
        );
        CREATE TABLE assignments (
          employee_id INT REFERENCES employees(id),
          project_id INT REFERENCES projects(id),
          role TEXT,
          PRIMARY KEY (employee_id, project_id)
        );
        CREATE INDEX idx_emp_dept ON employees(department_id);
        CREATE INDEX idx_emp_salary ON employees(salary);
        CREATE INDEX idx_proj_lead ON projects(lead_id);
        CREATE INDEX idx_assign_proj ON assignments(project_id);
      `);

      // Seed data
      await pg.exec(`
        INSERT INTO departments (name) VALUES ('Engineering'), ('Sales'), ('HR');
        INSERT INTO employees (name, department_id, salary) VALUES
          ('Alice', 1, 120000), ('Bob', 1, 95000), ('Charlie', 2, 80000),
          ('Diana', 3, 90000), ('Eve', 1, 110000);
        INSERT INTO projects (name, lead_id) VALUES ('Alpha', 1), ('Beta', 5), ('Gamma', 3);
        INSERT INTO assignments (employee_id, project_id, role) VALUES
          (1, 1, 'lead'), (2, 1, 'dev'), (5, 1, 'dev'),
          (5, 2, 'lead'), (1, 2, 'advisor'),
          (3, 3, 'lead'), (4, 3, 'coordinator');
      `);

      // Complex join query using indexes
      const result = await pg.query(`
        SELECT d.name as dept, COUNT(e.id)::int as emp_count, AVG(e.salary)::numeric(10,2) as avg_salary
        FROM departments d
        JOIN employees e ON e.department_id = d.id
        GROUP BY d.name
        ORDER BY d.name;
      `);

      // Query using assignments (composite PK + FK)
      const assignments = await pg.query(`
        SELECT e.name as employee, p.name as project, a.role
        FROM assignments a
        JOIN employees e ON e.id = a.employee_id
        JOIN projects p ON p.id = a.project_id
        ORDER BY p.name, e.name;
      `);

      // Count tables to verify schema
      const tableCount = await pg.query<{ count: number }>(`
        SELECT COUNT(*)::int as count FROM information_schema.tables
        WHERE table_schema = 'public';
      `);

      await pg.close();
      await vfs.closeVfs();
      await deleteVolume(fileName);
      self.postMessage({
        id,
        type: 'RESULT',
        result: {
          departments: result.rows,
          assignmentCount: assignments.rows.length,
          tableCount: tableCount.rows[0]!.count,
        },
      });
    } catch (error) {
      if (vfs) await vfs.closeVfs();
      self.postMessage({ id, type: 'ERROR', result: formatError(error) });
    }
  }

  if (type === 'RUN_VOLUME_TEST') {
    const fileName = `pg-volume-test-${Math.random().toString(36).substring(7)}.bin`;
    let vfs: OpfsVfs | null = null;
    try {
      vfs = new OpfsVfs(fileName, vfsOptions);
      await vfs.ready;
      const pg = await PGlite.create({ fs: new OpfsVfsPGliteAdapter(vfs) });

      await pg.exec(`
        CREATE TABLE items (
          id SERIAL PRIMARY KEY,
          payload TEXT NOT NULL,
          value INT NOT NULL
        );
      `);

      // Insert 1,000 rows in batches of 100
      const insertStart = performance.now();
      for (let batch = 0; batch < 10; batch++) {
        const values: string[] = [];
        for (let i = 0; i < 100; i++) {
          const idx = batch * 100 + i;
          const payload = `item-${idx}-${'x'.repeat(50 + (idx % 200))}`;
          values.push(`('${payload}', ${idx})`);
        }
        await pg.exec(`INSERT INTO items (payload, value) VALUES ${values.join(',')};`);
      }
      const insertMs = Math.round(performance.now() - insertStart);
      console.log('volume-test: 1000 rows inserted in', insertMs, 'ms');

      // Verify count
      const count = await pg.query<{ count: number }>('SELECT COUNT(*)::int as count FROM items;');

      // Verify specific rows
      const first = await pg.query<{ payload: string; value: number }>(
        'SELECT payload, value FROM items WHERE value = 0;',
      );
      const last = await pg.query<{ payload: string; value: number }>(
        'SELECT payload, value FROM items WHERE value = 999;',
      );

      // Aggregate query
      const agg = await pg.query<{ total: number; avg: number }>(
        'SELECT SUM(value)::int as total, AVG(value)::int as avg FROM items;',
      );

      await pg.close();
      await vfs.closeVfs();
      await deleteVolume(fileName);
      self.postMessage({
        id,
        type: 'RESULT',
        result: {
          count: count.rows[0]!.count,
          firstPayload: first.rows[0]!.payload,
          lastValue: last.rows[0]!.value,
          sumTotal: agg.rows[0]!.total,
          insertMs,
        },
      });
    } catch (error) {
      if (vfs) await vfs.closeVfs();
      self.postMessage({ id, type: 'ERROR', result: formatError(error) });
    }
  }

  if (type === 'RUN_TRANSACTION_TEST') {
    const fileName = `pg-tx-test-${Math.random().toString(36).substring(7)}.bin`;
    let vfs: OpfsVfs | null = null;
    try {
      vfs = new OpfsVfs(fileName, vfsOptions);
      await vfs.ready;
      const pg = await PGlite.create({ fs: new OpfsVfsPGliteAdapter(vfs) });

      await pg.exec('CREATE TABLE accounts (id SERIAL PRIMARY KEY, balance INT NOT NULL);');
      await pg.exec('INSERT INTO accounts (balance) VALUES (1000), (500);');

      // Successful transaction: transfer
      await pg.transaction(async (tx) => {
        await tx.exec('UPDATE accounts SET balance = balance - 200 WHERE id = 1;');
        await tx.exec('UPDATE accounts SET balance = balance + 200 WHERE id = 2;');
      });
      const afterTransfer = await pg.query('SELECT id, balance FROM accounts ORDER BY id;');

      // Rolled-back transaction
      let rollbackError = '';
      try {
        await pg.transaction(async (tx) => {
          await tx.exec('UPDATE accounts SET balance = balance - 9999 WHERE id = 1;');
          throw new Error('forced rollback');
        });
      } catch (error) {
        rollbackError = error instanceof Error ? error.message : String(error);
      }
      const afterRollback = await pg.query('SELECT id, balance FROM accounts ORDER BY id;');

      await pg.close();
      await vfs.closeVfs();
      await deleteVolume(fileName);
      self.postMessage({
        id,
        type: 'RESULT',
        result: {
          afterTransfer: afterTransfer.rows,
          rollbackError,
          afterRollback: afterRollback.rows,
        },
      });
    } catch (error) {
      if (vfs) await vfs.closeVfs();
      self.postMessage({ id, type: 'ERROR', result: formatError(error) });
    }
  }

  if (type === 'RUN_WARM_START_TEST') {
    const fileName = `pg-warm-test-${Math.random().toString(36).substring(7)}.bin`;
    let vfs: OpfsVfs | null = null;
    try {
      // --- Cold start: initdb + seed data ---
      console.log('warm-test: COLD START');
      vfs = new OpfsVfs(fileName, vfsOptions);
      await vfs.ready;

      const coldStart = performance.now();
      const pg1 = await PGlite.create({ fs: new OpfsVfsPGliteAdapter(vfs, { debug: false }) });
      const coldInitMs = Math.round(performance.now() - coldStart);
      console.log('warm-test: cold init took', coldInitMs, 'ms');

      await pg1.exec('CREATE TABLE warmtest (id SERIAL PRIMARY KEY, value TEXT);');
      await pg1.exec("INSERT INTO warmtest (value) VALUES ('row1'), ('row2'), ('row3');");
      const coldRows = await pg1.query('SELECT * FROM warmtest ORDER BY id;');
      console.log('warm-test: cold query returned', coldRows.rows.length, 'rows');

      await pg1.close();
      await vfs.closeVfs();
      vfs = null;
      console.log('warm-test: VFS closed after cold start');

      // --- Warm start: reopen same files, no initdb ---
      console.log('warm-test: WARM START');
      vfs = new OpfsVfs(fileName, vfsOptions);
      await vfs.ready;

      const warmStart = performance.now();
      const pg2 = await PGlite.create({ fs: new OpfsVfsPGliteAdapter(vfs, { debug: false }) });
      const warmInitMs = Math.round(performance.now() - warmStart);
      console.log('warm-test: warm init took', warmInitMs, 'ms');

      // Verify data persisted
      const warmRows = await pg2.query('SELECT * FROM warmtest ORDER BY id;');
      console.log('warm-test: warm query returned', warmRows.rows.length, 'rows');

      // Insert more data to verify DB is fully operational
      await pg2.exec("INSERT INTO warmtest (value) VALUES ('row4');");
      const allRows = await pg2.query('SELECT * FROM warmtest ORDER BY id;');

      await pg2.close();
      await vfs.closeVfs();
      await deleteVolume(fileName);

      self.postMessage({
        id,
        type: 'RESULT',
        result: {
          coldInitMs,
          warmInitMs,
          coldRowCount: coldRows.rows.length,
          warmRowCount: warmRows.rows.length,
          totalRowCount: allRows.rows.length,
          warmRows: warmRows.rows,
          allRows: allRows.rows,
        },
      });
    } catch (error) {
      if (vfs) await vfs.closeVfs();
      console.error('warm-test FAILED:', error instanceof Error ? error.message : String(error));
      self.postMessage({ id, type: 'ERROR', result: formatError(error) });
    }
  }
};
