// The optional integration suite consumes a separately built browser engine.
declare module '*.duckdb/duckdb.js' {
  import type { DuckDBBindings, DuckDBRuntime, Logger } from '@duckdb/duckdb-wasm/blocking';
  export { VoidLogger, DuckDBAccessMode } from '@duckdb/duckdb-wasm/blocking';
  export const DuckDB: new (logger: Logger, runtime: DuckDBRuntime, wasmURL: string) => DuckDBBindings;
}
