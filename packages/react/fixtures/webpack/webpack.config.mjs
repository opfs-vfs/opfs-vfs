import HtmlWebpackPlugin from 'html-webpack-plugin';
import webpack from 'webpack';

const artifact = (name) => JSON.stringify(process.env[name]);
const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
export default {
  mode: 'production',
  devtool: 'source-map',
  entry: './src/index.tsx',
  output: { clean: true },
  resolve: { extensions: ['.tsx', '.ts', '.js'] },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: {
          loader: 'ts-loader',
          options: {
            transpileOnly: true,
            configFile: false,
            compilerOptions: { jsx: 'react-jsx', target: 'es2022', module: 'esnext' },
          },
        },
        exclude: /node_modules/,
      },
    ],
  },
  plugins: [
    new HtmlWebpackPlugin({ templateContent: '<div id="root"></div>' }),
    new webpack.DefinePlugin({
      __OPFS_VFS_CORE_ARTIFACT__: artifact('OPFS_VFS_CORE_ARTIFACT'),
      __OPFS_VFS_SUBSCRIPTIONS_ARTIFACT__: artifact('OPFS_VFS_SUBSCRIPTIONS_ARTIFACT'),
      __OPFS_VFS_REACT_ARTIFACT__: artifact('OPFS_VFS_REACT_ARTIFACT'),
    }),
  ],
  devServer: { headers },
};
