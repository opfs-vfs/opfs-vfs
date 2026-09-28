const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const result = document.querySelector('#result')!;
worker.onmessage = ({ data }) => {
  result.textContent = JSON.stringify(data, null, 2);
};
worker.onerror = (event) => {
  result.textContent = event.message;
};
worker.postMessage('open');
