const headers = [
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
];
export default {
  productionBrowserSourceMaps: true,
  async headers() {
    return [{ source: '/:path*', headers }];
  },
};
