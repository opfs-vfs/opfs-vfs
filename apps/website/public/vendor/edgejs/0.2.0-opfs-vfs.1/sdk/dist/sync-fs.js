import { registerFileSystemRpcHandler } from "./host-filesystem.js";
const HEADER_BYTES = 16;
// ponytail: directory listings cap at 4 MiB; paginate the contract if needed.
const PAYLOAD_BYTES = 4 * 1024 * 1024;
const IO_BYTES = 64 * 1024;
const WAIT_MS = 30_000;
const bridges = new Map();
let nextBridge = 1;
function failure(message, code = "EIO") {
    return Object.assign(new Error(message), { code });
}
function errorInfo(error) {
    try {
        const value = error;
        return {
            message: typeof value?.message === "string" ? value.message : String(error),
            code: typeof value?.code === "string" && /^E[A-Z0-9]{1,63}$/.test(value.code) ? value.code : "EIO",
        };
    }
    catch {
        return { message: "filesystem callback failed", code: "EIO" };
    }
}
function integer(value, maximum = Number.MAX_SAFE_INTEGER) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
        throw failure("invalid filesystem integer", "EINVAL");
    }
    return value;
}
function path(value) {
    if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0") || value.split("/").includes("..")) {
        throw failure("invalid filesystem path", "EINVAL");
    }
    return value;
}
function metadata(value) {
    const result = value;
    if (!result || (result.kind !== "file" && result.kind !== "directory"))
        throw failure("invalid filesystem metadata");
    integer(result.size);
    for (const time of [result.accessed, result.modified, result.created]) {
        if (time !== undefined)
            integer(time);
    }
    return result;
}
function synchronous(value) {
    if (value !== null && (typeof value === "object" || typeof value === "function") && "then" in value && typeof value.then === "function") {
        void Promise.resolve(value).catch(() => undefined);
        throw failure("filesystem callbacks must be synchronous");
    }
    return value;
}
export function registerSyncFileSystem(fs) {
    if (!fs || typeof fs !== "object")
        throw new TypeError("sync mount requires a filesystem");
    const id = nextBridge++;
    bridges.set(id, { fs, descriptors: new Set(), failed: false, busy: false });
    const scope = globalThis;
    scope.__wasmerSyncFsCall = callOwner;
    registerFileSystemRpcHandler("sync", handleRpc);
    return id;
}
/** Call only after guest execution has stopped. Attempts every leaked close. */
export function unregisterSyncFileSystems(ids) {
    const errors = [];
    for (const id of ids) {
        const bridge = bridges.get(id);
        if (!bridge)
            continue;
        bridges.delete(id);
        for (const fd of bridge.descriptors) {
            try {
                synchronous(bridge.fs.close(fd));
            }
            catch (error) {
                errors.push(error);
            }
        }
    }
    if (errors.length)
        throw new AggregateError(errors, "failed to close mounted filesystem descriptors");
}
function callOwner(id, method, args) {
    const bridge = bridges.get(integer(id));
    if (!bridge)
        throw failure("filesystem bridge is closed", "EBADF");
    if (bridge.failed)
        throw failure("filesystem bridge failed; operation outcome may be uncertain", "EIO");
    if (bridge.busy)
        throw failure("filesystem callback reentered its bridge", "EDEADLK");
    if (!Array.isArray(args))
        throw failure("invalid filesystem arguments", "EINVAL");
    const fs = bridge.fs;
    const fd = () => {
        const descriptor = integer(args[0]);
        if (!bridge.descriptors.has(descriptor))
            throw failure("unknown filesystem descriptor", "EBADF");
        return descriptor;
    };
    const invoke = (work) => {
        const value = work();
        try {
            return synchronous(value);
        }
        catch (error) {
            bridge.failed = true;
            throw error;
        }
    };
    bridge.busy = true;
    try {
        switch (method) {
            case "metadata": return metadata(invoke(() => fs.metadata(path(args[0]))));
            case "readDir": {
                const entries = invoke(() => fs.readDir(path(args[0])));
                if (!Array.isArray(entries))
                    throw failure("invalid filesystem directory listing");
                for (const entry of entries) {
                    metadata(entry);
                    if (typeof entry.name !== "string" || !entry.name || entry.name === "." || entry.name === ".." || /[/\0]/.test(entry.name))
                        throw failure("invalid filesystem directory entry");
                }
                return entries;
            }
            case "createDir": return invoke(() => fs.createDir(path(args[0])));
            case "removeDir": return invoke(() => fs.removeDir(path(args[0])));
            case "removeFile": return invoke(() => fs.removeFile(path(args[0])));
            case "rename": return invoke(() => fs.rename(path(args[0]), path(args[1])));
            case "open": {
                const options = args[1];
                if (!options || ["read", "write", "append", "truncate", "create", "createNew"].some(key => typeof options[key] !== "boolean"))
                    throw failure("invalid filesystem open options", "EINVAL");
                const descriptor = integer(invoke(() => fs.open(path(args[0]), options)));
                if (bridge.descriptors.has(descriptor))
                    throw failure("filesystem reused an open descriptor");
                bridge.descriptors.add(descriptor);
                return descriptor;
            }
            case "read": {
                const length = integer(args[1], IO_BYTES);
                const bytes = invoke(() => fs.read(fd(), length));
                if (!(bytes instanceof Uint8Array) || bytes.byteLength > length)
                    throw failure("invalid filesystem read result");
                return bytes;
            }
            case "write": {
                const bytes = args[1];
                if (!(bytes instanceof Uint8Array) || bytes.byteLength > IO_BYTES)
                    throw failure("invalid filesystem write", "EINVAL");
                return integer(invoke(() => fs.write(fd(), bytes)), bytes.byteLength);
            }
            case "seek": {
                const offset = args[1];
                const whence = integer(args[2], 2);
                if (typeof offset !== "number" || !Number.isSafeInteger(offset))
                    throw failure("invalid filesystem offset", "EINVAL");
                return integer(invoke(() => fs.seek(fd(), offset, whence)));
            }
            case "unlink": return invoke(() => fs.unlink(fd()));
            case "fstat": return metadata(invoke(() => fs.fstat(fd())));
            case "setLen": return invoke(() => fs.setLen(fd(), integer(args[1])));
            case "flush": return invoke(() => fs.flush(fd()));
            case "close": {
                const descriptor = fd();
                invoke(() => fs.close(descriptor));
                bridge.descriptors.delete(descriptor);
                return undefined;
            }
            default: throw failure(`unsupported filesystem operation ${method}`, "ENOSYS");
        }
    }
    finally {
        bridge.busy = false;
    }
}
function handleRpc(value) {
    if (!value || typeof value !== "object" || !("type" in value))
        return false;
    const request = value;
    if (request.type === "wasmer-fs-failed") {
        const bridge = bridges.get(request.bridgeId);
        if (bridge)
            bridge.failed = true;
        return true;
    }
    if (request.type !== "wasmer-fs-rpc")
        return false;
    // Recognized malformed messages must not reach Rust's other handlers.
    if (!(request.response instanceof SharedArrayBuffer) || request.response.byteLength !== HEADER_BYTES + PAYLOAD_BYTES)
        return true;
    const control = new Int32Array(request.response, 0, 4);
    if (Atomics.compareExchange(control, 0, 0, 1) !== 0)
        return true;
    let kind;
    let bytes;
    try {
        const result = callOwner(request.bridgeId, request.method, request.args);
        kind = result instanceof Uint8Array ? 2 : result === undefined ? 3 : 1;
        bytes = result instanceof Uint8Array ? result : new TextEncoder().encode(JSON.stringify(result) ?? "");
        if (bytes.length > PAYLOAD_BYTES)
            throw failure("filesystem response exceeds 4 MiB", "EOVERFLOW");
    }
    catch (error) {
        kind = 4;
        const info = errorInfo(error);
        info.message = info.message.slice(0, 4096);
        bytes = new TextEncoder().encode(JSON.stringify(info));
    }
    new Uint8Array(request.response, HEADER_BYTES, bytes.length).set(bytes);
    Atomics.store(control, 1, kind);
    Atomics.store(control, 2, bytes.length);
    // Completion and timeout compete for running -> done/cancelled. If timeout
    // wins, disable this registry entry before handling any later operation.
    if (Atomics.compareExchange(control, 0, 1, 2) === 3) {
        const bridge = bridges.get(request.bridgeId);
        if (bridge)
            bridge.failed = true;
    }
    Atomics.notify(control, 0);
    return true;
}
/** Install before wasm initialization in each guest worker. */
export function installSyncFsWorker() {
    registerFileSystemRpcHandler("sync", (value) => {
        const type = value?.type;
        if (type !== "wasmer-fs-rpc" && type !== "wasmer-fs-failed")
            return false;
        globalThis.postMessage(value);
        return true;
    });
    const failed = new Set();
    globalThis.__wasmerSyncFsCall = (bridgeId, method, args) => {
        if (failed.has(bridgeId))
            throw failure("filesystem bridge failed", "EIO");
        if (method === "read")
            integer(args[1], IO_BYTES);
        if (method === "write" && (!(args[1] instanceof Uint8Array) || args[1].byteLength > IO_BYTES))
            throw failure("invalid filesystem write", "EINVAL");
        const response = new SharedArrayBuffer(HEADER_BYTES + PAYLOAD_BYTES);
        const control = new Int32Array(response, 0, 4);
        globalThis.postMessage({ type: "wasmer-fs-rpc", bridgeId, method, args, response });
        const deadline = performance.now() + WAIT_MS;
        while (Atomics.load(control, 0) !== 2) {
            const remaining = deadline - performance.now();
            if (remaining <= 0) {
                let state = Atomics.compareExchange(control, 0, 0, 3);
                if (state === 1)
                    state = Atomics.compareExchange(control, 0, 1, 3);
                if (state === 2)
                    break;
                if (state === 1) {
                    // Owner may have changed the filesystem. Never retry this operation.
                    failed.add(bridgeId);
                    globalThis.postMessage({ type: "wasmer-fs-failed", bridgeId });
                }
                throw failure(state === 1 ? "filesystem callback timed out; outcome uncertain, bridge disabled" : "filesystem request timed out before execution", "ETIMEDOUT");
            }
            const state = Atomics.load(control, 0);
            if (state !== 2)
                Atomics.wait(control, 0, state, remaining);
        }
        const length = integer(Atomics.load(control, 2), PAYLOAD_BYTES);
        const bytes = new Uint8Array(response, HEADER_BYTES, length).slice();
        switch (Atomics.load(control, 1)) {
            case 1: return JSON.parse(new TextDecoder().decode(bytes));
            case 2: return bytes;
            case 3: return undefined;
            case 4: {
                const error = errorInfo(JSON.parse(new TextDecoder().decode(bytes)));
                throw failure(error.message, error.code);
            }
            default: throw failure("invalid filesystem response");
        }
    };
}
//# sourceMappingURL=sync-fs.js.map