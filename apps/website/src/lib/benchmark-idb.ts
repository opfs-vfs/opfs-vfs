export async function deleteBenchmarkIdb(name: string) {
  const databases = await indexedDB.databases();
  for (const database of databases.filter((item) => item.name?.includes(name))) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(database.name!);
        timeout = setTimeout(() => reject(new Error('IndexedDB cleanup did not finish within 5 seconds.')), 5000);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        // Safari can emit blocked while closed connections are still being released.
        // Only success confirms deletion; the timeout bounds a genuinely blocked request.
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
