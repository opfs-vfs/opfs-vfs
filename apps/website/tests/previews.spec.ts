import { expect, test, type Page } from '@playwright/test';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { choose, continueDialog } from './ui';

const route = '/demos/filesystem/';
const unique = () => `previews-${Date.now().toString(36)}`;

async function ready(page: Page) {
  await page.goto(route);
  await expect(page.getByRole('combobox', { name: 'Volume', exact: true })).toBeVisible({ timeout: 30_000 });
}

async function command(page: Page, value: string) {
  await page.getByLabel('Shell command').fill(value);
  await page.getByLabel('Shell command').press('Enter');
  await expect(page.locator('.filesystem-demo')).toHaveAttribute('aria-busy', 'false');
}

function pdfFixture() {
  const stream = 'BT /F1 24 Tf 72 720 Td (PDF preview works) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n `)
    .join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

async function docxFixture() {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    'word/document.xml',
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX preview works</w:t></w:r></w:p></w:body></w:document>',
  );
  return Buffer.from(await zip.generateAsync({ type: 'uint8array' }));
}

test('previews real PNG, PDF, DOCX, XLSX, Markdown, and sandboxed HTML', async ({ page }, testInfo) => {
  await ready(page);
  const name = unique();
  await page.getByLabel('New volume name').fill(name);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Volume', exact: true })).toContainText(name);
  await expect(page.getByRole('combobox', { name: 'Volume', exact: true })).toBeEnabled();
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Spreadsheet preview works']]), 'Sheet 1');
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.locator('input[type=file][multiple]').setInputFiles([
    {
      name: 'pixel.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    },
    { name: 'sample.pdf', mimeType: 'application/pdf', buffer: pdfFixture() },
    {
      name: 'sample.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: await docxFixture(),
    },
    {
      name: 'sample.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from(XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' })),
    },
    {
      name: 'sample.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Markdown preview works\n\n![remote](https://preview-probe.invalid/image.png)'),
    },
    {
      name: 'sample.html',
      mimeType: 'text/html',
      buffer: Buffer.from(
        '<h1>HTML preview works</h1><img src="https://preview-probe.invalid/image.png"><script>parent.postMessage("unsafe", "*")</script>',
      ),
    },
  ]);
  await expect(page.getByRole('treeitem', { name: /pixel\.png/ })).toBeVisible();

  const pixel = page.getByRole('treeitem', { name: /pixel\.png/ });
  await pixel.click();
  await expect(page.locator('.fp-image img')).toBeVisible();
  await expect
    .poll(() => page.locator('.fp-image img').evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(1);
  await pixel.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Persistent workspace' })).toBeVisible();

  await page.getByRole('treeitem', { name: /sample\.pdf/ }).click();
  const pdf = page.getByLabel('/workspace/sample.pdf, page 1');
  await expect(pdf).toBeVisible();
  await expect(pdf).toHaveAttribute('data-rendered', 'true');
  await pdf.screenshot({ path: testInfo.outputPath('pdf-preview.png') });

  await page.getByRole('treeitem', { name: /sample\.docx/ }).click();
  const docx = page.locator('iframe[title="sample.docx"]');
  await expect(docx).toHaveAttribute('srcdoc', /DOCX preview works/);

  await page.getByRole('treeitem', { name: /sample\.xlsx/ }).click();
  await expect(page.locator('.sheet-preview')).toContainText('Spreadsheet preview works');

  await page.getByRole('treeitem', { name: /sample\.md/ }).click();
  await expect(page.getByRole('heading', { name: 'Markdown preview works' })).toBeVisible();
  await expect(page.locator('.markdown-preview')).toContainText('[image: remote]');

  await page.getByRole('treeitem', { name: /sample\.html/ }).click();
  const html = page.locator('iframe[title="sample.html"]');
  await expect(html).toHaveAttribute('sandbox', '');
  await expect(html).toHaveAttribute('srcdoc', /default-src 'none'/);
  await page.waitForTimeout(250);
  expect(requests.some((url) => url.includes('preview-probe.invalid'))).toBe(false);
  await page.screenshot({ fullPage: true, path: testInfo.outputPath('previews-page.png') });
});

test('dirty editor survives cross-tab refresh and reset succeeds after the peer closes', async ({ browser }) => {
  const context = await browser.newContext();
  const first = await context.newPage();
  await ready(first);
  const name = unique();
  await first.getByLabel('New volume name').fill(name);
  await first.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(first.getByRole('combobox', { name: 'Volume', exact: true })).toContainText(name);
  const second = await context.newPage();
  await ready(second);
  await choose(second, 'Volume', name);
  await first.getByRole('treeitem', { name: /README\.md/ }).click();
  await first.getByRole('button', { name: 'Source', exact: true }).click();
  await first.getByLabel('Edit README.md').fill('# Unsaved draft survives');
  await first.getByRole('treeitem', { name: /notes\.txt/ }).click();
  const dirtyDialog = first.getByRole('dialog');
  await expect(dirtyDialog.getByRole('heading', { name: 'Discard unsaved preview changes?' })).toBeVisible();
  const cancel = dirtyDialog.getByRole('button', { name: 'Cancel', exact: true });
  await expect(cancel).toBeFocused();
  await cancel.click();
  await expect(first.getByRole('treeitem', { name: /notes\.txt/ })).toBeFocused();
  await expect(first.getByRole('treeitem', { name: /README\.md/ })).toHaveAttribute('aria-selected', 'true');
  await expect(first.getByLabel('Edit README.md')).toHaveText('# Unsaved draft survives');
  const rename = first.getByRole('button', { name: 'Rename', exact: true });
  await rename.click();
  await expect(first.getByRole('textbox', { name: 'Rename to', exact: true })).toBeFocused();
  await first.keyboard.press('Escape');
  await expect(rename).toBeFocused();
  await command(second, "printf 'peer write' > peer.txt");
  await expect(first.getByRole('treeitem', { name: /peer\.txt/ })).toBeVisible();
  await expect(first.getByLabel('Edit README.md')).toHaveText('# Unsaved draft survives');
  await second.close();
  await first.getByRole('button', { name: 'Reset', exact: true }).click();
  await continueDialog(first);
  await expect(first.getByRole('combobox', { name: 'Volume', exact: true })).toContainText(name);
  await expect(first.getByRole('treeitem', { name: /peer\.txt/ })).toHaveCount(0);
  await first.getByRole('treeitem', { name: /README\.md/ }).click();
  await expect(first.getByRole('heading', { name: 'Persistent workspace' })).toBeVisible();
  await context.close();
});

test('mobile workspace switches between Files, Shell, and Preview', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  await expect(page.getByRole('button', { name: 'Files', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Shell', exact: true }).click();
  await expect(page.locator('.shell-panel')).toBeVisible();
  await expect(page.locator('.explorer-panel')).toBeHidden();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('treeitem', { name: /notes\.txt/ }).click();
  await expect(page.getByRole('button', { name: 'Preview', exact: true }).first()).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('.preview-panel')).toBeVisible();
});
