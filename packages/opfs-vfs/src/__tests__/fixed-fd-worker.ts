import { OpfsVfs } from '../opfs-vfs';
import { startVfsWorker } from '../worker-runtime';

// Deterministic descriptor reuse makes takeover invalidation observable.
// oxlint-disable-next-line typescript/unbound-method -- reapplied to its original receiver below
const open = OpfsVfs.prototype.openSync;
const initialized = new WeakSet<OpfsVfs>();
OpfsVfs.prototype.openSync = function (...args) {
  if (!initialized.has(this)) {
    (this as unknown as { nextFd: number }).nextFd = 10;
    initialized.add(this);
  }
  return open.apply(this, args);
};
startVfsWorker();
