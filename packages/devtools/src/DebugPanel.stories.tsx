import { LiveDemo } from './LiveDemo';
import { fixtures } from './mock-fixtures';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { DebugPanel } from './DebugPanel';

const meta = {
  title: 'Developer tools/OPFS VFS Volume Explorer',
  component: DebugPanel,
  args: { initialVolumes: fixtures() },
  parameters: { layout: 'fullscreen' },
  argTypes: {
    initialDock: { control: 'select', options: ['floating', 'left', 'right', 'top', 'bottom'] },
    initialTheme: { control: 'select', options: ['dark', 'light'] },
    initialScenario: { control: 'select', options: ['normal', 'empty', 'disconnected'] },
  },
  render: (args) => <DebugPanel key={JSON.stringify(args)} {...args} />,
} satisfies Meta<typeof DebugPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Launcher: Story = { args: { initialOpen: false } };
export const Floating: Story = { args: { initialOpen: true } };
export const DockedBottom: Story = { args: { initialOpen: true, initialDock: 'bottom' } };
export const DockedLeft: Story = { args: { initialOpen: true, initialDock: 'left' } };
export const DockedRight: Story = { args: { initialOpen: true, initialDock: 'right' } };
export const DockedTop: Story = { args: { initialOpen: true, initialDock: 'top' } };
export const LightTheme: Story = { args: { initialOpen: true, initialTheme: 'light' } };
export const EmptyDiscovery: Story = { args: { initialOpen: true, initialScenario: 'empty' } };
export const OwnerDisconnected: Story = { args: { initialOpen: true, initialScenario: 'disconnected' } };

export const LargeTextEditor: Story = {
  args: { initialOpen: true, initialPath: '/logs/large.log', initialSource: true },
};
export const ImagePreview: Story = { args: { initialOpen: true, initialPath: '/public/checker.png' } };
export const SvgPreview: Story = { args: { initialOpen: true, initialPath: '/public/logo.svg' } };
export const PdfPreview: Story = { args: { initialOpen: true, initialPath: '/docs/guide.pdf' } };
export const CustomPreview: Story = {
  args: {
    initialOpen: true,
    initialPath: '/design/theme.palette',
    previewExtensions: [
      {
        id: 'palette',
        matches: (path) => path.endsWith('.palette'),
        load: () => import('./PalettePreview.example'),
      },
    ],
  },
};

export const RealStorage: Story = {
  render: () => <LiveDemo />,
};
