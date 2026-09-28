import type { DuckDBBindings, DuckDBRuntime, Logger } from '@duckdb/duckdb-wasm/blocking';
export { VoidLogger, DuckDBAccessMode } from '@duckdb/duckdb-wasm/blocking';
export declare const DuckDB: new (logger: Logger, runtime: DuckDBRuntime, wasmURL: string) => DuckDBBindings;
